import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AuthenticationError,
  NotEnoughSpaceError,
  NotFoundError,
  SandboxError,
  TimeoutError,
  type EntryInfo,
} from "@e2b/code-interpreter";

import {
  executeCreateOrUpdateFilesTool,
  type CreateOrUpdateFilesStepResult,
  type FilesSandbox,
} from "./files";
import {
  buildAgentSystemPrompt,
  executeRestoreProjectFiles,
  loadProjectFileSnapshot,
  parseFileSnapshot,
  reconcileFileWriteErrors,
  reconcileTerminalRecovery,
  reconstructProjectFiles,
  RESTORE_BATCH_SIZE,
  restoreFilesToSandbox,
  shouldPersistFragment,
  type FragmentQueryClient,
  type RestoreFilesResult,
  type RestoreSandbox,
  type RestoreWriteEntry,
} from "./restore";

function makeEntryInfos(entries: RestoreWriteEntry[]): EntryInfo[] {
  return entries.map((e) => ({
    name: e.path.split("/").pop() || e.path,
    path: e.path,
  })) as EntryInfo[];
}

function createMockRestoreSandbox(
  batches: RestoreWriteEntry[][] = [],
  onBatch?: (entries: RestoreWriteEntry[], batchIndex: number) => Promise<void> | void
): RestoreSandbox {
  return {
    files: {
      write: async (entries: RestoreWriteEntry[]) => {
        const index = batches.length;
        if (onBatch) {
          await onBatch(entries, index);
        }
        batches.push(entries.map((e) => ({ ...e })));
        return makeEntryInfos(entries);
      },
    },
  };
}

describe("parseFileSnapshot", () => {
  it("parses and normalizes valid snapshots while preserving empty file contents", () => {
    const parsed = parseFileSnapshot({
      "./app\\page.tsx": "export default function Page() { return <main />; }",
      "components/empty.ts": "",
      "lib/utils.ts": "export const x = 1;",
    });

    assert.equal(parsed.isValidObject, true);
    assert.deepEqual(parsed.invalidEntries, []);
    assert.deepEqual(parsed.files, {
      "app/page.tsx": "export default function Page() { return <main />; }",
      "components/empty.ts": "",
      "lib/utils.ts": "export const x = 1;",
    });
  });

  it("handles non-object and empty snapshots safely", () => {
    for (const invalid of [null, undefined, "string", 123, ["app/page.tsx"]]) {
      const parsed = parseFileSnapshot(invalid);
      assert.equal(parsed.isValidObject, false);
      assert.deepEqual(parsed.files, {});
      assert.deepEqual(parsed.invalidEntries, []);
    }

    const empty = parseFileSnapshot({});
    assert.equal(empty.isValidObject, true);
    assert.deepEqual(empty.files, {});
    assert.deepEqual(empty.invalidEntries, []);
  });

  it("filters and reports invalid paths and non-string contents while keeping valid files", () => {
    const parsed = parseFileSnapshot({
      "app/page.tsx": "valid page",
      "/home/user/app/bad.tsx": "absolute path",
      "../escape.ts": "traversal",
      "package.json": "{}",
      "lib/corrupt.ts": 42,
      "lib/null-content.ts": null,
    });

    assert.equal(parsed.isValidObject, true);
    assert.deepEqual(parsed.files, {
      "app/page.tsx": "valid page",
    });
    assert.equal(parsed.invalidEntries.length, 5);
    assert.deepEqual(
      parsed.invalidEntries.map((e) => e.path),
      [
        "/home/user/app/bad.tsx",
        "../escape.ts",
        "package.json",
        "lib/corrupt.ts",
        "lib/null-content.ts",
      ]
    );
  });
});

describe("reconstructProjectFiles & loadProjectFileSnapshot", () => {
  it("reconstructs legacy delta-only fragments oldest-to-newest with later versions overriding earlier ones", () => {
    const reconstructed = reconstructProjectFiles([
      {
        id: "frag-1",
        files: {
          "app/page.tsx": "page v1",
          "components/header.tsx": "header v1",
          "components/empty.ts": "",
        },
      },
      {
        id: "frag-2",
        files: {
          "app/page.tsx": "page v2",
          "components/footer.tsx": "footer v2",
        },
      },
      {
        id: "frag-3",
        files: {
          "components/header.tsx": "header v3",
          "/home/user/legacy-bad.ts": "invalid legacy path",
        },
      },
    ]);

    assert.equal(reconstructed.fragmentCount, 3);
    assert.equal(reconstructed.latestFragmentId, "frag-3");
    assert.deepEqual(reconstructed.files, {
      "app/page.tsx": "page v2",
      "components/header.tsx": "header v3",
      "components/empty.ts": "",
      "components/footer.tsx": "footer v2",
    });
    assert.equal(reconstructed.invalidHistoricalEntries.length, 1);
    assert.equal(reconstructed.invalidHistoricalEntries[0].fragmentId, "frag-3");
    assert.equal(reconstructed.invalidHistoricalEntries[0].path, "/home/user/legacy-bad.ts");
  });

  it("reports non-object historical fragment payloads without aborting reconstruction of valid fragments", () => {
    const reconstructed = reconstructProjectFiles([
      { id: "frag-1", files: { "app/page.tsx": "v1" } },
      { id: "frag-corrupt", files: null },
      { id: "frag-3", files: { "components/nav.tsx": "nav" } },
    ]);

    assert.deepEqual(reconstructed.files, {
      "app/page.tsx": "v1",
      "components/nav.tsx": "nav",
    });
    assert.equal(reconstructed.invalidHistoricalEntries.length, 1);
    assert.equal(reconstructed.invalidHistoricalEntries[0].fragmentId, "frag-corrupt");
    assert.equal(reconstructed.invalidHistoricalEntries[0].path, "<snapshot>");
  });

  it("queries only ASSISTANT + RESULT fragments in deterministic ascending order", async () => {
    let capturedArgs: unknown;
    const mockDb: FragmentQueryClient = {
      fragment: {
        findMany: async (args) => {
          capturedArgs = args;
          return [
            { id: "f1", files: { "app/page.tsx": "v1", "lib/a.ts": "a" } },
            { id: "f2", files: { "app/page.tsx": "v2" } },
          ];
        },
      },
    };

    const snapshot = await loadProjectFileSnapshot(mockDb, "proj_123");

    assert.deepEqual(capturedArgs, {
      where: {
        message: {
          projectId: "proj_123",
          role: "ASSISTANT",
          type: "RESULT",
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        files: true,
      },
    });
    assert.deepEqual(snapshot.files, {
      "app/page.tsx": "v2",
      "lib/a.ts": "a",
    });
    assert.equal(snapshot.latestFragmentId, "f2");
  });

  it("returns empty snapshot for brand-new projects with no historical fragments", async () => {
    const mockDb: FragmentQueryClient = {
      fragment: {
        findMany: async () => [],
      },
    };

    const snapshot = await loadProjectFileSnapshot(mockDb, "proj_new");

    assert.deepEqual(snapshot, {
      files: {},
      fragmentCount: 0,
      latestFragmentId: null,
      invalidHistoricalEntries: [],
    });
  });

  it("propagates database query failures instead of silently falling back to an empty project", async () => {
    const mockDb: FragmentQueryClient = {
      fragment: {
        findMany: async () => {
          throw new Error("Connection terminated unexpectedly");
        },
      },
    };

    await assert.rejects(
      () => loadProjectFileSnapshot(mockDb, "proj_123"),
      /Connection terminated unexpectedly/
    );
  });
});

describe("restoreFilesToSandbox", () => {
  it("performs zero E2B calls for an empty snapshot", async () => {
    const batches: RestoreWriteEntry[][] = [];
    const sandbox = createMockRestoreSandbox(batches);

    const result = await restoreFilesToSandbox(sandbox, {});

    assert.equal(batches.length, 0);
    assert.deepEqual(result, {
      ok: true,
      restoredFiles: [],
      failedFiles: [],
      batchesExecuted: 0,
    });
  });

  it("restores validated files in a single batch and preserves empty file contents", async () => {
    const batches: RestoreWriteEntry[][] = [];
    const sandbox = createMockRestoreSandbox(batches);

    const result = await restoreFilesToSandbox(sandbox, {
      "app/page.tsx": "export default function Page() { return <div />; }",
      "components/empty.ts": "",
      "lib/data.ts": "export const items = [];",
    });

    assert.equal(result.ok, true);
    assert.equal(result.batchesExecuted, 1);
    assert.deepEqual(result.restoredFiles, [
      "app/page.tsx",
      "components/empty.ts",
      "lib/data.ts",
    ]);
    assert.deepEqual(result.failedFiles, []);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0], [
      { path: "app/page.tsx", data: "export default function Page() { return <div />; }" },
      { path: "components/empty.ts", data: "" },
      { path: "lib/data.ts", data: "export const items = [];" },
    ]);
  });

  it("chunks large snapshots into batches of 25 files by default", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) {
      files[`components/item-${i}.tsx`] = `export const Item${i} = () => null;`;
    }

    const batches: RestoreWriteEntry[][] = [];
    const sandbox = createMockRestoreSandbox(batches);

    const result = await restoreFilesToSandbox(sandbox, files);

    assert.equal(RESTORE_BATCH_SIZE, 25);
    assert.equal(result.ok, true);
    assert.equal(result.batchesExecuted, 3);
    assert.equal(result.restoredFiles.length, 60);
    assert.deepEqual(
      batches.map((b) => b.length),
      [25, 25, 10]
    );
  });

  it("fails closed on partial batch restoration failure and skips remaining batches", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 55; i++) {
      files[`components/item-${i}.tsx`] = `content ${i}`;
    }

    const fatalErrors: Array<{ label: string; err: Error }> = [
      { label: "TimeoutError", err: new TimeoutError("Sandbox timed out during restore") },
      { label: "NotFoundError", err: new NotFoundError("Sandbox expired") },
      { label: "AuthenticationError", err: new AuthenticationError("Invalid E2B key") },
      { label: "NotEnoughSpaceError", err: new NotEnoughSpaceError("Disk full") },
      { label: "SandboxError", err: new SandboxError("500 internal error") },
    ];

    for (const { label, err } of fatalErrors) {
      const batches: RestoreWriteEntry[][] = [];
      let attemptedBatches = 0;
      const sandbox = createMockRestoreSandbox(batches, (_entries, batchIndex) => {
        attemptedBatches++;
        if (batchIndex === 1) {
          throw err;
        }
      });

      const result = await restoreFilesToSandbox(sandbox, files, 25);

      assert.equal(result.ok, false, `Expected fail-closed result for ${label}`);
      assert.equal(attemptedBatches, 2, `Should not attempt batch 3 after batch 2 fails (${label})`);
      assert.equal(result.batchesExecuted, 1);
      assert.equal(result.restoredFiles.length, 25);
      assert.equal(result.failedFiles.length, 30);
      assert.ok(result.failedFiles[0].error.includes(err.message));
      assert.ok(result.failedFiles[25].error.includes("Skipped after restoration batch failure"));
      assert.ok(result.error?.includes("batch 2"));
    }
  });

  it("refuses restoration with zero E2B calls when snapshot contains invalid paths", async () => {
    const batches: RestoreWriteEntry[][] = [];
    const sandbox = createMockRestoreSandbox(batches);

    const result = await restoreFilesToSandbox(sandbox, {
      "app/page.tsx": "ok",
      "../escape.ts": "bad",
    });

    assert.equal(batches.length, 0);
    assert.equal(result.ok, false);
    assert.deepEqual(result.restoredFiles, []);
    assert.equal(result.failedFiles.length, 1);
    assert.equal(result.failedFiles[0].path, "../escape.ts");
  });
});

describe("executeRestoreProjectFiles", () => {
  it("skips step.run and getSandbox completely when there are no previous files", async () => {
    let stepCalled = false;
    let getSandboxCalled = false;

    const result = await executeRestoreProjectFiles({
      files: {},
      sandboxId: "sbx_1",
      getSandbox: async () => {
        getSandboxCalled = true;
        return createMockRestoreSandbox();
      },
      step: {
        run: async (_id, fn) => {
          stepCalled = true;
          return await fn();
        },
      },
    });

    assert.equal(stepCalled, false);
    assert.equal(getSandboxCalled, false);
    assert.equal(result.ok, true);
    assert.deepEqual(result.restoredFiles, []);
  });

  it("executes inside step.run when step is provided, and directly when step is undefined", async () => {
    const calledStepIds: string[] = [];
    const batchesWithStep: RestoreWriteEntry[][] = [];
    const sandboxWithStep = createMockRestoreSandbox(batchesWithStep);

    const withStepResult = await executeRestoreProjectFiles({
      files: { "app/page.tsx": "v1" },
      sandboxId: "sbx_1",
      getSandbox: async () => sandboxWithStep,
      step: {
        run: async (id, fn) => {
          calledStepIds.push(id);
          return await fn();
        },
      },
    });

    assert.deepEqual(calledStepIds, ["restore-previous-files"]);
    assert.equal(withStepResult.ok, true);
    assert.equal(batchesWithStep.length, 1);

    const batchesNoStep: RestoreWriteEntry[][] = [];
    const sandboxNoStep = createMockRestoreSandbox(batchesNoStep);

    const noStepResult = await executeRestoreProjectFiles({
      files: { "app/page.tsx": "v1" },
      sandboxId: "sbx_2",
      getSandbox: async () => sandboxNoStep,
      step: undefined,
    });

    assert.equal(noStepResult.ok, true);
    assert.equal(batchesNoStep.length, 1);
  });

  it("returns structured fail-closed error when getSandbox fails during restoration", async () => {
    const result = await executeRestoreProjectFiles({
      files: {
        "./app\\page.tsx": "v1",
        "components/nav.tsx": "nav",
      },
      sandboxId: "sbx_dead",
      getSandbox: async () => {
        throw new NotFoundError("Sandbox sbx_dead not found");
      },
      step: {
        run: async (_id, fn) => await fn(),
      },
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.restoredFiles, []);
    assert.deepEqual(result.failedFiles, [
      { path: "app/page.tsx", error: "Sandbox sbx_dead not found" },
      { path: "components/nav.tsx", error: "Sandbox sbx_dead not found" },
    ]);
    assert.ok(result.error?.includes("Sandbox connection failed during restoration"));
  });
});

describe("buildAgentSystemPrompt", () => {
  it("returns base prompt unchanged when no files were restored", () => {
    assert.equal(buildAgentSystemPrompt("BASE PROMPT", []), "BASE PROMPT");
  });

  it("appends sorted restored file paths without embedding file source code", () => {
    const prompt = buildAgentSystemPrompt("BASE PROMPT", [
      "lib/utils.ts",
      "app/page.tsx",
      "components/header.tsx",
    ]);

    assert.ok(prompt.startsWith("BASE PROMPT"));
    assert.ok(prompt.includes("Existing Project Context (Restored Files):"));
    assert.ok(
      prompt.indexOf("- app/page.tsx") < prompt.indexOf("- components/header.tsx") &&
        prompt.indexOf("- components/header.tsx") < prompt.indexOf("- lib/utils.ts")
    );
    assert.ok(prompt.includes("readFiles"));
    assert.ok(prompt.includes("createOrUpdateFiles"));
  });
});

describe("Follow-up state merging, Inngest replay & persistence guards", () => {
  it("preserves untouched restored files + follow-up edits across live run and Inngest replay", async () => {
    const previousFiles = {
      "app/page.tsx": "page v1",
      "components/header.tsx": "header v1",
    };

    const restoreBatches: RestoreWriteEntry[][] = [];
    const restoreSandbox = createMockRestoreSandbox(restoreBatches);
    const writtenInTurn2: Record<string, string> = {};
    const writeSandbox: FilesSandbox = {
      files: {
        write: async (path: string, data: string) => {
          writtenInTurn2[path] = data;
          return { name: path.split("/").pop() || path, path } as EntryInfo;
        },
      },
    };

    let memoizedRestore: RestoreFilesResult | undefined;
    let memoizedWrite: CreateOrUpdateFilesStepResult | undefined;

    // Live execution:
    const liveRestore = await executeRestoreProjectFiles({
      files: previousFiles,
      sandboxId: "sbx_turn2",
      getSandbox: async () => restoreSandbox,
      step: {
        run: async (_id, fn) => {
          memoizedRestore = structuredClone(await fn());
          return memoizedRestore;
        },
      },
    });
    assert.equal(liveRestore.ok, true);

    const liveNetwork = {
      state: {
        data: {
          files: { ...previousFiles },
          unresolvedFileErrors: {} as Record<string, string>,
        },
      },
    };

    const liveWriteResult = await executeCreateOrUpdateFilesTool({
      files: [
        { path: "app/page.tsx", content: "page v2" },
        { path: "components/footer.tsx", content: "footer v2" },
      ],
      sandboxId: "sbx_turn2",
      getSandbox: async () => writeSandbox,
      network: liveNetwork,
      step: {
        run: async (_id, fn) => {
          memoizedWrite = structuredClone(await fn());
          return memoizedWrite;
        },
      },
    });
    liveNetwork.state.data.unresolvedFileErrors = reconcileFileWriteErrors(
      liveNetwork.state.data.unresolvedFileErrors,
      liveWriteResult
    );

    assert.deepEqual(liveNetwork.state.data.files, {
      "app/page.tsx": "page v2",
      "components/header.tsx": "header v1",
      "components/footer.tsx": "footer v2",
    });
    assert.equal(
      shouldPersistFragment({
        summary: "<task_summary>Updated page and added footer</task_summary>",
        files: liveNetwork.state.data.files,
        restoredFileCount: 2,
        unresolvedFileErrors: liveNetwork.state.data.unresolvedFileErrors,
      }),
      true
    );

    // Simulated Inngest replay with zero E2B calls:
    const failOnE2bCall = async (): Promise<never> => {
      throw new Error("Must not hit E2B on memoized replay");
    };

    const replayRestore = await executeRestoreProjectFiles({
      files: previousFiles,
      sandboxId: "sbx_turn2",
      getSandbox: failOnE2bCall,
      step: {
        run: async () => memoizedRestore!,
      },
    });
    assert.equal(replayRestore.ok, true);

    const replayNetwork = {
      state: {
        data: {
          files: { ...previousFiles },
          unresolvedFileErrors: {} as Record<string, string>,
        },
      },
    };

    const replayWriteResult = await executeCreateOrUpdateFilesTool({
      files: [
        { path: "app/page.tsx", content: "page v2" },
        { path: "components/footer.tsx", content: "footer v2" },
      ],
      sandboxId: "sbx_turn2",
      getSandbox: failOnE2bCall,
      network: replayNetwork,
      step: {
        run: async () => memoizedWrite!,
      },
    });
    replayNetwork.state.data.unresolvedFileErrors = reconcileFileWriteErrors(
      replayNetwork.state.data.unresolvedFileErrors,
      replayWriteResult
    );

    assert.equal(restoreBatches.length, 1);
    assert.deepEqual(replayNetwork.state.data.files, liveNetwork.state.data.files);
    assert.deepEqual(replayNetwork.state.data.unresolvedFileErrors, {});
  });

  it("allows legitimate zero-file-change follow-up when restored files exist and summary is valid", () => {
    const canPersist = shouldPersistFragment({
      summary: "<task_summary>Verified existing app; no file edits needed.</task_summary>",
      files: {
        "app/page.tsx": "page v1",
        "components/header.tsx": "header v1",
      },
      restoredFileCount: 2,
      unresolvedFileErrors: {},
    });

    assert.equal(canPersist, true);
  });

  it("blocks persistence when unresolved file-write failures remain (even with pre-seeded restored files)", () => {
    let errors: Record<string, string> = {};

    // Partial failure: app/page.tsx succeeded, components/broken.tsx failed
    errors = reconcileFileWriteErrors(errors, {
      ok: false,
      writtenFiles: ["app/page.tsx"],
      failedFiles: [{ path: "components/broken.tsx", error: "Write error" }],
    });

    assert.equal(
      shouldPersistFragment({
        summary: "<task_summary>Claimed done despite failed write</task_summary>",
        files: {
          "app/page.tsx": "page v2",
          "components/header.tsx": "header v1",
        },
        restoredFileCount: 2,
        unresolvedFileErrors: errors,
      }),
      false
    );

    // Writing an unrelated file does NOT clear the unresolved valid-path failure:
    errors = reconcileFileWriteErrors(errors, {
      ok: true,
      writtenFiles: ["lib/other.ts"],
      failedFiles: [],
    });
    assert.equal(Object.keys(errors).length, 1);
    assert.equal(
      shouldPersistFragment({
        summary: "<task_summary>Still did not fix broken.tsx</task_summary>",
        files: {
          "app/page.tsx": "page v2",
          "components/header.tsx": "header v1",
          "lib/other.ts": "other",
        },
        restoredFileCount: 2,
        unresolvedFileErrors: errors,
      }),
      false
    );

    // Retrying and succeeding on components/broken.tsx clears the unresolved failure:
    errors = reconcileFileWriteErrors(errors, {
      ok: true,
      writtenFiles: ["components/broken.tsx"],
      failedFiles: [],
    });
    assert.deepEqual(errors, {});
    assert.equal(
      shouldPersistFragment({
        summary: "<task_summary>Fixed broken.tsx and completed task</task_summary>",
        files: {
          "app/page.tsx": "page v2",
          "components/header.tsx": "header v1",
          "components/broken.tsx": "fixed",
        },
        restoredFileCount: 2,
        unresolvedFileErrors: errors,
      }),
      true
    );
  });

  it("does NOT clear protected package.json failure when writing an unrelated valid file; clears only on successful package-manager terminal recovery", () => {
    let errors: Record<string, string> = {};

    // 1. Agent attempts to write protected package.json -> rejected
    errors = reconcileFileWriteErrors(errors, {
      ok: false,
      writtenFiles: [],
      failedFiles: [
        { path: "package.json", error: 'Modifying protected file "package.json" is not allowed' },
      ],
    });

    // 2. Agent writes an unrelated valid file -> MUST NOT clear package.json error
    errors = reconcileFileWriteErrors(errors, {
      ok: true,
      writtenFiles: ["app/page.tsx"],
      failedFiles: [],
    });
    assert.ok("package.json" in errors);
    assert.equal(
      shouldPersistFragment({
        summary: "<task_summary>Updated page without fixing package install</task_summary>",
        files: { "app/page.tsx": "v2" },
        restoredFileCount: 1,
        unresolvedFileErrors: errors,
      }),
      false
    );

    // 3. Failed npm install or non-package terminal command MUST NOT clear package.json error
    errors = reconcileTerminalRecovery(errors, "npm install framer-motion --yes", { ok: false });
    assert.ok("package.json" in errors);

    errors = reconcileTerminalRecovery(errors, "pwd", { ok: true });
    assert.ok("package.json" in errors);

    errors = reconcileTerminalRecovery(errors, "echo 'npm install framer-motion'", { ok: true });
    assert.ok("package.json" in errors);

    // 4. Successful package-management terminal command explicitly clears package.json error
    errors = reconcileTerminalRecovery(errors, "npm install framer-motion --yes", { ok: true });
    assert.deepEqual(errors, {});
    assert.equal(
      shouldPersistFragment({
        summary: "<task_summary>Installed framer-motion via terminal and updated page</task_summary>",
        files: { "app/page.tsx": "v2" },
        restoredFileCount: 1,
        unresolvedFileErrors: errors,
      }),
      true
    );
  });

  it("clears workspace-prefix/alias path errors ONLY when the exact corresponding relative path is written", () => {
    let errors: Record<string, string> = {};

    errors = reconcileFileWriteErrors(errors, {
      ok: false,
      writtenFiles: [],
      failedFiles: [
        { path: "/home/user/components/card.tsx", error: "Absolute path is not allowed" },
        { path: "@/lib/helpers.ts", error: 'Import alias "@" cannot be used' },
      ],
    });

    // Unrelated valid write MUST NOT clear either error
    errors = reconcileFileWriteErrors(errors, {
      ok: true,
      writtenFiles: ["app/page.tsx"],
      failedFiles: [],
    });
    assert.ok("/home/user/components/card.tsx" in errors);
    assert.ok("@/lib/helpers.ts" in errors);

    // Writing exact matching relative path clears ONLY that entry
    errors = reconcileFileWriteErrors(errors, {
      ok: true,
      writtenFiles: ["components/card.tsx"],
      failedFiles: [],
    });
    assert.equal("/home/user/components/card.tsx" in errors, false);
    assert.ok("@/lib/helpers.ts" in errors);

    // Writing the second matching relative path clears the remaining entry
    errors = reconcileFileWriteErrors(errors, {
      ok: true,
      writtenFiles: ["lib/helpers.ts"],
      failedFiles: [],
    });
    assert.deepEqual(errors, {});
  });

  it("never auto-clears unsafe/traversal paths via unrelated writes or terminal package installs", () => {
    let errors: Record<string, string> = {};

    errors = reconcileFileWriteErrors(errors, {
      ok: false,
      writtenFiles: [],
      failedFiles: [
        { path: "../escape.ts", error: "Path traversal is not allowed" },
        { path: "../package.json", error: "Path traversal is not allowed" },
        { path: "/etc/passwd", error: "Absolute path is not allowed" },
        { path: ".git/config", error: "Modifying .git internals is not allowed" },
      ],
    });

    errors = reconcileFileWriteErrors(errors, {
      ok: true,
      writtenFiles: ["app/page.tsx"],
      failedFiles: [],
    });
    errors = reconcileTerminalRecovery(errors, "npm install zod --yes", { ok: true });

    assert.deepEqual(Object.keys(errors).sort(), [
      "../escape.ts",
      "../package.json",
      ".git/config",
      "/etc/passwd",
    ]);
    assert.equal(
      shouldPersistFragment({
        summary: "<task_summary>Done</task_summary>",
        files: { "app/page.tsx": "v2" },
        restoredFileCount: 1,
        unresolvedFileErrors: errors,
      }),
      false
    );
  });

  it("does NOT clear valid-path write failures via terminal package installs", () => {
    let errors: Record<string, string> = {};

    errors = reconcileFileWriteErrors(errors, {
      ok: false,
      writtenFiles: [],
      failedFiles: [
        { path: "components/broken.tsx", error: "Disk write error" },
        { path: "package.json", error: "Protected file" },
      ],
    });

    // Successful npm install clears package.json ONLY; valid-path write error stays unresolved
    errors = reconcileTerminalRecovery(errors, "npm install lucide-react --yes", { ok: true });
    assert.equal("package.json" in errors, false);
    assert.ok("components/broken.tsx" in errors);
    assert.equal(
      shouldPersistFragment({
        summary: "<task_summary>Done</task_summary>",
        files: { "app/page.tsx": "v1" },
        restoredFileCount: 1,
        unresolvedFileErrors: errors,
      }),
      false
    );
  });

  it("blocks persistence when summary is missing or total files is empty (preserving previous valid snapshot)", () => {
    assert.equal(
      shouldPersistFragment({
        summary: "",
        files: { "app/page.tsx": "restored v1" },
        restoredFileCount: 1,
        unresolvedFileErrors: {},
      }),
      false
    );

    assert.equal(
      shouldPersistFragment({
        summary: "<task_summary>Nothing written on first run</task_summary>",
        files: {},
        restoredFileCount: 0,
        unresolvedFileErrors: {},
      }),
      false
    );
  });
});

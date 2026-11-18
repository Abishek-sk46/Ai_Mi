import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AuthenticationError,
  NotFoundError,
  TimeoutError,
} from "@e2b/code-interpreter";

import { PROMPT } from "../prompt";
import { validateAndNormalizeFilePath } from "./files";
import {
  executeReadFilesTool,
  isSandboxUnavailableError,
  runReadFiles,
  validateAndNormalizeReadPath,
  type ReadFilesSandbox,
  type ReadFilesToolResult,
} from "./read-files";
import { buildAgentSystemPrompt } from "./restore";

function createMockReadSandbox(
  storage: Record<string, string>,
  onRead?: (path: string) => Promise<void> | void
): ReadFilesSandbox {
  return {
    files: {
      read: async (path: string) => {
        if (onRead) {
          await onRead(path);
        }
        if (!Object.prototype.hasOwnProperty.call(storage, path)) {
          throw new NotFoundError(`File not found: ${path}`);
        }
        return storage[path];
      },
    },
  };
}

describe("validateAndNormalizeReadPath", () => {
  it("accepts valid project-relative paths and normalizes Windows separators and leading ./", () => {
    assert.deepEqual(validateAndNormalizeReadPath("app/page.tsx"), {
      ok: true,
      normalizedPath: "app/page.tsx",
    });
    assert.deepEqual(validateAndNormalizeReadPath("./components\\ui\\button.tsx"), {
      ok: true,
      normalizedPath: "components/ui/button.tsx",
    });
    assert.deepEqual(validateAndNormalizeReadPath("  ././lib/utils.ts  "), {
      ok: true,
      normalizedPath: "lib/utils.ts",
    });
  });

  it("allows read-only access to package.json and lockfiles", () => {
    for (const pkgFile of [
      "package.json",
      "./package.json",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lock",
      "bun.lockb",
    ]) {
      const result = validateAndNormalizeReadPath(pkgFile);
      assert.equal(result.ok, true, `Expected read access to "${pkgFile}" to be allowed`);
    }
  });

  it("rejects empty, absolute POSIX/Windows/UNC, traversal, @/ alias, .git, directory, and null-byte paths", () => {
    const invalidPaths = [
      "",
      "   ",
      "/home/user/app/page.tsx",
      "/etc/passwd",
      "C:\\Windows\\system.ini",
      "\\\\server\\share\\file.ts",
      "//server/share/file.ts",
      "../secret.ts",
      "app/../../outside.ts",
      "./../escape.ts",
      "@/components/ui/button.tsx",
      "@",
      ".git/config",
      ".GIT/HEAD",
      "sub/.git/config",
      "app/",
      ".",
      "./",
      "app/file\0.ts",
    ];

    for (const invalidPath of invalidPaths) {
      const result = validateAndNormalizeReadPath(invalidPath);
      assert.equal(result.ok, false, `Expected "${invalidPath}" to be rejected`);
    }
  });
});

describe("runReadFiles", () => {
  it("reads multiple files and returns normalized project-relative paths", async () => {
    const sandbox = createMockReadSandbox({
      "app/page.tsx": "export default function Page() { return <main />; }",
      "components/ui/button.tsx": "export const Button = () => <button />;",
      "package.json": '{"name":"demo"}',
    });

    const result = await runReadFiles(sandbox, [
      "./app\\page.tsx",
      "components/ui/button.tsx",
      "package.json",
      "app/page.tsx", // duplicate normalized path should be deduplicated
    ]);

    assert.deepEqual(result, {
      ok: true,
      files: [
        { path: "app/page.tsx", content: "export default function Page() { return <main />; }" },
        { path: "components/ui/button.tsx", content: "export const Button = () => <button />;" },
        { path: "package.json", content: '{"name":"demo"}' },
      ],
      failedFiles: [],
    });
  });

  it("preserves empty file contents ('') cleanly", async () => {
    const sandbox = createMockReadSandbox({
      "components/empty.ts": "",
    });

    const result = await runReadFiles(sandbox, ["components/empty.ts"]);

    assert.deepEqual(result, {
      ok: true,
      files: [{ path: "components/empty.ts", content: "" }],
      failedFiles: [],
    });
  });

  it("preserves successful reads on partial failures (missing or invalid files do not fail the whole batch)", async () => {
    const attemptedPaths: string[] = [];
    const sandbox = createMockReadSandbox(
      {
        "app/page.tsx": "page content",
        "lib/utils.ts": "utils content",
      },
      (path) => {
        attemptedPaths.push(path);
      }
    );

    const result = await runReadFiles(sandbox, [
      "app/page.tsx",
      "components/missing.tsx",
      "/home/user/bad.tsx",
      "lib/utils.ts",
    ]);

    assert.equal(result.ok, true);
    assert.deepEqual(attemptedPaths, ["app/page.tsx", "components/missing.tsx", "lib/utils.ts"]);
    assert.deepEqual(result.files, [
      { path: "app/page.tsx", content: "page content" },
      { path: "lib/utils.ts", content: "utils content" },
    ]);
    assert.equal(result.failedFiles.length, 2);
    assert.equal(result.failedFiles[0].path, "components/missing.tsx");
    assert.equal(result.failedFiles[1].path, "/home/user/bad.tsx");
  });

  it("returns ok: false with clear error when all requested files are missing", async () => {
    const sandbox = createMockReadSandbox({});

    const result = await runReadFiles(sandbox, [
      "components/one.tsx",
      "components/two.tsx",
    ]);

    assert.equal(result.ok, false);
    assert.deepEqual(result.files, []);
    assert.equal(result.failedFiles.length, 2);
    assert.ok(result.error?.includes("Failed to read all 2 requested files"));
  });

  it("fails closed (ok: false) on fatal TimeoutError, AuthenticationError, and sandbox-level NotFoundError while preserving earlier reads diagnostically", async () => {
    const sandboxErrors: Array<{ label: string; err: Error }> = [
      { label: "TimeoutError", err: new TimeoutError("Sandbox timed out") },
      { label: "AuthenticationError", err: new AuthenticationError("Unauthorized") },
      {
        label: "NotFoundError (sandbox not running)",
        err: new NotFoundError("Sandbox is probably not running anymore"),
      },
      {
        label: "NotFoundError (sandbox not found)",
        err: new NotFoundError("The sandbox sbx_123 was not found"),
      },
    ];

    for (const { label, err } of sandboxErrors) {
      const attempted: string[] = [];
      const sandbox = createMockReadSandbox(
        {
          "app/page.tsx": "ok",
          "components/second.tsx": "never reached",
          "components/third.tsx": "skipped",
        },
        (path) => {
          attempted.push(path);
          if (path === "components/second.tsx") {
            throw err;
          }
        }
      );

      const result = await runReadFiles(sandbox, [
        "app/page.tsx",
        "components/second.tsx",
        "./components\\third.tsx",
      ]);

      assert.deepEqual(attempted, ["app/page.tsx", "components/second.tsx"], label);
      assert.equal(result.ok, false, `Expected fail-closed ok: false for ${label}`);
      assert.ok(result.error?.includes("Sandbox unavailable while reading files"), label);
      assert.deepEqual(result.files, [{ path: "app/page.tsx", content: "ok" }], label);
      assert.equal(result.failedFiles.length, 2, label);
      assert.equal(result.failedFiles[0].path, "components/second.tsx", label);
      assert.equal(result.failedFiles[1].path, "components/third.tsx", label);
      assert.ok(result.failedFiles[1].error.includes("Skipped after fatal sandbox error"), label);
    }
  });

  it("distinguishes file-level NotFoundError (including filenames containing 'sandbox') from sandbox-level NotFoundError", async () => {
    assert.equal(isSandboxUnavailableError(new TimeoutError("502 timeout")), true);
    assert.equal(isSandboxUnavailableError(new AuthenticationError("401")), true);
    assert.equal(
      isSandboxUnavailableError(new NotFoundError("Sandbox is probably not running anymore")),
      true
    );
    assert.equal(
      isSandboxUnavailableError(new NotFoundError("The sandbox sbx_99 was not found")),
      true
    );
    assert.equal(isSandboxUnavailableError(new NotFoundError("Sandbox sbx_99 has expired")), true);

    assert.equal(
      isSandboxUnavailableError(new NotFoundError("stat /home/user/missing.ts: no such file or directory")),
      false
    );
    assert.equal(
      isSandboxUnavailableError(new NotFoundError("components/sandbox.tsx: file not found")),
      false
    );
    assert.equal(
      isSandboxUnavailableError(new NotFoundError("sandbox-card.tsx not found")),
      false
    );

    // End-to-end check: missing file named components/sandbox.tsx remains a per-file failure
    const attempted: string[] = [];
    const sandbox = createMockReadSandbox(
      {
        "app/page.tsx": "page ok",
        "lib/utils.ts": "utils ok",
      },
      (path) => {
        attempted.push(path);
        if (path === "components/sandbox.tsx") {
          throw new NotFoundError("components/sandbox.tsx: file not found");
        }
      }
    );

    const result = await runReadFiles(sandbox, [
      "app/page.tsx",
      "components/sandbox.tsx",
      "lib/utils.ts",
    ]);

    assert.equal(result.ok, true);
    assert.deepEqual(attempted, ["app/page.tsx", "components/sandbox.tsx", "lib/utils.ts"]);
    assert.deepEqual(result.files, [
      { path: "app/page.tsx", content: "page ok" },
      { path: "lib/utils.ts", content: "utils ok" },
    ]);
    assert.deepEqual(result.failedFiles, [
      { path: "components/sandbox.tsx", error: "components/sandbox.tsx: file not found" },
    ]);
  });
});

describe("executeReadFilesTool", () => {
  it("runs inside step.run when step is available, and directly when step is unavailable", async () => {
    const calledSteps: string[] = [];
    const sandbox = createMockReadSandbox({ "app/page.tsx": "hello" });

    const withStep = await executeReadFilesTool({
      files: ["app/page.tsx"],
      sandboxId: "sbx_1",
      getSandbox: async () => sandbox,
      step: {
        run: async (id, fn) => {
          calledSteps.push(id);
          return await fn();
        },
      },
    });

    assert.deepEqual(calledSteps, ["readFiles"]);
    assert.equal(withStep.ok, true);
    assert.deepEqual(withStep.files, [{ path: "app/page.tsx", content: "hello" }]);

    const withoutStep = await executeReadFilesTool({
      files: ["app/page.tsx"],
      sandboxId: "sbx_1",
      getSandbox: async () => sandbox,
      step: undefined,
    });

    assert.notEqual(withoutStep, undefined);
    assert.equal(withoutStep.ok, true);
    assert.deepEqual(withoutStep.files, [{ path: "app/page.tsx", content: "hello" }]);
  });

  it("handles empty input without creating an Inngest step and never returns undefined", async () => {
    let stepCalled = false;
    let getSandboxCalled = false;

    const result = await executeReadFilesTool({
      files: [],
      sandboxId: "sbx_1",
      getSandbox: async () => {
        getSandboxCalled = true;
        return createMockReadSandbox({});
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
    assert.notEqual(result, undefined);
    assert.deepEqual(result, {
      ok: false,
      files: [],
      failedFiles: [],
      error: "No file paths provided to read.",
    });
  });

  it("handles sandbox connection errors cleanly and never returns undefined", async () => {
    const result: ReadFilesToolResult = await executeReadFilesTool({
      files: ["./app\\page.tsx", "../bad.ts"],
      sandboxId: "sbx_expired",
      getSandbox: async () => {
        throw new NotFoundError("Sandbox sbx_expired is not running");
      },
      step: {
        run: async (_id, fn) => await fn(),
      },
    });

    assert.notEqual(result, undefined);
    assert.equal(result.ok, false);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.failedFiles, [
      { path: "app/page.tsx", error: "Sandbox sbx_expired is not running" },
      { path: "../bad.ts", error: "Sandbox sbx_expired is not running" },
    ]);
    assert.ok(result.error?.includes("Sandbox connection failed"));

    // Mirrors AgentKit invokeTools() JSON serialization:
    const wrapped = {
      data: typeof result === "undefined" ? "readFiles successfully executed" : result,
    };
    const parsed = JSON.parse(JSON.stringify(wrapped)) as { data: ReadFilesToolResult };
    assert.notEqual(parsed.data, "readFiles successfully executed");
    assert.equal(parsed.data.ok, false);
  });
});

describe("Agent prompt path consistency", () => {
  it("contains no contradictory /home/user/... example path instructions for readFiles", () => {
    assert.equal(PROMPT.includes('"/home/user/components/ui/button.tsx"'), false);
    assert.equal(PROMPT.includes("you MUST use the actual path"), false);
    assert.ok(PROMPT.includes('do NOT include "/home/user"'));
    assert.ok(PROMPT.includes("project-relative paths"));
  });

  it("uses valid project-relative filesystem examples accepted by both read and write validators", () => {
    const documentedPaths = [
      "app/page.tsx",
      "components/ui/button.tsx",
      "lib/utils.ts",
    ];

    for (const examplePath of documentedPaths) {
      assert.ok(PROMPT.includes(`"${examplePath}"`), `Expected PROMPT to include "${examplePath}"`);
      assert.equal(validateAndNormalizeReadPath(examplePath).ok, true);
      assert.equal(validateAndNormalizeFilePath(examplePath).ok, true);
    }
  });

  it("keeps @/ valid for source-code imports while prohibiting it for filesystem operations", () => {
    assert.ok(PROMPT.includes('"@/components/ui/button"'));
    assert.ok(PROMPT.includes('"@/components/ui/*"'));
    assert.ok(PROMPT.includes('NEVER use "@/" as a filesystem path'));
    assert.ok(PROMPT.includes('"/etc/passwd"'));
    assert.ok(PROMPT.includes('"../..."'));
  });

  it("produces a restored-file prompt manifest whose paths are directly valid for readFiles and createOrUpdateFiles", () => {
    const restoredPaths = ["app/page.tsx", "components/header.tsx", "lib/utils.ts"];
    const fullPrompt = buildAgentSystemPrompt(PROMPT, restoredPaths);

    assert.ok(fullPrompt.includes("Existing Project Context (Restored Files):"));
    for (const restoredPath of restoredPaths) {
      assert.ok(fullPrompt.includes(`- ${restoredPath}`));
      assert.equal(validateAndNormalizeReadPath(restoredPath).ok, true);
      assert.equal(validateAndNormalizeFilePath(restoredPath).ok, true);
    }
  });
});

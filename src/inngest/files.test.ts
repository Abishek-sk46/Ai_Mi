import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AuthenticationError,
  InvalidArgumentError,
  NotEnoughSpaceError,
  NotFoundError,
  SandboxError,
  TimeoutError,
  type EntryInfo,
} from "@e2b/code-interpreter";

import {
  executeCreateOrUpdateFilesTool,
  runCreateOrUpdateFiles,
  stripOuterCodeFence,
  validateAndNormalizeFilePath,
  type CreateOrUpdateFilesStepResult,
  type CreateOrUpdateFilesToolResult,
  type FilesNetworkLike,
  type FilesSandbox,
  type FileWriteInput,
} from "./files";

function makeEntryInfo(path: string): EntryInfo {
  const name = path.split("/").pop() || path;
  return { name, path } as EntryInfo;
}

function createMockSandbox(
  written: Record<string, string> = {},
  onWrite?: (path: string, data: string) => Promise<void> | void
): FilesSandbox {
  return {
    files: {
      write: async (path: string, data: string) => {
        if (onWrite) {
          await onWrite(path, data);
        }
        written[path] = data;
        return makeEntryInfo(path);
      },
    },
  };
}

function createMockNetwork(initialFiles: Record<string, string> = {}): FilesNetworkLike {
  return {
    state: {
      data: {
        files: { ...initialFiles },
      },
    },
  };
}

describe("stripOuterCodeFence", () => {
  it("strips outer Markdown code fences for ts, tsx, jsx, json, css, html and bare fences", () => {
    const cases: Array<{ label: string; input: string; expected: string }> = [
      {
        label: "ts",
        input: "```ts\nexport const x: number = 1;\n```",
        expected: "export const x: number = 1;",
      },
      {
        label: "tsx",
        input: "```tsx\nexport default function Page() {\n  return <main>Hi</main>;\n}\n```",
        expected: "export default function Page() {\n  return <main>Hi</main>;\n}",
      },
      {
        label: "jsx",
        input: "```jsx\nexport const Card = () => <div>Card</div>;\n```",
        expected: "export const Card = () => <div>Card</div>;",
      },
      {
        label: "json",
        input: '```json\n{\n  "name": "demo"\n}\n```',
        expected: '{\n  "name": "demo"\n}',
      },
      {
        label: "css",
        input: "```css\n.card { color: red; }\n```",
        expected: ".card { color: red; }",
      },
      {
        label: "html",
        input: "```html\n<section><h1>Hello</h1></section>\n```",
        expected: "<section><h1>Hello</h1></section>",
      },
      {
        label: "bare",
        input: "```\nconsole.log('ok');\n```",
        expected: "console.log('ok');",
      },
    ];

    for (const testCase of cases) {
      assert.equal(
        stripOuterCodeFence(testCase.input),
        testCase.expected,
        `Failed for ${testCase.label} fence`
      );
    }
  });

  it("handles trailing and leading whitespace on opening and closing fence lines", () => {
    const withSpaces = "  ```tsx   \r\nexport const App = () => <div />;\r\n  ```   \n";
    assert.equal(stripOuterCodeFence(withSpaces), "export const App = () => <div />;");

    const unfencedWithWhitespace = "  export const a = 1;\n\n";
    assert.equal(stripOuterCodeFence(unfencedWithWhitespace), unfencedWithWhitespace);
  });

  it("preserves legitimate triple backticks inside source code", () => {
    const sourceWithBackticks = [
      "export function CodeSample() {",
      '  const snippet = "```tsx\\nconst a = 1;\\n```";',
      "  return <pre>{snippet}</pre>;",
      "}",
    ].join("\n");

    assert.equal(stripOuterCodeFence(sourceWithBackticks), sourceWithBackticks);
  });

  it("preserves multi-block Markdown files instead of stripping outer fences", () => {
    const markdown = [
      "```js",
      "const a = 1;",
      "```",
      "Explanation between blocks",
      "```js",
      "const b = 2;",
      "```",
    ].join("\n");

    assert.equal(stripOuterCodeFence(markdown), markdown);
  });

  it("preserves empty string content", () => {
    assert.equal(stripOuterCodeFence(""), "");
  });
});

describe("validateAndNormalizeFilePath", () => {
  it("normalizes Windows separators and strips leading ./ for legitimate nested paths", () => {
    assert.deepEqual(validateAndNormalizeFilePath("app/page.tsx"), {
      ok: true,
      normalizedPath: "app/page.tsx",
    });
    assert.deepEqual(validateAndNormalizeFilePath("./components\\dashboard\\chart.tsx"), {
      ok: true,
      normalizedPath: "components/dashboard/chart.tsx",
    });
    assert.deepEqual(validateAndNormalizeFilePath("  ././lib/utils.ts  "), {
      ok: true,
      normalizedPath: "lib/utils.ts",
    });
  });

  it("rejects empty, absolute, traversal, alias, directory, and protected paths", () => {
    const invalidPaths = [
      "",
      "   ",
      "/etc/passwd",
      "/home/user/app/page.tsx",
      "C:\\Windows\\system.ini",
      "\\\\server\\share\\file.ts",
      "//server/share/file.ts",
      "../secret.ts",
      "app/../../outside.ts",
      "./../escape.ts",
      "@/components/ui/button.tsx",
      "@",
      "app/",
      ".",
      "./",
      "package.json",
      "./package.json",
      "PACKAGE.JSON",
      "sub/Package.Json",
      "package-lock.json",
      "Package-Lock.JSON",
      "yarn.lock",
      "YARN.LOCK",
      "pnpm-lock.yaml",
      "PNPM-LOCK.YAML",
      "bun.lockb",
      ".git/config",
      ".GIT/HEAD",
      "sub/.git/config",
      "app/file\0.ts",
    ];

    for (const invalidPath of invalidPaths) {
      const result = validateAndNormalizeFilePath(invalidPath);
      assert.equal(result.ok, false, `Expected "${invalidPath}" to be rejected`);
    }
  });
});

describe("runCreateOrUpdateFiles", () => {
  it("creates a single new file and returns structured result with delta", async () => {
    const written: Record<string, string> = {};
    const sandbox = createMockSandbox(written);

    const result = await runCreateOrUpdateFiles(sandbox, [
      { path: "app/page.tsx", content: "export default function Page() { return <div />; }" },
    ]);

    assert.deepEqual(result, {
      ok: true,
      writtenFiles: ["app/page.tsx"],
      failedFiles: [],
      delta: {
        "app/page.tsx": "export default function Page() { return <div />; }",
      },
    });
    assert.equal(written["app/page.tsx"], "export default function Page() { return <div />; }");
  });

  it("writes multiple files including nested paths and overwrites existing files", async () => {
    const written: Record<string, string> = {
      "app/page.tsx": "old content",
    };
    const sandbox = createMockSandbox(written);

    const result = await runCreateOrUpdateFiles(sandbox, [
      { path: "app/page.tsx", content: "new content" },
      { path: "./components\\cards\\metric-card.tsx", content: "export const MetricCard = () => null;" },
    ]);

    assert.deepEqual(result, {
      ok: true,
      writtenFiles: ["app/page.tsx", "components/cards/metric-card.tsx"],
      failedFiles: [],
      delta: {
        "app/page.tsx": "new content",
        "components/cards/metric-card.tsx": "export const MetricCard = () => null;",
      },
    });
    assert.equal(written["app/page.tsx"], "new content");
    assert.equal(
      written["components/cards/metric-card.tsx"],
      "export const MetricCard = () => null;"
    );
  });

  it("handles partial failure by continuing remaining files and preserving successful delta", async () => {
    const written: Record<string, string> = {};
    const sandbox = createMockSandbox(written, (path) => {
      if (path === "components/broken.tsx") {
        throw new InvalidArgumentError("Invalid target file");
      }
    });

    const result = await runCreateOrUpdateFiles(sandbox, [
      { path: "app/page.tsx", content: "page ok" },
      { path: "components/broken.tsx", content: "will fail" },
      { path: "lib/helpers.ts", content: "helper ok" },
    ]);

    assert.equal(result.ok, false);
    assert.deepEqual(result.writtenFiles, ["app/page.tsx", "lib/helpers.ts"]);
    assert.deepEqual(result.failedFiles, [
      { path: "components/broken.tsx", error: "Invalid target file" },
    ]);
    assert.deepEqual(result.delta, {
      "app/page.tsx": "page ok",
      "lib/helpers.ts": "helper ok",
    });
    assert.ok(result.error?.includes("components/broken.tsx"));
    assert.equal(written["app/page.tsx"], "page ok");
    assert.equal(written["lib/helpers.ts"], "helper ok");
    assert.equal("components/broken.tsx" in written, false);
  });

  it("aborts remaining files on fatal sandbox errors (Timeout, Auth, NotFound, NotEnoughSpace) while preserving earlier successes", async () => {
    const fatalErrors: Array<{ label: string; error: Error }> = [
      { label: "TimeoutError", error: new TimeoutError("Sandbox timed out") },
      { label: "AuthenticationError", error: new AuthenticationError("Unauthorized sandbox token") },
      { label: "NotFoundError", error: new NotFoundError("Sandbox is no longer running") },
      { label: "NotEnoughSpaceError", error: new NotEnoughSpaceError("No space left on device") },
    ];

    for (const { label, error } of fatalErrors) {
      const written: Record<string, string> = {};
      const sandbox = createMockSandbox(written, (path) => {
        if (path === "components/second.tsx") {
          throw error;
        }
      });

      const result = await runCreateOrUpdateFiles(sandbox, [
        { path: "components/first.tsx", content: "first ok" },
        { path: "./components\\second.tsx", content: "fatal here" },
        { path: "./components\\third.tsx", content: "should be skipped with normalized path" },
        { path: "../invalid-skipped.ts", content: "should retain raw path when invalid" },
      ]);

      assert.equal(result.ok, false, `Expected failure for ${label}`);
      assert.deepEqual(result.writtenFiles, ["components/first.tsx"], `Unexpected writtenFiles for ${label}`);
      assert.deepEqual(result.delta, { "components/first.tsx": "first ok" }, `Unexpected delta for ${label}`);
      assert.equal(result.failedFiles.length, 3, `Expected 3 failed entries for ${label}`);
      assert.equal(result.failedFiles[0].path, "components/second.tsx");
      assert.equal(result.failedFiles[1].path, "components/third.tsx");
      assert.equal(result.failedFiles[2].path, "../invalid-skipped.ts");
      assert.ok(result.failedFiles[1].error.includes("Skipped after fatal sandbox error"));
      assert.equal("components/third.tsx" in written, false);
    }
  });

  it("continues remaining files on non-fatal base SandboxError", async () => {
    const written: Record<string, string> = {};
    const sandbox = createMockSandbox(written, (path) => {
      if (path === "components/flaky.tsx") {
        throw new SandboxError("500: transient file error");
      }
    });

    const result = await runCreateOrUpdateFiles(sandbox, [
      { path: "components/first.tsx", content: "first ok" },
      { path: "components/flaky.tsx", content: "fails once" },
      { path: "components/third.tsx", content: "third still written" },
    ]);

    assert.equal(result.ok, false);
    assert.deepEqual(result.writtenFiles, ["components/first.tsx", "components/third.tsx"]);
    assert.deepEqual(result.failedFiles, [
      { path: "components/flaky.tsx", error: "500: transient file error" },
    ]);
    assert.deepEqual(result.delta, {
      "components/first.tsx": "first ok",
      "components/third.tsx": "third still written",
    });
  });

  it("handles empty files array explicitly without calling sandbox", async () => {
    let writeCalls = 0;
    const sandbox = createMockSandbox({}, () => {
      writeCalls++;
    });

    const result = await runCreateOrUpdateFiles(sandbox, []);

    assert.equal(writeCalls, 0);
    assert.deepEqual(result, {
      ok: false,
      writtenFiles: [],
      failedFiles: [],
      delta: {},
      error: "No files provided to create or update.",
    });
  });

  it("preserves valid empty file content ('') instead of treating it as missing", async () => {
    const written: Record<string, string> = {};
    const sandbox = createMockSandbox(written);

    const result = await runCreateOrUpdateFiles(sandbox, [
      { path: "components/placeholder.ts", content: "" },
    ]);

    assert.deepEqual(result, {
      ok: true,
      writtenFiles: ["components/placeholder.ts"],
      failedFiles: [],
      delta: {
        "components/placeholder.ts": "",
      },
    });
    assert.equal(Object.prototype.hasOwnProperty.call(written, "components/placeholder.ts"), true);
    assert.equal(written["components/placeholder.ts"], "");
  });

  it("does not mutate caller input objects when stripping outer code fences", async () => {
    const written: Record<string, string> = {};
    const sandbox = createMockSandbox(written);
    const inputFile: FileWriteInput = Object.freeze({
      path: "./app/page.tsx",
      content: "```tsx\nexport default function Home() { return null; }\n```",
    });
    const inputList = Object.freeze([inputFile]);

    const result = await runCreateOrUpdateFiles(sandbox, inputList);

    assert.equal(result.ok, true);
    assert.equal(inputFile.path, "./app/page.tsx");
    assert.equal(
      inputFile.content,
      "```tsx\nexport default function Home() { return null; }\n```"
    );
    assert.equal(
      result.delta["app/page.tsx"],
      "export default function Home() { return null; }"
    );
  });

  it("never writes rejected paths to E2B and reports per-file validation failures", async () => {
    const attemptedPaths: string[] = [];
    const sandbox = createMockSandbox({}, (path) => {
      attemptedPaths.push(path);
    });

    const result = await runCreateOrUpdateFiles(sandbox, [
      { path: "package.json", content: "{}" },
      { path: "../escape.ts", content: "bad" },
      { path: "/home/user/app/page.tsx", content: "bad" },
      { path: "app/valid.tsx", content: "export const ok = true;" },
    ]);

    assert.equal(result.ok, false);
    assert.deepEqual(attemptedPaths, ["app/valid.tsx"]);
    assert.deepEqual(result.writtenFiles, ["app/valid.tsx"]);
    assert.equal(result.failedFiles.length, 3);
    assert.deepEqual(
      result.failedFiles.map((f) => f.path),
      ["package.json", "../escape.ts", "/home/user/app/page.tsx"]
    );
  });
});

describe("executeCreateOrUpdateFilesTool", () => {
  it("merges newly written files into network.state.data.files without losing existing files", async () => {
    const sandbox = createMockSandbox();
    const network = createMockNetwork({
      "app/layout.tsx": "existing layout",
      "app/page.tsx": "old page",
    });

    const result = await executeCreateOrUpdateFilesTool({
      files: [
        { path: "app/page.tsx", content: "updated page" },
        { path: "components/nav.tsx", content: "nav component" },
      ],
      sandboxId: "sbx_1",
      getSandbox: async () => sandbox,
      network,
      step: {
        run: async (_id, fn) => await fn(),
      },
    });

    assert.deepEqual(result, {
      ok: true,
      writtenFiles: ["app/page.tsx", "components/nav.tsx"],
      failedFiles: [],
    });
    assert.deepEqual(network.state.data.files, {
      "app/layout.tsx": "existing layout",
      "app/page.tsx": "updated page",
      "components/nav.tsx": "nav component",
    });
  });

  it("executes writes and updates state even when step is undefined", async () => {
    const written: Record<string, string> = {};
    const sandbox = createMockSandbox(written);
    const network = createMockNetwork();

    const result = await executeCreateOrUpdateFilesTool({
      files: [{ path: "app/page.tsx", content: "direct write" }],
      sandboxId: "sbx_1",
      getSandbox: async () => sandbox,
      network,
      step: undefined,
    });

    assert.equal(result.ok, true);
    assert.equal(written["app/page.tsx"], "direct write");
    assert.deepEqual(network.state.data.files, { "app/page.tsx": "direct write" });
  });

  it("returns empty-files error before entering step.run (zero Inngest steps created)", async () => {
    let stepCalled = false;
    let getSandboxCalled = false;
    const network = createMockNetwork({ "app/existing.tsx": "keep me" });

    const result = await executeCreateOrUpdateFilesTool({
      files: [],
      sandboxId: "sbx_1",
      getSandbox: async () => {
        getSandboxCalled = true;
        return createMockSandbox();
      },
      network,
      step: {
        run: async (_id, fn) => {
          stepCalled = true;
          return await fn();
        },
      },
    });

    assert.equal(stepCalled, false);
    assert.equal(getSandboxCalled, false);
    assert.deepEqual(result, {
      ok: false,
      writtenFiles: [],
      failedFiles: [],
      error: "No files provided to create or update.",
    });
    assert.deepEqual(network.state.data.files, { "app/existing.tsx": "keep me" });
  });

  it("handles missing or expired sandbox cleanly with normalized valid paths and raw invalid paths", async () => {
    const network = createMockNetwork({ "app/existing.tsx": "keep me" });

    const result = await executeCreateOrUpdateFilesTool({
      files: [
        { path: "./app\\page.tsx", content: "hello" },
        { path: "../bad.ts", content: "nope" },
      ],
      sandboxId: "sbx_expired",
      getSandbox: async () => {
        throw new NotFoundError("Sandbox sbx_expired is no longer running");
      },
      network,
      step: {
        run: async (_id, fn) => await fn(),
      },
    });

    assert.notEqual(result, undefined);
    assert.equal(result.ok, false);
    assert.deepEqual(result.writtenFiles, []);
    assert.deepEqual(result.failedFiles, [
      { path: "app/page.tsx", error: "Sandbox sbx_expired is no longer running" },
      { path: "../bad.ts", error: "Sandbox sbx_expired is no longer running" },
    ]);
    assert.ok(result.error?.includes("Sandbox connection failed"));
    assert.deepEqual(network.state.data.files, { "app/existing.tsx": "keep me" });
  });

  it("keeps state consistent under repeated idempotent delta application", async () => {
    const memoizedStep: CreateOrUpdateFilesStepResult = {
      ok: true,
      writtenFiles: ["app/page.tsx", "components/card.tsx"],
      failedFiles: [],
      delta: {
        "app/page.tsx": "v2",
        "components/card.tsx": "card",
      },
    };
    const network = createMockNetwork({
      "app/layout.tsx": "layout",
      "app/page.tsx": "v1",
    });
    const replayStep = {
      run: async () => memoizedStep,
    };
    const unusedSandbox = async (): Promise<FilesSandbox> => {
      throw new Error("should not be called");
    };

    await executeCreateOrUpdateFilesTool({
      files: [{ path: "app/page.tsx", content: "v2" }],
      sandboxId: "sbx_1",
      getSandbox: unusedSandbox,
      network,
      step: replayStep,
    });
    const stateAfterFirstApply = { ...network.state.data.files };

    await executeCreateOrUpdateFilesTool({
      files: [{ path: "app/page.tsx", content: "v2" }],
      sandboxId: "sbx_1",
      getSandbox: unusedSandbox,
      network,
      step: replayStep,
    });

    assert.deepEqual(network.state.data.files, stateAfterFirstApply);
    assert.deepEqual(network.state.data.files, {
      "app/layout.tsx": "layout",
      "app/page.tsx": "v2",
      "components/card.tsx": "card",
    });
  });

  it("does not mutate network.state.data.files inside step.run and replays identically", async () => {
    const memoizedSteps: CreateOrUpdateFilesStepResult[] = [];
    let sandboxWriteCount = 0;

    // Live execution across 2 tool calls (call 2 has a partial failure):
    const liveNetwork = createMockNetwork();
    const liveSandbox = createMockSandbox({}, (path) => {
      sandboxWriteCount++;
      if (path === "components/bad.tsx") {
        throw new Error("Disk write error");
      }
    });

    const recordStep = {
      run: async (
        _id: string,
        fn: () => Promise<CreateOrUpdateFilesStepResult>
      ): Promise<CreateOrUpdateFilesStepResult> => {
        const snapshotBefore = { ...liveNetwork.state.data.files };
        const stepOutput = await fn();
        // Verify network.state.data.files was NOT mutated inside step.run:
        assert.deepEqual(liveNetwork.state.data.files, snapshotBefore);
        memoizedSteps.push(structuredClone(stepOutput));
        return stepOutput;
      },
    };

    const call1Live = await executeCreateOrUpdateFilesTool({
      files: [{ path: "app/page.tsx", content: "v1" }],
      sandboxId: "sbx_1",
      getSandbox: async () => liveSandbox,
      network: liveNetwork,
      step: recordStep,
    });
    const call2Live = await executeCreateOrUpdateFilesTool({
      files: [
        { path: "components/good.tsx", content: "good" },
        { path: "components/bad.tsx", content: "bad" },
      ],
      sandboxId: "sbx_1",
      getSandbox: async () => liveSandbox,
      network: liveNetwork,
      step: recordStep,
    });

    assert.equal(call1Live.ok, true);
    assert.equal(call2Live.ok, false);
    // Step 2 memoized ONLY the step 2 delta (not step 1's app/page.tsx):
    assert.deepEqual(memoizedSteps[1].delta, { "components/good.tsx": "good" });
    assert.deepEqual(liveNetwork.state.data.files, {
      "app/page.tsx": "v1",
      "components/good.tsx": "good",
    });

    // Simulate Inngest replay with a fresh state and memoized step outputs (zero E2B calls):
    const replayNetwork = createMockNetwork();
    let replayIndex = 0;
    const replayStep = {
      run: async () => memoizedSteps[replayIndex++],
    };
    const failIfCalledSandbox = async (): Promise<FilesSandbox> => {
      throw new Error("getSandbox must not run during memoized replay");
    };

    const call1Replay = await executeCreateOrUpdateFilesTool({
      files: [{ path: "app/page.tsx", content: "v1" }],
      sandboxId: "sbx_1",
      getSandbox: failIfCalledSandbox,
      network: replayNetwork,
      step: replayStep,
    });
    const call2Replay = await executeCreateOrUpdateFilesTool({
      files: [
        { path: "components/good.tsx", content: "good" },
        { path: "components/bad.tsx", content: "bad" },
      ],
      sandboxId: "sbx_1",
      getSandbox: failIfCalledSandbox,
      network: replayNetwork,
      step: replayStep,
    });

    assert.equal(sandboxWriteCount, 3);
    assert.deepEqual(call1Replay, call1Live);
    assert.deepEqual(call2Replay, call2Live);
    assert.deepEqual(replayNetwork.state.data.files, liveNetwork.state.data.files);
  });

  it("produces AgentKit-compatible JSON tool_result payloads (never undefined fallback)", async () => {
    const sandbox = createMockSandbox();
    const network = createMockNetwork();

    const handlerReturn: CreateOrUpdateFilesToolResult =
      await executeCreateOrUpdateFilesTool({
        files: [{ path: "package.json", content: "{}" }],
        sandboxId: "sbx_1",
        getSandbox: async () => sandbox,
        network,
      });

    // Mirrors @inngest/agent-kit invokeTools() + OpenAI adapter serialization:
    const agentKitContent = {
      data:
        typeof handlerReturn === "undefined"
          ? "createOrUpdateFiles successfully executed"
          : handlerReturn,
    };
    const serialized = JSON.stringify(agentKitContent);
    const parsed = JSON.parse(serialized) as { data: CreateOrUpdateFilesToolResult };

    assert.notEqual(parsed.data, "createOrUpdateFiles successfully executed");
    assert.equal(parsed.data.ok, false);
    assert.deepEqual(parsed.data.writtenFiles, []);
    assert.equal(parsed.data.failedFiles.length, 1);
    assert.equal(parsed.data.failedFiles[0].path, "package.json");
    assert.equal("delta" in parsed.data, false);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandExitError, TimeoutError } from "@e2b/code-interpreter";

import {
  executeTerminalTool,
  MAX_TERMINAL_OUTPUT_CHARS,
  runTerminalCommand,
  type TerminalCommandResult,
  type TerminalSandbox,
} from "./terminal";

describe("runTerminalCommand", () => {
  it("returns structured stdout on successful execution (exitCode 0)", async () => {
    const sandbox: TerminalSandbox = {
      commands: {
        run: async (_cmd, opts) => {
          opts?.onStdout?.("added 12 packages in 2s\n");
          return {
            exitCode: 0,
            stdout: "added 12 packages in 2s\n",
            stderr: "",
          };
        },
      },
    };

    const result = await runTerminalCommand(sandbox, "npm install lucide-react --yes");

    assert.deepEqual(result, {
      ok: true,
      exitCode: 0,
      stdout: "added 12 packages in 2s\n",
      stderr: "",
    });
    assert.equal("error" in result, false);
    assert.equal("truncated" in result, false);
  });

  it("preserves stderr warnings on successful execution", async () => {
    const sandbox: TerminalSandbox = {
      commands: {
        run: async (_cmd, opts) => {
          opts?.onStdout?.("added 3 packages\n");
          opts?.onStderr?.("npm warn deprecated inflight@1.0.6\n");
          return {
            exitCode: 0,
            stdout: "added 3 packages\n",
            stderr: "npm warn deprecated inflight@1.0.6\n",
          };
        },
      },
    };

    const result = await runTerminalCommand(sandbox, "npm install some-pkg --yes");

    assert.deepEqual(result, {
      ok: true,
      exitCode: 0,
      stdout: "added 3 packages\n",
      stderr: "npm warn deprecated inflight@1.0.6\n",
    });
  });

  it("handles CommandExitError with non-zero exit code, stdout, stderr and error", async () => {
    const sandbox: TerminalSandbox = {
      commands: {
        run: async (_cmd, opts) => {
          opts?.onStdout?.("Resolving packages...\n");
          opts?.onStderr?.("npm error 404 Not Found - nonexistent-pkg\n");
          throw new CommandExitError({
            exitCode: 1,
            stdout: "Resolving packages...\n",
            stderr: "npm error 404 Not Found - nonexistent-pkg\n",
            error: "exit status 1",
          });
        },
      },
    };

    const result = await runTerminalCommand(sandbox, "npm install nonexistent-pkg --yes");

    assert.deepEqual(result, {
      ok: false,
      exitCode: 1,
      stdout: "Resolving packages...\n",
      stderr: "npm error 404 Not Found - nonexistent-pkg\n",
      error: "exit status 1",
    });
  });

  it("falls back to callback buffers when CommandExitError has empty output fields", async () => {
    const sandbox: TerminalSandbox = {
      commands: {
        run: async (_cmd, opts) => {
          opts?.onStdout?.("partial stdout\n");
          opts?.onStderr?.("partial stderr\n");
          throw new CommandExitError({
            exitCode: 127,
            stdout: "",
            stderr: "",
            error: "command not found",
          });
        },
      },
    };

    const result = await runTerminalCommand(sandbox, "badcmd");

    assert.deepEqual(result, {
      ok: false,
      exitCode: 127,
      stdout: "partial stdout\n",
      stderr: "partial stderr\n",
      error: "command not found",
    });
  });

  it("handles E2B TimeoutError and preserves partial streamed stdout/stderr", async () => {
    const sandbox: TerminalSandbox = {
      commands: {
        run: async (_cmd, opts) => {
          opts?.onStdout?.("Downloading tarball...\n");
          opts?.onStderr?.("Waiting on registry...\n");
          throw new TimeoutError("deadline_exceeded after 60000ms");
        },
      },
    };

    const result = await runTerminalCommand(sandbox, "npm install huge-pkg --yes");

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.equal(result.stdout, "Downloading tarball...\n");
    assert.equal(result.stderr, "Waiting on registry...\n");
    assert.equal(result.error, "Command timed out: deadline_exceeded after 60000ms");
  });

  it("handles unexpected non-E2B failures while preserving partial output", async () => {
    const sandbox: TerminalSandbox = {
      commands: {
        run: async (_cmd, opts) => {
          opts?.onStdout?.("step 1\n");
          opts?.onStderr?.("socket reset\n");
          throw new Error("ECONNRESET");
        },
      },
    };

    const result = await runTerminalCommand(sandbox, "npm run check");

    assert.deepEqual(result, {
      ok: false,
      exitCode: null,
      stdout: "step 1\n",
      stderr: "socket reset\n",
      error: "ECONNRESET",
    });
  });

  it("limits stdout and stderr to 8,000 chars each while retaining the tail", async () => {
    const stdoutTail = "FINAL_STDOUT_MARKER_12345";
    const stderrTail = "FINAL_STDERR_ERROR_67890";
    const longStdout = `${"a".repeat(12_000)}${stdoutTail}`;
    const longStderr = `${"e".repeat(12_000)}${stderrTail}`;

    const sandbox: TerminalSandbox = {
      commands: {
        run: async () => ({
          exitCode: 0,
          stdout: longStdout,
          stderr: longStderr,
        }),
      },
    };

    const result = await runTerminalCommand(sandbox, "npm install verbose-pkg --yes");

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, true);
    assert.ok(result.stdout.length <= MAX_TERMINAL_OUTPUT_CHARS);
    assert.ok(result.stderr.length <= MAX_TERMINAL_OUTPUT_CHARS);
    assert.ok(result.stdout.endsWith(stdoutTail));
    assert.ok(result.stderr.endsWith(stderrTail));
    assert.ok(result.stdout.includes("truncated"));
    assert.ok(result.stderr.includes("truncated"));
  });

  it("truncates oversized stderr on CommandExitError while keeping the error tail", async () => {
    const errorTail = "ERR! ERESOLVE unable to resolve dependency tree";
    const longStderr = `${"x".repeat(15_000)}${errorTail}`;

    const sandbox: TerminalSandbox = {
      commands: {
        run: async () => {
          throw new CommandExitError({
            exitCode: 1,
            stdout: "",
            stderr: longStderr,
            error: "exit status 1",
          });
        },
      },
    };

    const result = await runTerminalCommand(sandbox, "npm install conflicting-pkg --yes");

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.truncated, true);
    assert.ok(result.stderr.length <= MAX_TERMINAL_OUTPUT_CHARS);
    assert.ok(result.stderr.endsWith(errorTail));
  });
});

describe("executeTerminalTool", () => {
  it("runs inside Inngest step.run when step is provided", async () => {
    const calledSteps: string[] = [];
    const mockSandbox: TerminalSandbox = {
      commands: {
        run: async () => ({
          exitCode: 0,
          stdout: "/home/user\n",
          stderr: "",
        }),
      },
    };

    const result = await executeTerminalTool({
      command: "pwd",
      sandboxId: "sbx_123",
      getSandbox: async (id) => {
        assert.equal(id, "sbx_123");
        return mockSandbox;
      },
      step: {
        run: async (id, fn) => {
          calledSteps.push(id);
          return await fn();
        },
      },
    });

    assert.deepEqual(calledSteps, ["terminal"]);
    assert.deepEqual(result, {
      ok: true,
      exitCode: 0,
      stdout: "/home/user\n",
      stderr: "",
    });
  });

  it("still executes and returns structured output when step is undefined", async () => {
    let executedCommand = "";
    const mockSandbox: TerminalSandbox = {
      commands: {
        run: async (cmd) => {
          executedCommand = cmd;
          return {
            exitCode: 0,
            stdout: "ok\n",
            stderr: "",
          };
        },
      },
    };

    const result = await executeTerminalTool({
      command: "echo ok",
      sandboxId: "sbx_123",
      getSandbox: async () => mockSandbox,
      step: undefined,
    });

    assert.equal(executedCommand, "echo ok");
    assert.notEqual(result, undefined);
    assert.deepEqual(result, {
      ok: true,
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
    });
  });

  it("returns structured error instead of undefined or throwing when getSandbox fails", async () => {
    const result = await executeTerminalTool({
      command: "ls",
      sandboxId: "sbx_expired",
      getSandbox: async () => {
        throw new Error("Sandbox sbx_expired not found");
      },
      step: {
        run: async (_id, fn) => await fn(),
      },
    });

    assert.deepEqual(result, {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: "Sandbox sbx_expired not found",
    });
  });

  it("produces AgentKit-compatible JSON tool_result payloads (never undefined fallback)", async () => {
    const mockSandbox: TerminalSandbox = {
      commands: {
        run: async () => {
          throw new CommandExitError({
            exitCode: 2,
            stdout: "",
            stderr: "SyntaxError: Unexpected token",
            error: "exit status 2",
          });
        },
      },
    };

    const handlerReturn: TerminalCommandResult = await executeTerminalTool({
      command: "node bad.js",
      sandboxId: "sbx_123",
      getSandbox: async () => mockSandbox,
    });

    // Mirrors @inngest/agent-kit invokeTools() + OpenAI adapter serialization:
    const agentKitContent = {
      data:
        typeof handlerReturn === "undefined"
          ? "terminal successfully executed"
          : handlerReturn,
    };
    const serialized = JSON.stringify(agentKitContent);
    const parsed = JSON.parse(serialized) as { data: TerminalCommandResult };

    assert.notEqual(parsed.data, "terminal successfully executed");
    assert.equal(parsed.data.ok, false);
    assert.equal(parsed.data.exitCode, 2);
    assert.equal(parsed.data.stderr, "SyntaxError: Unexpected token");
    assert.equal(parsed.data.error, "exit status 2");
  });
});

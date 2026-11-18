import {
  CommandExitError,
  type CommandResult,
  type CommandStartOpts,
  TimeoutError,
} from "@e2b/code-interpreter";

export const MAX_TERMINAL_OUTPUT_CHARS = 8_000;

const TRUNCATION_NOTICE = "...[output truncated, showing tail]...\n";

export interface TerminalCommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  truncated?: boolean;
}

export interface TerminalSandbox {
  commands: {
    run: (
      cmd: string,
      opts?: Pick<CommandStartOpts, "onStdout" | "onStderr" | "timeoutMs">
    ) => Promise<CommandResult>;
  };
}

export interface TerminalStepLike {
  run: (
    id: string,
    fn: () => Promise<TerminalCommandResult>
  ) => Promise<TerminalCommandResult>;
}

export interface RunTerminalCommandOptions {
  maxOutputChars?: number;
  timeoutMs?: number;
}

export interface ExecuteTerminalToolParams {
  command: string;
  sandboxId: string;
  getSandbox: (sandboxId: string) => Promise<TerminalSandbox>;
  step?: TerminalStepLike;
  options?: RunTerminalCommandOptions;
}

function truncateTail(
  text: string,
  maxChars = MAX_TERMINAL_OUTPUT_CHARS
): { value: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { value: text, truncated: false };
  }

  if (maxChars <= TRUNCATION_NOTICE.length) {
    return { value: text.slice(-maxChars), truncated: true };
  }

  const tailLength = maxChars - TRUNCATION_NOTICE.length;
  return {
    value: `${TRUNCATION_NOTICE}${text.slice(-tailLength)}`,
    truncated: true,
  };
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

export async function runTerminalCommand(
  sandbox: TerminalSandbox,
  command: string,
  options?: RunTerminalCommandOptions
): Promise<TerminalCommandResult> {
  const maxOutputChars = options?.maxOutputChars ?? MAX_TERMINAL_OUTPUT_CHARS;
  const buffers = { stdout: "", stderr: "" };

  try {
    const result = await sandbox.commands.run(command, {
      onStdout: (data: string) => {
        buffers.stdout += data;
      },
      onStderr: (data: string) => {
        buffers.stderr += data;
      },
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

    const stdout = truncateTail(result.stdout || buffers.stdout, maxOutputChars);
    const stderr = truncateTail(result.stderr || buffers.stderr, maxOutputChars);

    return {
      ok: true,
      exitCode: result.exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
    };
  } catch (err) {
    if (err instanceof CommandExitError) {
      const stdout = truncateTail(err.stdout || buffers.stdout, maxOutputChars);
      const stderr = truncateTail(err.stderr || buffers.stderr, maxOutputChars);

      return {
        ok: false,
        exitCode: err.exitCode,
        stdout: stdout.value,
        stderr: stderr.value,
        error: err.error || err.message || `Command exited with code ${err.exitCode}`,
        ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
      };
    }

    const stdout = truncateTail(buffers.stdout, maxOutputChars);
    const stderr = truncateTail(buffers.stderr, maxOutputChars);

    if (err instanceof TimeoutError) {
      const detail = formatErrorMessage(err);
      const errorMessage = detail.toLowerCase().includes("timed out") || detail.toLowerCase().includes("timeout")
        ? detail
        : `Command timed out: ${detail}`;

      return {
        ok: false,
        exitCode: null,
        stdout: stdout.value,
        stderr: stderr.value,
        error: errorMessage,
        ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
      };
    }

    return {
      ok: false,
      exitCode: null,
      stdout: stdout.value,
      stderr: stderr.value,
      error: formatErrorMessage(err),
      ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
    };
  }
}

export async function executeTerminalTool({
  command,
  sandboxId,
  getSandbox,
  step,
  options,
}: ExecuteTerminalToolParams): Promise<TerminalCommandResult> {
  const run = async (): Promise<TerminalCommandResult> => {
    try {
      const sandbox = await getSandbox(sandboxId);
      return await runTerminalCommand(sandbox, command, options);
    } catch (err) {
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        error: formatErrorMessage(err),
      };
    }
  };

  return step ? await step.run("terminal", run) : await run();
}

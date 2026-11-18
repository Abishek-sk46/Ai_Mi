import {
  AuthenticationError,
  type EntryInfo,
  NotEnoughSpaceError,
  NotFoundError,
  TimeoutError,
} from "@e2b/code-interpreter";

const PROTECTED_FILENAMES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
]);

export interface FileWriteInput {
  readonly path: string;
  readonly content: string;
}

export interface FailedFileEntry {
  path: string;
  error: string;
}

export interface CreateOrUpdateFilesToolResult {
  ok: boolean;
  writtenFiles: string[];
  failedFiles: FailedFileEntry[];
  error?: string;
}

export interface CreateOrUpdateFilesStepResult extends CreateOrUpdateFilesToolResult {
  delta: Record<string, string>;
}

export interface FilesSandbox {
  files: {
    write: (path: string, data: string) => Promise<EntryInfo>;
  };
}

export interface FilesNetworkLike {
  state: {
    data: {
      files: Record<string, string>;
    };
  };
}

export interface FilesStepLike {
  run: (
    id: string,
    fn: () => Promise<CreateOrUpdateFilesStepResult>
  ) => Promise<CreateOrUpdateFilesStepResult>;
}

export interface ExecuteCreateOrUpdateFilesToolParams {
  files: readonly FileWriteInput[];
  sandboxId: string;
  getSandbox: (sandboxId: string) => Promise<FilesSandbox>;
  network?: FilesNetworkLike;
  step?: FilesStepLike;
}

export type PathValidationResult =
  | { ok: true; normalizedPath: string }
  | { ok: false; error: string };

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

/**
 * Strips a single outer Markdown code fence only when the entire content is
 * wrapped in one. Preserves legitimate triple backticks inside source code.
 */
export function stripOuterCodeFence(content: string): string {
  if (content.length === 0) {
    return content;
  }

  const trimmed = content.trim();
  const lines = trimmed.split(/\r?\n/);

  if (lines.length < 2) {
    return content;
  }

  const firstLine = lines[0].trim();
  const lastLine = lines[lines.length - 1].trim();

  if (!/^```[a-zA-Z0-9_+-]*$/.test(firstLine) || !/^```$/.test(lastLine)) {
    return content;
  }

  const innerLines = lines.slice(1, -1);

  // If the outer fence closes early and another fenced block opens later
  // (e.g., a Markdown document containing multiple code blocks), do not strip.
  let sawInnerClosingFence = false;
  for (const line of innerLines) {
    if (!sawInnerClosingFence && /^```$/.test(line.trim())) {
      sawInnerClosingFence = true;
    } else if (sawInnerClosingFence && /^```[a-zA-Z0-9_+-]*$/.test(line.trim())) {
      return content;
    }
  }

  return innerLines.join("\n");
}

/**
 * Validates and normalizes a project-relative file path before writing to E2B.
 */
export function validateAndNormalizeFilePath(rawPath: string): PathValidationResult {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return { ok: false, error: "File path must be a non-empty string." };
  }

  if (rawPath.includes("\0")) {
    return { ok: false, error: "File path contains invalid null byte." };
  }

  let normalized = rawPath.trim().replace(/\\/g, "/");

  if (/^[A-Za-z]:/.test(normalized)) {
    return { ok: false, error: `Absolute Windows path is not allowed: "${rawPath}".` };
  }

  if (normalized.startsWith("/")) {
    return {
      ok: false,
      error: `Absolute path is not allowed; use a project-relative path instead: "${rawPath}".`,
    };
  }

  if (normalized === "@" || normalized.startsWith("@/")) {
    return {
      ok: false,
      error: `Import alias "@" cannot be used as a file path: "${rawPath}".`,
    };
  }

  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  if (normalized.length === 0 || normalized === "." || normalized.endsWith("/")) {
    return {
      ok: false,
      error: `File path must target a file, not a directory: "${rawPath}".`,
    };
  }

  const segments = normalized.split("/");
  const cleanSegments: string[] = [];

  for (const segment of segments) {
    if (segment === "") {
      continue;
    }
    if (segment === ".." || segment === ".") {
      return {
        ok: false,
        error: `Path traversal or relative dot segments are not allowed: "${rawPath}".`,
      };
    }
    cleanSegments.push(segment);
  }

  if (cleanSegments.length === 0) {
    return { ok: false, error: `Invalid file path: "${rawPath}".` };
  }

  normalized = cleanSegments.join("/");

  const lowerSegments = cleanSegments.map((s) => s.toLowerCase());
  if (lowerSegments.includes(".git")) {
    return { ok: false, error: `Modifying .git internals is not allowed: "${normalized}".` };
  }

  const filename = lowerSegments[lowerSegments.length - 1];
  if (PROTECTED_FILENAMES.has(filename)) {
    return {
      ok: false,
      error: `Modifying protected file "${normalized}" is not allowed; use the terminal tool to manage packages.`,
    };
  }

  return { ok: true, normalizedPath: normalized };
}

function resolveFailurePath(rawPath: string): string {
  const validation = validateAndNormalizeFilePath(rawPath);
  return validation.ok ? validation.normalizedPath : rawPath;
}

function isFatalSandboxError(err: unknown): boolean {
  return (
    err instanceof TimeoutError ||
    err instanceof AuthenticationError ||
    err instanceof NotFoundError ||
    err instanceof NotEnoughSpaceError
  );
}

/**
 * Pure helper that validates paths, unwraps accidental outer code fences,
 * writes each file independently to the sandbox, and returns a structured
 * delta + per-file success/failure report without mutating caller inputs.
 */
export async function runCreateOrUpdateFiles(
  sandbox: FilesSandbox,
  files: readonly FileWriteInput[]
): Promise<CreateOrUpdateFilesStepResult> {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: false,
      writtenFiles: [],
      failedFiles: [],
      delta: {},
      error: "No files provided to create or update.",
    };
  }

  const delta: Record<string, string> = {};
  const writtenFiles: string[] = [];
  const writtenSet = new Set<string>();
  const failedFiles: FailedFileEntry[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const validation = validateAndNormalizeFilePath(file.path);

    if (!validation.ok) {
      failedFiles.push({ path: file.path, error: validation.error });
      continue;
    }

    const targetPath = validation.normalizedPath;
    const sanitizedContent = stripOuterCodeFence(file.content);

    try {
      await sandbox.files.write(targetPath, sanitizedContent);
      delta[targetPath] = sanitizedContent;
      if (!writtenSet.has(targetPath)) {
        writtenSet.add(targetPath);
        writtenFiles.push(targetPath);
      }
    } catch (err) {
      const errorMessage = formatErrorMessage(err);
      failedFiles.push({ path: targetPath, error: errorMessage });

      // If the sandbox timed out, lost auth, disappeared, or ran out of disk space,
      // abort remaining writes rather than repeating failures, while preserving earlier successes.
      if (isFatalSandboxError(err)) {
        for (let j = i + 1; j < files.length; j++) {
          const remaining = files[j];
          failedFiles.push({
            path: resolveFailurePath(remaining.path),
            error: `Skipped after fatal sandbox error: ${errorMessage}`,
          });
        }
        break;
      }
    }
  }

  if (failedFiles.length > 0) {
    const errorSummary =
      failedFiles.length === 1
        ? `Failed to write "${failedFiles[0].path}": ${failedFiles[0].error}`
        : `Failed to write ${failedFiles.length} of ${files.length} files.`;

    return {
      ok: false,
      writtenFiles,
      failedFiles,
      delta,
      error: errorSummary,
    };
  }

  return {
    ok: true,
    writtenFiles,
    failedFiles: [],
    delta,
  };
}

/**
 * Tool-layer executor for AgentKit + Inngest.
 * - Runs file writes inside `step.run` when `step` is provided, or directly when absent.
 * - Memoizes only the newly written file delta inside `step.run` (never mutating `network.state.data.files` inside the step).
 * - Deterministically merges the delta into `network.state.data.files` outside `step.run` so Inngest replays stay consistent.
 * - Always returns a structured result object to the AI agent (never `undefined`).
 */
export async function executeCreateOrUpdateFilesTool({
  files,
  sandboxId,
  getSandbox,
  network,
  step,
}: ExecuteCreateOrUpdateFilesToolParams): Promise<CreateOrUpdateFilesToolResult> {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: false,
      writtenFiles: [],
      failedFiles: [],
      error: "No files provided to create or update.",
    };
  }

  const execute = async (): Promise<CreateOrUpdateFilesStepResult> => {
    try {
      const sandbox = await getSandbox(sandboxId);
      return await runCreateOrUpdateFiles(sandbox, files);
    } catch (err) {
      const errorMessage = formatErrorMessage(err);
      return {
        ok: false,
        writtenFiles: [],
        failedFiles: files.map((file) => ({
          path: resolveFailurePath(file.path),
          error: errorMessage,
        })),
        delta: {},
        error: `Sandbox connection failed: ${errorMessage}`,
      };
    }
  };

  const stepResult = step
    ? await step.run("CreateOrUpdateFiles", execute)
    : await execute();

  if (network && Object.keys(stepResult.delta).length > 0) {
    network.state.data.files = {
      ...(network.state.data.files || {}),
      ...stepResult.delta,
    };
  }

  return {
    ok: stepResult.ok,
    writtenFiles: stepResult.writtenFiles,
    failedFiles: stepResult.failedFiles,
    ...(stepResult.error !== undefined ? { error: stepResult.error } : {}),
  };
}

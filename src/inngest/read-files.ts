import {
  AuthenticationError,
  NotFoundError,
  TimeoutError,
} from "@e2b/code-interpreter";

export interface ReadFileEntry {
  path: string;
  content: string;
}

export interface FailedReadEntry {
  path: string;
  error: string;
}

export interface ReadFilesToolResult {
  ok: boolean;
  files: ReadFileEntry[];
  failedFiles: FailedReadEntry[];
  error?: string;
}

export interface ReadFilesSandbox {
  files: {
    read: (path: string) => Promise<string>;
  };
}

export interface ReadFilesStepLike {
  run: (
    id: string,
    fn: () => Promise<ReadFilesToolResult>
  ) => Promise<ReadFilesToolResult>;
}

export interface ExecuteReadFilesToolParams {
  files: readonly string[];
  sandboxId: string;
  getSandbox: (sandboxId: string) => Promise<ReadFilesSandbox>;
  step?: ReadFilesStepLike;
}

export type ReadPathValidationResult =
  | { ok: true; normalizedPath: string }
  | { ok: false; error: string };

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

/**
 * Validates and normalizes a project-relative path for read-only sandbox access.
 * Unlike the write validator, read-only access to `package.json` and lockfiles
 * is permitted so the agent can inspect installed dependencies.
 */
export function validateAndNormalizeReadPath(rawPath: string): ReadPathValidationResult {
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
      error: `Import alias "@" cannot be used as a filesystem path: "${rawPath}".`,
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
    return { ok: false, error: `Reading .git internals is not allowed: "${normalized}".` };
  }

  return { ok: true, normalizedPath: normalized };
}

function resolveReadFailurePath(rawPath: string): string {
  const validation = validateAndNormalizeReadPath(rawPath);
  return validation.ok ? validation.normalizedPath : rawPath;
}

const SANDBOX_UNAVAILABLE_NOT_FOUND_RE =
  /(?:^|[\s:])(?:the\s+)?sandbox(?:\s+[a-z0-9_-]+)?\s+(?:is\s+(?:probably\s+)?(?:not\s+running|no\s+longer\s+running|unavailable|stopped|terminated|expired)|was\s+not\s+found|has\s+(?:expired|stopped|terminated)|not\s+found|not\s+running|expired|stopped|terminated|unavailable)\b/i;

export function isSandboxUnavailableError(err: unknown): boolean {
  if (err instanceof TimeoutError || err instanceof AuthenticationError) {
    return true;
  }

  // E2B's NotFoundError has no structured error code (only `name` and `message`).
  // Distinguish sandbox-level unavailability messages (e.g. "Sandbox is probably
  // not running anymore", "The sandbox ... was not found") from per-file 404s.
  if (err instanceof NotFoundError) {
    return SANDBOX_UNAVAILABLE_NOT_FOUND_RE.test(err.message);
  }

  return false;
}

/**
 * Pure helper that validates paths, reads each file independently from the
 * sandbox, preserves successful reads on partial failures, and returns
 * structured normalized results.
 */
export async function runReadFiles(
  sandbox: ReadFilesSandbox,
  filePaths: readonly string[]
): Promise<ReadFilesToolResult> {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return {
      ok: false,
      files: [],
      failedFiles: [],
      error: "No file paths provided to read.",
    };
  }

  const readFiles: ReadFileEntry[] = [];
  const failedFiles: FailedReadEntry[] = [];
  const seenPaths = new Set<string>();
  let fatalSandboxErrorMessage: string | null = null;

  for (let i = 0; i < filePaths.length; i++) {
    const rawPath = filePaths[i];
    const validation = validateAndNormalizeReadPath(rawPath);

    if (!validation.ok) {
      failedFiles.push({ path: rawPath, error: validation.error });
      continue;
    }

    const targetPath = validation.normalizedPath;
    if (seenPaths.has(targetPath)) {
      continue;
    }
    seenPaths.add(targetPath);

    try {
      const content = await sandbox.files.read(targetPath);
      readFiles.push({ path: targetPath, content });
    } catch (err) {
      const errorMessage = formatErrorMessage(err);
      failedFiles.push({ path: targetPath, error: errorMessage });

      if (isSandboxUnavailableError(err)) {
        fatalSandboxErrorMessage = errorMessage;
        for (let j = i + 1; j < filePaths.length; j++) {
          const remaining = filePaths[j];
          const remainingResolved = resolveReadFailurePath(remaining);
          if (seenPaths.has(remainingResolved)) {
            continue;
          }
          failedFiles.push({
            path: remainingResolved,
            error: `Skipped after fatal sandbox error: ${errorMessage}`,
          });
        }
        break;
      }
    }
  }

  // Sandbox-level failures MUST fail closed (ok: false), even if earlier files
  // were read before the sandbox became unavailable (preserve those in `files`
  // for diagnostics).
  if (fatalSandboxErrorMessage !== null) {
    return {
      ok: false,
      files: readFiles,
      failedFiles,
      error: `Sandbox unavailable while reading files: ${fatalSandboxErrorMessage}`,
    };
  }

  // Partial success for individual missing/invalid files: if at least one file
  // was read and the sandbox remained healthy, keep ok: true while reporting
  // individual failures in failedFiles.
  if (readFiles.length > 0) {
    return {
      ok: true,
      files: readFiles,
      failedFiles,
    };
  }

  const errorSummary =
    failedFiles.length === 1
      ? `Failed to read "${failedFiles[0].path}": ${failedFiles[0].error}`
      : `Failed to read all ${failedFiles.length} requested files.`;

  return {
    ok: false,
    files: [],
    failedFiles,
    error: errorSummary,
  };
}

/**
 * Tool-layer executor for AgentKit + Inngest.
 * - Rejects empty input before entering `step.run`.
 * - Runs inside `step.run("readFiles", ...)` when `step` is provided, or directly when absent.
 * - Catches sandbox connection failures and never returns `undefined`.
 */
export async function executeReadFilesTool({
  files,
  sandboxId,
  getSandbox,
  step,
}: ExecuteReadFilesToolParams): Promise<ReadFilesToolResult> {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: false,
      files: [],
      failedFiles: [],
      error: "No file paths provided to read.",
    };
  }

  const execute = async (): Promise<ReadFilesToolResult> => {
    try {
      const sandbox = await getSandbox(sandboxId);
      return await runReadFiles(sandbox, files);
    } catch (err) {
      const errorMessage = formatErrorMessage(err);
      return {
        ok: false,
        files: [],
        failedFiles: files.map((filePath) => ({
          path: resolveReadFailurePath(filePath),
          error: errorMessage,
        })),
        error: `Sandbox connection failed: ${errorMessage}`,
      };
    }
  };

  return step ? await step.run("readFiles", execute) : await execute();
}

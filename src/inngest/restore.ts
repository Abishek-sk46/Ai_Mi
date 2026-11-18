import type { EntryInfo } from "@e2b/code-interpreter";

import {
  type CreateOrUpdateFilesToolResult,
  validateAndNormalizeFilePath,
} from "./files";
import type { TerminalCommandResult } from "./terminal";

export const RESTORE_BATCH_SIZE = 25;

const PROTECTED_PACKAGE_FILENAMES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
]);

const PACKAGE_MANAGER_COMMAND_RE =
  /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|rm|un|uninstall|update|upgrade)\b/i;

export interface RestoreWriteEntry {
  path: string;
  data: string;
}

export interface RestoreSandbox {
  files: {
    write: (files: RestoreWriteEntry[]) => Promise<EntryInfo[]>;
  };
}

export interface HistoricalFragmentRecord {
  id: string;
  files: unknown;
}

export interface FragmentQueryClient {
  fragment: {
    findMany: (args: {
      where: {
        message: {
          projectId: string;
          role: "ASSISTANT";
          type: "RESULT";
        };
      };
      orderBy: [{ createdAt: "asc" }, { id: "asc" }];
      select: {
        id: true;
        files: true;
      };
    }) => Promise<HistoricalFragmentRecord[]>;
  };
}

export interface InvalidSnapshotEntry {
  path: string;
  reason: string;
}

export interface InvalidHistoricalEntry extends InvalidSnapshotEntry {
  fragmentId: string;
}

export interface ParsedFileSnapshot {
  files: Record<string, string>;
  invalidEntries: InvalidSnapshotEntry[];
  isValidObject: boolean;
}

export interface ReconstructedProjectSnapshot {
  files: Record<string, string>;
  fragmentCount: number;
  latestFragmentId: string | null;
  invalidHistoricalEntries: InvalidHistoricalEntry[];
}

export interface FailedRestoreEntry {
  path: string;
  error: string;
}

export interface RestoreFilesResult {
  ok: boolean;
  restoredFiles: string[];
  failedFiles: FailedRestoreEntry[];
  batchesExecuted: number;
  error?: string;
}

export interface RestoreStepLike {
  run: (
    id: string,
    fn: () => Promise<RestoreFilesResult>
  ) => Promise<RestoreFilesResult>;
}

export interface ExecuteRestoreProjectFilesParams {
  files: Record<string, string>;
  sandboxId: string;
  getSandbox: (sandboxId: string) => Promise<RestoreSandbox>;
  step?: RestoreStepLike;
  batchSize?: number;
}

export interface GenerationOutcomeInput {
  summary: string;
  files: Record<string, string> | undefined;
  restoredFileCount: number;
  unresolvedFileErrors: Record<string, string>;
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

/**
 * Validates and normalizes a single Fragment.files JSON payload.
 * Preserves valid empty file contents ("") and reports invalid paths/values.
 */
export function parseFileSnapshot(rawFiles: unknown): ParsedFileSnapshot {
  if (typeof rawFiles !== "object" || rawFiles === null || Array.isArray(rawFiles)) {
    return {
      files: {},
      invalidEntries: [],
      isValidObject: false,
    };
  }

  const files: Record<string, string> = {};
  const invalidEntries: InvalidSnapshotEntry[] = [];

  for (const [rawPath, rawContent] of Object.entries(rawFiles)) {
    const validation = validateAndNormalizeFilePath(rawPath);
    if (!validation.ok) {
      invalidEntries.push({ path: rawPath, reason: validation.error });
      continue;
    }

    if (typeof rawContent !== "string") {
      invalidEntries.push({
        path: validation.normalizedPath,
        reason: `File content must be a string (received ${rawContent === null ? "null" : typeof rawContent}).`,
      });
      continue;
    }

    files[validation.normalizedPath] = rawContent;
  }

  return {
    files,
    invalidEntries,
    isValidObject: true,
  };
}

/**
 * Reconstructs a complete cumulative project snapshot by merging historical
 * ASSISTANT + RESULT fragments oldest-to-newest so later file versions override
 * earlier ones while preserving untouched files from legacy delta-only fragments.
 */
export function reconstructProjectFiles(
  fragments: readonly HistoricalFragmentRecord[]
): ReconstructedProjectSnapshot {
  const mergedFiles: Record<string, string> = {};
  const invalidHistoricalEntries: InvalidHistoricalEntry[] = [];

  for (const fragment of fragments) {
    const parsed = parseFileSnapshot(fragment.files);

    if (!parsed.isValidObject) {
      invalidHistoricalEntries.push({
        fragmentId: fragment.id,
        path: "<snapshot>",
        reason: "Fragment files value is not a plain object.",
      });
      continue;
    }

    for (const entry of parsed.invalidEntries) {
      invalidHistoricalEntries.push({
        fragmentId: fragment.id,
        path: entry.path,
        reason: entry.reason,
      });
    }

    for (const [filePath, content] of Object.entries(parsed.files)) {
      mergedFiles[filePath] = content;
    }
  }

  return {
    files: mergedFiles,
    fragmentCount: fragments.length,
    latestFragmentId:
      fragments.length > 0 ? fragments[fragments.length - 1].id : null,
    invalidHistoricalEntries,
  };
}

/**
 * Retrieves all successful historical fragments (ASSISTANT + RESULT) for a
 * project in deterministic oldest-to-newest order and reconstructs the latest
 * cumulative project file snapshot.
 *
 * Database errors are intentionally NOT swallowed so Inngest retries transient
 * DB failures instead of silently wiping a project's restored state.
 */
export async function loadProjectFileSnapshot(
  db: FragmentQueryClient,
  projectId: string
): Promise<ReconstructedProjectSnapshot> {
  const fragments = await db.fragment.findMany({
    where: {
      message: {
        projectId,
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

  return reconstructProjectFiles(fragments);
}

/**
 * Restores validated project files into an E2B sandbox using chunked batch
 * writes (`sandbox.files.write(WriteEntry[])`).
 *
 * Fails closed: if any entry is invalid or any batch fails, subsequent batches
 * are not executed and `ok: false` is returned.
 */
export async function restoreFilesToSandbox(
  sandbox: RestoreSandbox,
  files: Record<string, string>,
  batchSize = RESTORE_BATCH_SIZE
): Promise<RestoreFilesResult> {
  const rawEntries = Object.entries(files);
  if (rawEntries.length === 0) {
    return {
      ok: true,
      restoredFiles: [],
      failedFiles: [],
      batchesExecuted: 0,
    };
  }

  const effectiveBatchSize = Math.max(1, Math.floor(batchSize));
  const validatedEntries: RestoreWriteEntry[] = [];
  const invalidFiles: FailedRestoreEntry[] = [];

  for (const [rawPath, content] of rawEntries) {
    const validation = validateAndNormalizeFilePath(rawPath);
    if (!validation.ok) {
      invalidFiles.push({ path: rawPath, error: validation.error });
      continue;
    }
    if (typeof content !== "string") {
      invalidFiles.push({
        path: validation.normalizedPath,
        error: "File content must be a string.",
      });
      continue;
    }
    validatedEntries.push({ path: validation.normalizedPath, data: content });
  }

  if (invalidFiles.length > 0) {
    return {
      ok: false,
      restoredFiles: [],
      failedFiles: invalidFiles,
      batchesExecuted: 0,
      error: `Refused to restore snapshot containing ${invalidFiles.length} invalid file entries.`,
    };
  }

  const restoredFiles: string[] = [];
  let batchesExecuted = 0;

  for (let offset = 0; offset < validatedEntries.length; offset += effectiveBatchSize) {
    const chunk = validatedEntries.slice(offset, offset + effectiveBatchSize);

    try {
      await sandbox.files.write(chunk);
      batchesExecuted += 1;
      for (const entry of chunk) {
        restoredFiles.push(entry.path);
      }
    } catch (err) {
      const errorMessage = formatErrorMessage(err);
      const failedFiles: FailedRestoreEntry[] = chunk.map((entry) => ({
        path: entry.path,
        error: errorMessage,
      }));

      for (let rest = offset + effectiveBatchSize; rest < validatedEntries.length; rest++) {
        failedFiles.push({
          path: validatedEntries[rest].path,
          error: `Skipped after restoration batch failure: ${errorMessage}`,
        });
      }

      return {
        ok: false,
        restoredFiles,
        failedFiles,
        batchesExecuted,
        error: `Failed to restore project files (batch ${batchesExecuted + 1}): ${errorMessage}`,
      };
    }
  }

  return {
    ok: true,
    restoredFiles,
    failedFiles: [],
    batchesExecuted,
  };
}

/**
 * Inngest step wrapper for restoring reconstructed project files into a newly
 * created sandbox.
 *
 * - Skips step creation and sandbox connection when `files` is empty.
 * - Executes inside `step.run("restore-previous-files", ...)` when `step` is
 *   provided, or directly when absent.
 * - Catches sandbox connection errors and returns a structured fail-closed result.
 */
export async function executeRestoreProjectFiles({
  files,
  sandboxId,
  getSandbox,
  step,
  batchSize = RESTORE_BATCH_SIZE,
}: ExecuteRestoreProjectFilesParams): Promise<RestoreFilesResult> {
  const filePaths = Object.keys(files);
  if (filePaths.length === 0) {
    return {
      ok: true,
      restoredFiles: [],
      failedFiles: [],
      batchesExecuted: 0,
    };
  }

  const execute = async (): Promise<RestoreFilesResult> => {
    try {
      const sandbox = await getSandbox(sandboxId);
      return await restoreFilesToSandbox(sandbox, files, batchSize);
    } catch (err) {
      const errorMessage = formatErrorMessage(err);
      return {
        ok: false,
        restoredFiles: [],
        failedFiles: filePaths.map((path) => {
          const validation = validateAndNormalizeFilePath(path);
          return {
            path: validation.ok ? validation.normalizedPath : path,
            error: errorMessage,
          };
        }),
        batchesExecuted: 0,
        error: `Sandbox connection failed during restoration: ${errorMessage}`,
      };
    }
  };

  return step ? await step.run("restore-previous-files", execute) : await execute();
}

/**
 * Appends a concise restored-file manifest (paths only, never full source code)
 * to the coding agent's system prompt so follow-up runs inspect and edit
 * existing files rather than rebuilding from scratch.
 */
export function buildAgentSystemPrompt(
  basePrompt: string,
  restoredFilePaths: readonly string[]
): string {
  if (restoredFilePaths.length === 0) {
    return basePrompt;
  }

  const sortedPaths = [...new Set(restoredFilePaths)].sort();
  const pathList = sortedPaths.map((p) => `- ${p}`).join("\n");

  return [
    basePrompt.trimEnd(),
    "",
    "Existing Project Context (Restored Files):",
    "The following project files from previous versions have already been restored into /home/user:",
    pathList,
    "",
    "Follow-up Editing Instructions:",
    "- Inspect relevant existing files with readFiles before modifying them.",
    "- Make targeted edits with createOrUpdateFiles rather than recreating unrelated files from scratch.",
    "- Untouched restored files are automatically preserved in the saved project snapshot.",
  ].join("\n");
}

function deriveRecoverableTargetPath(rawPath: string): string | null {
  const normalized = rawPath.trim().replace(/\\/g, "/");

  let candidate: string | null = null;
  if (normalized.startsWith("/home/user/")) {
    candidate = normalized.slice("/home/user/".length);
  } else if (normalized.startsWith("@/")) {
    candidate = normalized.slice(2);
  }

  if (!candidate) {
    return null;
  }

  const validation = validateAndNormalizeFilePath(candidate);
  return validation.ok ? validation.normalizedPath : null;
}

function isProtectedWorkspacePackagePath(rawPath: string): boolean {
  let normalized = rawPath.trim().replace(/\\/g, "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    return false;
  }

  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  const segments = normalized.split("/").filter((s) => s.length > 0);
  if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
    return false;
  }

  const filename = segments[segments.length - 1].toLowerCase();
  return PROTECTED_PACKAGE_FILENAMES.has(filename);
}

/**
 * Tracks unresolved file-write failures deterministically outside `step.run`
 * across AgentKit tool calls and Inngest replays.
 *
 * Strict recovery rules (an unrelated successful write NEVER clears earlier errors):
 * - Valid-path write failures clear ONLY when that exact path is written successfully.
 * - Workspace-prefix/alias mistakes (`/home/user/...` or `@/...`) clear ONLY when
 *   their exact corresponding project-relative target path is written successfully.
 * - Protected package/lockfile rejections (`package.json`, lockfiles) are NOT cleared
 *   by file writes; they require explicit recovery via `reconcileTerminalRecovery()`.
 * - Unsafe/non-recoverable paths (`../`, `/etc/...`, `.git/...`, etc.) never auto-clear.
 */
export function reconcileFileWriteErrors(
  currentErrors: Record<string, string>,
  toolResult: Pick<CreateOrUpdateFilesToolResult, "ok" | "writtenFiles" | "failedFiles">
): Record<string, string> {
  const next: Record<string, string> = { ...currentErrors };
  const writtenSet = new Set(toolResult.writtenFiles);

  for (const writtenPath of toolResult.writtenFiles) {
    delete next[writtenPath];
  }

  if (writtenSet.size > 0) {
    for (const existingFailedPath of Object.keys(next)) {
      const recoverableTarget = deriveRecoverableTargetPath(existingFailedPath);
      if (recoverableTarget !== null && writtenSet.has(recoverableTarget)) {
        delete next[existingFailedPath];
      }
    }
  }

  for (const failure of toolResult.failedFiles) {
    next[failure.path] = failure.error;
  }

  return next;
}

/**
 * Explicitly clears protected workspace package/lockfile rejections (e.g.
 * `package.json`) ONLY when a subsequent `terminal` tool call succeeds with a
 * package-management command (e.g. `npm install <pkg> --yes`).
 *
 * Non-package commands, failed terminal commands, valid-path write failures,
 * and unsafe/traversal paths are never cleared.
 */
export function reconcileTerminalRecovery(
  currentErrors: Record<string, string>,
  command: string,
  terminalResult: Pick<TerminalCommandResult, "ok">
): Record<string, string> {
  if (!terminalResult.ok || !PACKAGE_MANAGER_COMMAND_RE.test(command.trim())) {
    return { ...currentErrors };
  }

  const next: Record<string, string> = { ...currentErrors };
  for (const existingFailedPath of Object.keys(next)) {
    if (isProtectedWorkspacePackagePath(existingFailedPath)) {
      delete next[existingFailedPath];
    }
  }

  return next;
}

/**
 * Determines whether a completed agent run should persist a new Fragment.
 *
 * - Rejects runs missing a `<task_summary>`.
 * - Rejects runs with zero total files.
 * - Rejects runs with any unresolved file-write failures (preventing
 *   pre-seeded restored files from masking a failed follow-up turn).
 * - Allows legitimate zero-file-change follow-ups when restoration succeeded,
 *   no file writes failed, and the agent returned a valid summary.
 */
export function shouldPersistFragment({
  summary,
  files,
  restoredFileCount,
  unresolvedFileErrors,
}: GenerationOutcomeInput): boolean {
  if (!summary || summary.trim().length === 0) {
    return false;
  }

  if (Object.keys(unresolvedFileErrors).length > 0) {
    return false;
  }

  const totalFiles = Object.keys(files || {}).length;
  if (totalFiles === 0) {
    return false;
  }

  // On follow-ups with restored files, totalFiles >= restoredFileCount > 0 and
  // zero unresolved errors with a valid summary is a legitimate success (even
  // when 0 files needed editing).
  return restoredFileCount >= 0 && totalFiles > 0;
}

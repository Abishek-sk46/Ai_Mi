export interface FailureMessageResult {
  id?: string;
  role?: "USER" | "ASSISTANT";
  type?: "RESULT" | "ERROR";
  content?: string;
  createdAt?: Date;
  updatedAt?: Date;
  fragments?: {
    create?: {
      sandboxUrl?: string;
      title?: string;
      files?: Record<string, string>;
    };
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface FailurePrismaMessageRecord {
  id: string;
  role: "USER" | "ASSISTANT";
  type: "RESULT" | "ERROR";
  createdAt: Date;
  updatedAt?: Date;
  content?: string;
}

export interface FailurePrismaClient {
  message: {
    findFirst: (args: {
      where: {
        id?: string;
        projectId?: string;
        role?: "USER" | "ASSISTANT";
        content?: string;
        NOT?: {
          id?: string;
        };
        createdAt?:
          | Date
          | {
              gt?: Date;
              gte?: Date;
              lt?: Date;
              lte?: Date;
            };
      };
      orderBy?:
        | { createdAt: "desc" | "asc" }
        | Array<{ createdAt?: "desc" | "asc"; id?: "desc" | "asc" }>;
      select?: {
        id?: boolean;
        role?: boolean;
        type?: boolean;
        createdAt?: boolean;
        content?: boolean;
      };
    }) => Promise<FailurePrismaMessageRecord | null>;
    findMany?: (args: {
      where: {
        projectId?: string;
        role?: "USER" | "ASSISTANT";
        content?: string;
        NOT?: {
          id?: string;
        };
        createdAt?:
          | Date
          | {
              gt?: Date;
              gte?: Date;
              lt?: Date;
              lte?: Date;
            };
      };
      orderBy?:
        | { createdAt: "desc" | "asc" }
        | Array<{ createdAt?: "desc" | "asc"; id?: "desc" | "asc" }>;
      select?: {
        id?: boolean;
        role?: boolean;
        type?: boolean;
        createdAt?: boolean;
        content?: boolean;
      };
      take?: number;
    }) => Promise<FailurePrismaMessageRecord[]>;
    create: (args: {
      data: {
        projectId: string;
        content: string;
        role: "ASSISTANT";
        type: "RESULT" | "ERROR";
        createdAt?: Date;
        updatedAt?: Date;
        fragments?: {
          create: {
            sandboxUrl: string;
            title: string;
            files: Record<string, string>;
          };
        };
      };
    }) => Promise<FailureMessageResult>;
  };
}

export interface FailureStepLike {
  run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>;
}

export interface HandleGenerationFailureParams {
  event: unknown;
  error?: unknown;
  prisma: FailurePrismaClient;
  step?: FailureStepLike;
  fallbackErrorMessage?: string;
}

export interface HandleGenerationFailureResult {
  persisted: boolean;
  reason?:
    | "already_handled"
    | "missing_project_id"
    | "prisma_error"
    | "target_message_not_found"
    | "ambiguous_legacy_event"
    | "unorderable_timestamp_tie";
  projectId?: string;
  userMessageId?: string;
  messageId?: string;
  error?: string;
}

export interface SaveGenerationResultParams {
  projectId: string;
  isError: boolean;
  sandboxUrl?: string | null;
  title?: string;
  response?: string;
  files?: Record<string, string>;
  prisma: FailurePrismaClient;
}

export interface SandboxLike {
  getHost: (port: number) => Promise<string> | string;
}

export interface ExtractedFailureContext {
  projectId: string | null;
  userMessageId: string | null;
  promptValue: string | null;
  eventTimestamp: number | null;
}

/**
 * Safely extracts failure context (projectId, userMessageId, prompt value, event timestamp)
 * from various Inngest event structures.
 * Supports:
 * - Standard Inngest onFailure event: event.data.event.data
 * - Direct trigger event payload: event.data
 * - Flat event payload: event
 */
export function extractFailureContext(event: unknown): ExtractedFailureContext {
  if (!event || typeof event !== "object") {
    return { projectId: null, userMessageId: null, promptValue: null, eventTimestamp: null };
  }

  const anyEvent = event as Record<string, unknown>;
  const eventData =
    typeof anyEvent.data === "object" && anyEvent.data !== null
      ? (anyEvent.data as Record<string, unknown>)
      : undefined;

  const innerEvent =
    typeof eventData?.event === "object" && eventData.event !== null
      ? (eventData.event as Record<string, unknown>)
      : undefined;

  const innerEventData =
    typeof innerEvent?.data === "object" && innerEvent.data !== null
      ? (innerEvent.data as Record<string, unknown>)
      : undefined;

  const getTrimmedString = (val: unknown): string | null => {
    return typeof val === "string" && val.trim() ? val.trim() : null;
  };

  const getPositiveNumber = (val: unknown): number | null => {
    return typeof val === "number" && !isNaN(val) && val > 0 ? val : null;
  };

  const projectId =
    getTrimmedString(innerEventData?.projectId) ||
    getTrimmedString(eventData?.projectId) ||
    getTrimmedString(anyEvent.projectId);

  const userMessageId =
    getTrimmedString(innerEventData?.userMessageId) ||
    getTrimmedString(eventData?.userMessageId) ||
    getTrimmedString(anyEvent.userMessageId);

  const promptValue =
    getTrimmedString(innerEventData?.value) ||
    getTrimmedString(eventData?.value) ||
    getTrimmedString(anyEvent.value);

  const eventTimestamp =
    getPositiveNumber(innerEvent?.ts) ||
    getPositiveNumber(eventData?.ts) ||
    getPositiveNumber(anyEvent?.ts);

  return { projectId, userMessageId, promptValue, eventTimestamp };
}

/**
 * Backward-compatible helper extracting projectId from failure event.
 */
export function extractProjectIdFromFailureEvent(event: unknown): string | null {
  return extractFailureContext(event).projectId;
}

/**
 * Safely extracts text output from agent output arrays (such as gpt-4o-mini generators).
 * Prevents TypeError if output is empty, undefined, or missing expected structure.
 */
export function extractAgentOutputText(
  output: unknown,
  fallback: string
): string {
  if (!Array.isArray(output) || output.length === 0) {
    return fallback;
  }

  const first = output[0];
  if (!first || typeof first !== "object" || first.type !== "text") {
    return fallback;
  }

  if (typeof first.content === "string") {
    const trimmed = first.content.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  if (Array.isArray(first.content)) {
    const combined = first.content
      .map((item: unknown) => {
        if (typeof item === "string") {
          return item;
        }
        if (
          item &&
          typeof item === "object" &&
          "text" in item &&
          typeof (item as { text: unknown }).text === "string"
        ) {
          return (item as { text: string }).text;
        }
        return "";
      })
      .join("")
      .trim();

    return combined.length > 0 ? combined : fallback;
  }

  return fallback;
}

/**
 * Determines whether a sandbox URL should be retrieved.
 * Failed generations must never retrieve or wait on a sandbox URL.
 */
export function shouldRetrieveSandboxUrl(isError: boolean): boolean {
  return !isError;
}

/**
 * Resolves the preview sandbox URL for a valid generation.
 */
export async function resolveSandboxUrl(
  sandboxId: string,
  getSandboxFn: (id: string) => Promise<SandboxLike>
): Promise<string> {
  const sandbox = await getSandboxFn(sandboxId);
  const host = await sandbox.getHost(3000);
  return `https://${host}`;
}

/**
 * Saves the generation outcome message to the database.
 * If isError is true, saves an ASSISTANT ERROR message without creating a Fragment.
 * If isError is false, saves an ASSISTANT RESULT message and attaches the new Fragment.
 */
export async function saveGenerationResult({
  projectId,
  isError,
  sandboxUrl,
  title,
  response,
  files,
  prisma,
}: SaveGenerationResultParams): Promise<FailureMessageResult> {
  if (isError) {
    return await prisma.message.create({
      data: {
        projectId,
        content: "Something went wrong. Please try again.",
        role: "ASSISTANT",
        type: "ERROR",
      },
    });
  }

  return await prisma.message.create({
    data: {
      projectId,
      content: response && response.trim() ? response.trim() : "Response",
      role: "ASSISTANT",
      type: "RESULT",
      fragments: {
        create: {
          sandboxUrl: sandboxUrl || "",
          title: title && title.trim() ? title.trim() : "Fragment",
          files: files || {},
        },
      },
    },
  });
}

export interface LoadPreviousMessagesParams {
  projectId: string;
  userMessageId?: string | null;
  prisma: FailurePrismaClient;
  take?: number;
}

/**
 * Loads previous conversation messages for the code agent, ensuring history isolation.
 *
 * Guarantees:
 * - Requires userMessageId to resolve the current prompt.
 * - If userMessageId is absent or cannot be found, returns an empty array and logs a diagnostic warning.
 * - Does not guess which prompt the event belongs to.
 * - Retrieves only messages created strictly before the current prompt's createdAt.
 * - Excludes any messages sharing the current prompt's timestamp (including unorderable ties).
 * - Excludes the current prompt itself (which is passed separately to network.run).
 * - Preserves the standard conversation formatting (role: assistant | user, text content) and limit.
 */
export async function loadPreviousConversationMessages({
  projectId,
  userMessageId,
  prisma,
  take = 5,
}: LoadPreviousMessagesParams): Promise<
  Array<{ type: "text"; role: "assistant" | "user"; content: string }>
> {
  const trimmedId =
    typeof userMessageId === "string" ? userMessageId.trim() : "";
  if (!trimmedId) {
    console.warn(
      `[code-agent] loadPreviousConversationMessages: missing or empty userMessageId for project ${projectId}. Returning empty history to prevent cross-prompt context contamination.`
    );
    return [];
  }

  const currentPrompt = await prisma.message.findFirst({
    where: { id: trimmedId, projectId },
    select: { id: true, createdAt: true },
  });

  if (!currentPrompt) {
    console.warn(
      `[code-agent] loadPreviousConversationMessages: user message ${trimmedId} not found in project ${projectId}. Returning empty history to avoid guessing context.`
    );
    return [];
  }

  const whereClause: {
    projectId: string;
    createdAt: { lt: Date };
  } = {
    projectId,
    createdAt: { lt: currentPrompt.createdAt },
  };

  const messages = prisma.message.findMany
    ? await prisma.message.findMany({
        where: whereClause,
        orderBy: { createdAt: "desc" },
        select: { id: true, role: true, content: true, createdAt: true },
        take,
      })
    : [];

  const formattedMessages: Array<{
    type: "text";
    role: "assistant" | "user";
    content: string;
  }> = [];

  for (const message of messages) {
    formattedMessages.push({
      type: "text",
      role: message.role === "ASSISTANT" ? "assistant" : "user",
      content: message.content || "",
    });
  }

  return formattedMessages.reverse();
}

/**
 * Handles terminal Inngest failures (e.g. after retries are exhausted).
 * Guarantees that the user receives an ASSISTANT ERROR message rather than
 * being left stuck in an indefinite loading state.
 *
 * Correlates failures to the specific originating USER prompt:
 * - If userMessageId is present, finds that exact prompt.
 * - Otherwise falls back to matching by prompt content, then latest USER message.
 * - Checks whether an ASSISTANT message already exists between that prompt and the next prompt.
 * - If a subsequent prompt (e.g. Prompt B) was already submitted, positions Prompt A's
 *   error message strictly between Prompt A and Prompt B to preserve conversation chronology.
 */
export async function handleGenerationFailure({
  event,
  error,
  prisma,
  step,
  fallbackErrorMessage,
}: HandleGenerationFailureParams): Promise<HandleGenerationFailureResult> {
  const { projectId, userMessageId, promptValue, eventTimestamp } =
    extractFailureContext(event);
  if (!projectId) {
    console.warn(
      "[code-agent] Could not extract projectId from failure event:",
      event
    );
    return {
      persisted: false,
      reason: "missing_project_id",
    };
  }

  try {
    // 1. Locate the original USER message that triggered this generation run
    let targetUserMessage: FailurePrismaMessageRecord | null = null;

    if (userMessageId) {
      targetUserMessage = await prisma.message.findFirst({
        where: { id: userMessageId, projectId },
        select: { id: true, role: true, type: true, createdAt: true, content: true },
      });

      if (!targetUserMessage) {
        console.warn(
          `[code-agent] Targeted user message ${userMessageId} not found in project ${projectId}.`
        );
        return {
          persisted: false,
          reason: "target_message_not_found",
          projectId,
        };
      }
    } else {
      // Legacy event without userMessageId: narrow candidate set safely without guessing
      const whereClause: {
        projectId: string;
        role: "USER";
        content?: string;
        createdAt?: { lte: Date };
      } = {
        projectId,
        role: "USER",
      };

      if (promptValue) {
        whereClause.content = promptValue;
      }

      if (eventTimestamp) {
        // Exclude any user messages created after the event was dispatched.
        // Clock-skew limitation note:
        // Comparing database `createdAt` (written by the PostgreSQL server) against Inngest
        // `event.ts` (recorded by Inngest/application server in ms since Unix epoch) across distributed
        // systems is subject to physical clock drift. Without monotonic synchronization:
        // 1. If the database clock is ahead of Inngest's clock, `createdAt` could slightly exceed
        //    `event.ts`, filtering out the legitimate message.
        // 2. Adding an arbitrary positive forward buffer (e.g. +5000ms) creates a vulnerability
        //    where a subsequent prompt submitted within the buffer window is falsely matched.
        // 3. Therefore, strict `lte: new Date(eventTimestamp)` without positive tolerance is the
        //    safest conservative boundary for legacy events lacking userMessageId. All new events
        //    authoritatively include `userMessageId`, eliminating dependency on cross-system wall clocks.
        whereClause.createdAt = { lte: new Date(eventTimestamp) };
      }

      const candidateUserMessages = prisma.message.findMany
        ? await prisma.message.findMany({
            where: whereClause,
            orderBy: { createdAt: "asc" },
            select: { id: true, role: true, type: true, createdAt: true, content: true },
          })
        : [];

      if (candidateUserMessages.length === 1) {
        targetUserMessage = candidateUserMessages[0];
      } else if (candidateUserMessages.length > 1) {
        console.warn(
          `[code-agent] Ambiguous legacy failure event for project ${projectId}: found ${candidateUserMessages.length} candidate USER messages matching legacy criteria. Skipping failure attachment to prevent conversation corruption.`
        );
        return {
          persisted: false,
          reason: "ambiguous_legacy_event",
          projectId,
        };
      } else {
        console.warn(
          `[code-agent] No matching candidate USER message found for legacy failure event in project ${projectId}.`
        );
        return {
          persisted: false,
          reason: "ambiguous_legacy_event",
          projectId,
        };
      }
    }

    // 2. Check if this specific targetUserMessage was already answered by an ASSISTANT message
    let nextUserMessage: FailurePrismaMessageRecord | null = null;
    if (targetUserMessage) {
      // Find the next USER message submitted after this one (e.g. Prompt B after Prompt A)
      nextUserMessage = await prisma.message.findFirst({
        where: {
          projectId,
          role: "USER",
          NOT: { id: targetUserMessage.id },
          createdAt: { gte: targetUserMessage.createdAt },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, role: true, type: true, createdAt: true },
      });

      let existingAssistant: FailurePrismaMessageRecord | null = null;

      if (nextUserMessage) {
        const isTie =
          nextUserMessage.createdAt.getTime() ===
          targetUserMessage.createdAt.getTime();

        if (isTie) {
          // Prompt A and Prompt B share the exact same millisecond timestamp.
          // Under the existing schema (random UUIDs and no turn index), no discrete timestamp
          // can be placed between them. Inserting an error at tA could cause PostgreSQL to display
          // Error A after Prompt B, making the error appear to belong to Prompt B.
          // To preserve history integrity, do not insert an ambiguous message.
          // Preserve diagnostic information tied to the original userMessageId.
          console.warn(
            `[code-agent] Unorderable timestamp tie detected for project ${projectId}: prompt ${targetUserMessage.id} shares createdAt (${targetUserMessage.createdAt.toISOString()}) with subsequent prompt ${nextUserMessage.id}. Skipping conversation message insertion to prevent misattribution.`
          );
          return {
            persisted: false,
            reason: "unorderable_timestamp_tie",
            projectId,
            userMessageId: targetUserMessage.id,
          };
        }

        // When Prompt B was submitted at least 1ms after Prompt A:
        // Any assistant response in [tA, tB) belongs to Prompt A.
        // Prompt B's response (>= tB) is strictly excluded by lt: nextUserMessage.createdAt.
        existingAssistant = await prisma.message.findFirst({
          where: {
            projectId,
            role: "ASSISTANT",
            createdAt: {
              gte: targetUserMessage.createdAt,
              lt: nextUserMessage.createdAt,
            },
          },
          orderBy: { createdAt: "asc" },
          select: { id: true, role: true, type: true, createdAt: true },
        });
      } else {
        // No subsequent USER message exists; targetUserMessage is currently the latest prompt
        existingAssistant = await prisma.message.findFirst({
          where: {
            projectId,
            role: "ASSISTANT",
            createdAt: { gte: targetUserMessage.createdAt },
          },
          orderBy: { createdAt: "asc" },
          select: { id: true, role: true, type: true, createdAt: true },
        });
      }

      if (existingAssistant) {
        // This specific prompt already has its ASSISTANT response
        return {
          persisted: false,
          reason: "already_handled",
          projectId,
          messageId: existingAssistant.id,
        };
      }
    }

    // 3. Determine the insertion timestamp to preserve strict conversation ordering
    let errorTimestamp = new Date();
    if (targetUserMessage) {
      if (nextUserMessage) {
        // A subsequent prompt was already submitted (e.g. Prompt B after Prompt A)
        const tA = targetUserMessage.createdAt.getTime();
        const tB = nextUserMessage.createdAt.getTime();
        const diff = tB - tA;

        if (diff > 1) {
          // Safe midpoint between Prompt A and Prompt B (tA < errorTimestamp < tB)
          errorTimestamp = new Date(tA + Math.floor(diff / 2));
        } else {
          // When diff is 0 or 1, no integer millisecond exists strictly between tA and tB.
          // Setting errorTimestamp = tA ensures errorTimestamp < tB when diff === 1 (preserving tA <= tErr < tB),
          // and avoids pushing errorTimestamp past tB into subsequent turns.
          errorTimestamp = new Date(tA);
        }
      } else {
        // targetUserMessage is currently the latest prompt
        // Ensure errorTimestamp is at or after targetUserMessage.createdAt
        const tA = targetUserMessage.createdAt.getTime();
        const now = Date.now();
        errorTimestamp = now > tA ? new Date(now) : new Date(tA + 1);
      }
    }

    const errorMessage =
      fallbackErrorMessage ||
      "Something went wrong while generating your website. Please try again.";

    const createFn = async () => {
      return await prisma.message.create({
        data: {
          projectId,
          content: errorMessage,
          role: "ASSISTANT",
          type: "ERROR",
          createdAt: errorTimestamp,
          updatedAt: errorTimestamp,
        },
      });
    };

    const created = step
      ? ((await step.run("save-terminal-failure", createFn)) as { id?: string })
      : await createFn();

    return {
      persisted: true,
      projectId,
      messageId: created?.id,
    };
  } catch (err) {
    const errorString = err instanceof Error ? err.message : String(err);
    console.error(
      `[code-agent] Error persisting terminal failure message for project ${projectId}:`,
      errorString,
      error
    );
    return {
      persisted: false,
      reason: "prisma_error",
      projectId,
      error: errorString,
    };
  }
}

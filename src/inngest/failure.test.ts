import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractAgentOutputText,
  extractFailureContext,
  extractProjectIdFromFailureEvent,
  handleGenerationFailure,
  loadPreviousConversationMessages,
  resolveSandboxUrl,
  saveGenerationResult,
  shouldRetrieveSandboxUrl,
  type FailurePrismaClient,
} from "./failure";

interface MockMessageRecord {
  [key: string]: unknown;
  id: string;
  projectId: string;
  content: string;
  role: "USER" | "ASSISTANT";
  type: "RESULT" | "ERROR";
  createdAt: Date;
  updatedAt?: Date;
  fragments?: {
    create?: {
      sandboxUrl?: string;
      title?: string;
      files?: Record<string, string>;
    };
    [key: string]: unknown;
  } | null;
}

function createMockPrisma(initialMessages: MockMessageRecord[] = []): {
  prisma: FailurePrismaClient;
  messages: MockMessageRecord[];
} {
  const messages: MockMessageRecord[] = [...initialMessages];

  const filterMessages = (where: {
    id?: string;
    projectId?: string;
    role?: "USER" | "ASSISTANT";
    content?: string;
    NOT?: { id?: string };
    createdAt?: Date | { gt?: Date; gte?: Date; lt?: Date; lte?: Date };
  }): MockMessageRecord[] => {
    return messages.filter((m) => {
      if (where.projectId && m.projectId !== where.projectId) return false;
      if (where.id && m.id !== where.id) return false;
      if (where.NOT?.id && m.id === where.NOT.id) return false;
      if (where.role && m.role !== where.role) return false;
      if (where.content && m.content !== where.content) return false;

      if (where.createdAt) {
        if (where.createdAt instanceof Date) {
          if (m.createdAt.getTime() !== where.createdAt.getTime()) return false;
        } else {
          const filter = where.createdAt;
          if (filter.gt && !(m.createdAt.getTime() > filter.gt.getTime())) return false;
          if (filter.gte && !(m.createdAt.getTime() >= filter.gte.getTime())) return false;
          if (filter.lt && !(m.createdAt.getTime() < filter.lt.getTime())) return false;
          if (filter.lte && !(m.createdAt.getTime() <= filter.lte.getTime())) return false;
        }
      }

      return true;
    });
  };

  const sortMessages = (
    list: MockMessageRecord[],
    orderBy?:
      | { createdAt?: "desc" | "asc" }
      | Array<{ createdAt?: "desc" | "asc"; id?: "desc" | "asc" }>
  ) => {
    const orderDirection = Array.isArray(orderBy)
      ? orderBy[0]?.createdAt || "asc"
      : orderBy?.createdAt || "asc";

    list.sort((a, b) => {
      if (a.createdAt.getTime() !== b.createdAt.getTime()) {
        return orderDirection === "desc"
          ? b.createdAt.getTime() - a.createdAt.getTime()
          : a.createdAt.getTime() - b.createdAt.getTime();
      }
      return a.id.localeCompare(b.id);
    });
  };

  const prisma: FailurePrismaClient = {
    message: {
      findFirst: async ({ where, orderBy }) => {
        const filtered = filterMessages(where);
        if (filtered.length === 0) return null;
        sortMessages(filtered, orderBy);

        const first = filtered[0];
        return {
          id: first.id,
          role: first.role,
          type: first.type,
          createdAt: first.createdAt,
          updatedAt: first.updatedAt,
          content: first.content,
        };
      },
      findMany: async ({ where, orderBy, take }) => {
        let filtered = filterMessages(where);
        sortMessages(filtered, orderBy);
        if (typeof take === "number" && take > 0) {
          filtered = filtered.slice(0, take);
        }
        return filtered.map((first) => ({
          id: first.id,
          role: first.role,
          type: first.type,
          createdAt: first.createdAt,
          updatedAt: first.updatedAt,
          content: first.content,
        }));
      },
      create: async ({ data }) => {
        const record: MockMessageRecord = {
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          projectId: data.projectId,
          content: data.content,
          role: data.role,
          type: data.type,
          createdAt: data.createdAt || new Date(),
          updatedAt: data.updatedAt || data.createdAt || new Date(),
          fragments: data.fragments,
        };
        messages.push(record);
        return record;
      },
    },
  };

  return { prisma, messages };
}

describe("TASK 06: Failure Handling & Lifecycle Reliability", () => {
  describe("extractFailureContext & extractProjectIdFromFailureEvent", () => {
    it("extracts projectId, userMessageId, and promptValue from standard Inngest onFailure event structure", () => {
      const failureEvent = {
        name: "inngest/function.failed",
        data: {
          function_id: "code-agent",
          run_id: "run-01",
          error: { message: "Fatal error" },
          event: {
            name: "code-agent/run",
            data: {
              projectId: "proj-std-123",
              userMessageId: "msg-user-orig-1",
              value: "create a hero section",
            },
          },
        },
      };

      const context = extractFailureContext(failureEvent);
      assert.equal(context.projectId, "proj-std-123");
      assert.equal(context.userMessageId, "msg-user-orig-1");
      assert.equal(context.promptValue, "create a hero section");
      assert.equal(extractProjectIdFromFailureEvent(failureEvent), "proj-std-123");
    });

    it("extracts context from direct event data payload", () => {
      const event = {
        data: {
          projectId: "proj-direct-456",
          userMessageId: "msg-direct-2",
          value: "add a contact form",
        },
      };

      const context = extractFailureContext(event);
      assert.equal(context.projectId, "proj-direct-456");
      assert.equal(context.userMessageId, "msg-direct-2");
      assert.equal(context.promptValue, "add a contact form");
    });

    it("extracts context from top-level object properties", () => {
      const event = {
        projectId: "proj-top-789",
        userMessageId: "msg-top-3",
        value: "build dashboard",
      };

      const context = extractFailureContext(event);
      assert.equal(context.projectId, "proj-top-789");
      assert.equal(context.userMessageId, "msg-top-3");
      assert.equal(context.promptValue, "build dashboard");
    });

    it("trims whitespace from extracted context fields", () => {
      const event = {
        data: {
          projectId: "   proj-whitespace-1   ",
          userMessageId: "  msg-ws-1  ",
          value: "  trim prompt  ",
        },
      };

      const context = extractFailureContext(event);
      assert.equal(context.projectId, "proj-whitespace-1");
      assert.equal(context.userMessageId, "msg-ws-1");
      assert.equal(context.promptValue, "trim prompt");
    });

    it("extracts eventTimestamp from Inngest failure event payloads", () => {
      const eventWithTs = {
        name: "inngest/function.failed",
        data: {
          function_id: "code-agent",
          run_id: "run-01",
          event: {
            name: "code-agent/run",
            data: {
              projectId: "proj-ts-1",
            },
            ts: 1700000012345,
          },
        },
        ts: 1700000019999,
      };

      const context = extractFailureContext(eventWithTs);
      assert.equal(context.eventTimestamp, 1700000012345);
    });

    it("returns null fields for missing, null, undefined, or empty payload", () => {
      assert.deepEqual(extractFailureContext(null), {
        projectId: null,
        userMessageId: null,
        promptValue: null,
        eventTimestamp: null,
      });
      assert.deepEqual(extractFailureContext(undefined), {
        projectId: null,
        userMessageId: null,
        promptValue: null,
        eventTimestamp: null,
      });
      assert.deepEqual(extractFailureContext({}), {
        projectId: null,
        userMessageId: null,
        promptValue: null,
        eventTimestamp: null,
      });
      assert.deepEqual(extractFailureContext({ data: {} }), {
        projectId: null,
        userMessageId: null,
        promptValue: null,
        eventTimestamp: null,
      });
      assert.deepEqual(
        extractFailureContext({
          data: { projectId: "  ", userMessageId: "", value: "   " },
        }),
        {
          projectId: null,
          userMessageId: null,
          promptValue: null,
          eventTimestamp: null,
        }
      );
      assert.equal(extractProjectIdFromFailureEvent(null), null);
    });
  });

  describe("extractAgentOutputText", () => {
    it("returns string content from simple text output", () => {
      const output = [{ type: "text", content: "Portfolio Website" }];
      assert.equal(extractAgentOutputText(output, "Fallback"), "Portfolio Website");
    });

    it("returns concatenated text from array content", () => {
      const output = [
        {
          type: "text",
          content: ["E-Commerce ", "Storefront"],
        },
      ];
      assert.equal(extractAgentOutputText(output, "Fallback"), "E-Commerce Storefront");
    });

    it("returns concatenated text from structured text parts", () => {
      const output = [
        {
          type: "text",
          content: [{ text: "Hello " }, { text: "World" }],
        },
      ];
      assert.equal(extractAgentOutputText(output, "Fallback"), "Hello World");
    });

    it("falls back safely when output array is empty", () => {
      assert.equal(extractAgentOutputText([], "Fallback Title"), "Fallback Title");
    });

    it("falls back safely when output is undefined or null", () => {
      assert.equal(extractAgentOutputText(undefined, "Default Response"), "Default Response");
      assert.equal(extractAgentOutputText(null, "Default Response"), "Default Response");
    });

    it("falls back safely when output[0] is not a text message", () => {
      const output = [{ type: "image", data: "..." }];
      assert.equal(extractAgentOutputText(output, "Fallback"), "Fallback");
    });

    it("falls back safely when text content is empty or only whitespace", () => {
      const output = [{ type: "text", content: "   " }];
      assert.equal(extractAgentOutputText(output, "Fallback"), "Fallback");
    });
  });

  describe("shouldRetrieveSandboxUrl", () => {
    it("returns false when isError is true (failed generations skip sandbox URL retrieval)", () => {
      assert.equal(shouldRetrieveSandboxUrl(true), false);
    });

    it("returns true when isError is false (successful generations require sandbox URL)", () => {
      assert.equal(shouldRetrieveSandboxUrl(false), true);
    });
  });

  describe("resolveSandboxUrl", () => {
    it("retrieves host and formats https URL successfully", async () => {
      const mockSandbox = {
        getHost: async (port: number) => {
          assert.equal(port, 3000);
          return "test-sandbox-3000.e2b.dev";
        },
      };

      const url = await resolveSandboxUrl("sandbox-123", async (id) => {
        assert.equal(id, "sandbox-123");
        return mockSandbox;
      });

      assert.equal(url, "https://test-sandbox-3000.e2b.dev");
    });

    it("propagates error when getSandbox fails", async () => {
      await assert.rejects(
        async () => {
          await resolveSandboxUrl("sandbox-dead", async () => {
            throw new Error("Sandbox connect failed: NotFoundError");
          });
        },
        /NotFoundError/
      );
    });

    it("propagates error when getHost fails", async () => {
      const mockSandbox = {
        getHost: async () => {
          throw new Error("Host port 3000 unreachable: TimeoutError");
        },
      };

      await assert.rejects(
        async () => {
          await resolveSandboxUrl("sandbox-timeout", async () => mockSandbox);
        },
        /TimeoutError/
      );
    });
  });

  describe("saveGenerationResult", () => {
    it("persists ASSISTANT ERROR message without Fragment when isError is true", async () => {
      const { prisma, messages } = createMockPrisma();

      const result = await saveGenerationResult({
        projectId: "proj-err-1",
        isError: true,
        prisma,
      });

      assert.equal(result.role, "ASSISTANT");
      assert.equal(result.type, "ERROR");
      assert.equal(result.content, "Something went wrong. Please try again.");
      assert.equal(result.fragments, undefined);
      assert.equal(messages.length, 1);
    });

    it("persists ASSISTANT RESULT message with Fragment when isError is false", async () => {
      const { prisma, messages } = createMockPrisma();

      const result = await saveGenerationResult({
        projectId: "proj-success-1",
        isError: false,
        sandboxUrl: "https://preview.e2b.dev",
        title: "Landing Page",
        response: "Created your landing page with Next.js.",
        files: { "app/page.tsx": "export default function Page() {}" },
        prisma,
      });

      assert.equal(result.role, "ASSISTANT");
      assert.equal(result.type, "RESULT");
      assert.equal(result.content, "Created your landing page with Next.js.");
      assert.ok(result.fragments?.create);
      assert.equal(result.fragments.create.sandboxUrl, "https://preview.e2b.dev");
      assert.equal(result.fragments.create.title, "Landing Page");
      assert.deepEqual(result.fragments.create.files, {
        "app/page.tsx": "export default function Page() {}",
      });
      assert.equal(messages.length, 1);
    });

    it("uses sensible fallbacks when response and title are missing", async () => {
      const { prisma } = createMockPrisma();

      const result = await saveGenerationResult({
        projectId: "proj-fallback",
        isError: false,
        sandboxUrl: "https://preview.e2b.dev",
        prisma,
      });

      assert.equal(result.content, "Response");
      assert.equal(result.fragments?.create?.title, "Fragment");
    });
  });

  describe("handleGenerationFailure & Prompt Correlation", () => {
    it("Prompt A fails after Prompt B has already been submitted (preserves conversation chronology)", async () => {
      const tA = new Date("2026-11-20T10:00:00.000Z");
      const tB = new Date("2026-11-20T10:00:02.000Z");

      const { prisma, messages } = createMockPrisma([
        {
          id: "msg-prompt-A",
          projectId: "proj-race-1",
          content: "Prompt A: Create landing page",
          role: "USER",
          type: "RESULT",
          createdAt: tA,
          updatedAt: tA,
        },
        {
          id: "msg-prompt-B",
          projectId: "proj-race-1",
          content: "Prompt B: Change theme to dark",
          role: "USER",
          type: "RESULT",
          createdAt: tB,
          updatedAt: tB,
        },
      ]);

      const failureEventA = {
        name: "inngest/function.failed",
        data: {
          function_id: "code-agent",
          run_id: "run-A",
          error: { message: "Sandbox creation timeout" },
          event: {
            name: "code-agent/run",
            data: {
              projectId: "proj-race-1",
              userMessageId: "msg-prompt-A",
              value: "Prompt A: Create landing page",
            },
          },
        },
      };

      const result = await handleGenerationFailure({
        event: failureEventA,
        error: new Error("Sandbox creation timeout"),
        prisma,
      });

      assert.equal(result.persisted, true);
      assert.equal(messages.length, 3);

      // Find the created error message
      const errorMsg = messages.find((m) => m.id === result.messageId);
      assert.ok(errorMsg);
      assert.equal(errorMsg.role, "ASSISTANT");
      assert.equal(errorMsg.type, "ERROR");

      // Verify timestamp is strictly between Prompt A and Prompt B
      assert.ok(
        errorMsg.createdAt.getTime() > tA.getTime(),
        "Error timestamp must be after Prompt A"
      );
      assert.ok(
        errorMsg.createdAt.getTime() < tB.getTime(),
        "Error timestamp must be before Prompt B"
      );

      // Verify that when sorting ascending, the chronological order is:
      // 1. Prompt A
      // 2. Prompt A Error
      // 3. Prompt B
      const sorted = [...messages].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
      );
      assert.equal(sorted[0].id, "msg-prompt-A");
      assert.equal(sorted[1].id, errorMsg.id);
      assert.equal(sorted[2].id, "msg-prompt-B");
    });

    it("Prompt A's failure does not suppress Prompt B's later failure", async () => {
      const tA = new Date("2026-11-20T10:00:00.000Z");
      const tB = new Date("2026-11-20T10:00:02.000Z");

      const { prisma, messages } = createMockPrisma([
        {
          id: "msg-prompt-A",
          projectId: "proj-race-2",
          content: "Prompt A",
          role: "USER",
          type: "RESULT",
          createdAt: tA,
          updatedAt: tA,
        },
        {
          id: "msg-prompt-B",
          projectId: "proj-race-2",
          content: "Prompt B",
          role: "USER",
          type: "RESULT",
          createdAt: tB,
          updatedAt: tB,
        },
      ]);

      // 1. Prompt A fails first
      const failureEventA = {
        data: {
          event: {
            data: {
              projectId: "proj-race-2",
              userMessageId: "msg-prompt-A",
              value: "Prompt A",
            },
          },
        },
      };

      const resultA = await handleGenerationFailure({
        event: failureEventA,
        prisma,
      });
      assert.equal(resultA.persisted, true);
      assert.equal(messages.length, 3);

      // 2. Prompt B subsequently fails
      const failureEventB = {
        data: {
          event: {
            data: {
              projectId: "proj-race-2",
              userMessageId: "msg-prompt-B",
              value: "Prompt B",
            },
          },
        },
      };

      const resultB = await handleGenerationFailure({
        event: failureEventB,
        prisma,
      });

      // Prompt B's failure MUST be persisted and NOT suppressed by Prompt A's error
      assert.equal(resultB.persisted, true);
      assert.equal(messages.length, 4);

      const errorMsgB = messages.find((m) => m.id === resultB.messageId);
      assert.ok(errorMsgB);
      assert.equal(errorMsgB.role, "ASSISTANT");
      assert.equal(errorMsgB.type, "ERROR");

      // Verify full conversation order
      const sorted = [...messages].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
      );
      assert.equal(sorted[0].id, "msg-prompt-A");
      assert.equal(sorted[1].id, resultA.messageId);
      assert.equal(sorted[2].id, "msg-prompt-B");
      assert.equal(sorted[3].id, resultB.messageId);
    });

    it("an existing assistant error for the same prompt does not create a duplicate", async () => {
      const tA = new Date("2026-11-20T10:00:00.000Z");

      const { prisma, messages } = createMockPrisma([
        {
          id: "msg-user-dup",
          projectId: "proj-dup-test",
          content: "Prompt with failure",
          role: "USER",
          type: "RESULT",
          createdAt: tA,
          updatedAt: tA,
        },
      ]);

      const failureEvent = {
        data: {
          event: {
            data: {
              projectId: "proj-dup-test",
              userMessageId: "msg-user-dup",
              value: "Prompt with failure",
            },
          },
        },
      };

      // First run: records failure
      const firstResult = await handleGenerationFailure({
        event: failureEvent,
        prisma,
      });
      assert.equal(firstResult.persisted, true);
      assert.equal(messages.length, 2);

      // Second run (e.g. retry / duplicate trigger): must be suppressed
      const secondResult = await handleGenerationFailure({
        event: failureEvent,
        prisma,
      });
      assert.equal(secondResult.persisted, false);
      assert.equal(secondResult.reason, "already_handled");
      assert.equal(secondResult.messageId, firstResult.messageId);
      assert.equal(messages.length, 2);
    });

    it("an earlier assistant RESULT does not suppress a later prompt's failure", async () => {
      const t1 = new Date("2026-11-20T09:00:00.000Z");
      const t2 = new Date("2026-11-20T09:00:15.000Z");
      const t3 = new Date("2026-11-20T09:05:00.000Z");

      const { prisma, messages } = createMockPrisma([
        // Turn 1 (successful)
        {
          id: "msg-turn1-user",
          projectId: "proj-sequential",
          content: "Create store",
          role: "USER",
          type: "RESULT",
          createdAt: t1,
          updatedAt: t1,
        },
        {
          id: "msg-turn1-asst",
          projectId: "proj-sequential",
          content: "Here is your store.",
          role: "ASSISTANT",
          type: "RESULT",
          createdAt: t2,
          updatedAt: t2,
        },
        // Turn 2 (failed)
        {
          id: "msg-turn2-user",
          projectId: "proj-sequential",
          content: "Add shopping cart",
          role: "USER",
          type: "RESULT",
          createdAt: t3,
          updatedAt: t3,
        },
      ]);

      const failureEvent = {
        data: {
          event: {
            data: {
              projectId: "proj-sequential",
              userMessageId: "msg-turn2-user",
              value: "Add shopping cart",
            },
          },
        },
      };

      const result = await handleGenerationFailure({
        event: failureEvent,
        prisma,
      });

      // Turn 2's failure MUST be persisted
      assert.equal(result.persisted, true);
      assert.equal(messages.length, 4);

      const latestMessage = messages[messages.length - 1];
      assert.equal(latestMessage.role, "ASSISTANT");
      assert.equal(latestMessage.type, "ERROR");
    });

    it("older events without userMessageId still behave safely (backward compatibility via content matching)", async () => {
      const t1 = new Date("2026-11-20T09:00:00.000Z");

      const { prisma, messages } = createMockPrisma([
        {
          id: "msg-legacy-user",
          projectId: "proj-legacy",
          content: "Build portfolio without messageId in event",
          role: "USER",
          type: "RESULT",
          createdAt: t1,
          updatedAt: t1,
        },
      ]);

      // Legacy event has no userMessageId
      const legacyEvent = {
        data: {
          event: {
            data: {
              projectId: "proj-legacy",
              value: "Build portfolio without messageId in event",
            },
          },
        },
      };

      const result = await handleGenerationFailure({
        event: legacyEvent,
        prisma,
      });

      assert.equal(result.persisted, true);
      assert.equal(messages.length, 2);
      assert.equal(messages[1].role, "ASSISTANT");
      assert.equal(messages[1].type, "ERROR");
    });

    it("handles identical prompt timestamps safely (skips message insertion to prevent misattribution to Prompt B)", async () => {
      const t = new Date("2026-11-20T10:00:00.000Z");

      const { prisma, messages } = createMockPrisma([
        {
          id: "msg-prompt-A",
          projectId: "proj-same-ms",
          content: "Prompt A",
          role: "USER",
          type: "RESULT",
          createdAt: t,
          updatedAt: t,
        },
        {
          id: "msg-prompt-B",
          projectId: "proj-same-ms",
          content: "Prompt B",
          role: "USER",
          type: "RESULT",
          createdAt: t,
          updatedAt: t,
        },
      ]);

      const failureEventA = {
        data: {
          event: {
            data: {
              projectId: "proj-same-ms",
              userMessageId: "msg-prompt-A",
              value: "Prompt A",
            },
          },
        },
      };

      const result = await handleGenerationFailure({
        event: failureEventA,
        prisma,
      });

      // Does not insert an assistant error that could sort after Prompt B and appear to belong to Prompt B
      assert.equal(result.persisted, false);
      assert.equal(result.reason, "unorderable_timestamp_tie");
      assert.equal(result.userMessageId, "msg-prompt-A");
      assert.equal(messages.length, 2); // No new message created
    });

    it("handles prompts created 1 ms apart (Prompt B at tA + 1ms)", async () => {
      const tA = new Date("2026-11-20T10:00:00.000Z");
      const tB = new Date("2026-11-20T10:00:00.001Z"); // 1ms apart

      const { prisma, messages } = createMockPrisma([
        {
          id: "msg-prompt-A",
          projectId: "proj-1ms-apart",
          content: "Prompt A",
          role: "USER",
          type: "RESULT",
          createdAt: tA,
          updatedAt: tA,
        },
        {
          id: "msg-prompt-B",
          projectId: "proj-1ms-apart",
          content: "Prompt B",
          role: "USER",
          type: "RESULT",
          createdAt: tB,
          updatedAt: tB,
        },
      ]);

      const failureEventA = {
        data: {
          event: {
            data: {
              projectId: "proj-1ms-apart",
              userMessageId: "msg-prompt-A",
              value: "Prompt A",
            },
          },
        },
      };

      const result = await handleGenerationFailure({
        event: failureEventA,
        prisma,
      });

      assert.equal(result.persisted, true);
      const errorMsg = messages.find((m) => m.id === result.messageId);
      assert.ok(errorMsg);
      // When diff is 1ms, errorTimestamp is tA so that errorTimestamp < tB
      assert.equal(errorMsg.createdAt.getTime(), tA.getTime());
      assert.ok(
        errorMsg.createdAt.getTime() < tB.getTime(),
        "Error A must be strictly before Prompt B"
      );

      // Verify retry detects existing error
      const retryResult = await handleGenerationFailure({
        event: failureEventA,
        prisma,
      });
      assert.equal(retryResult.persisted, false);
      assert.equal(retryResult.reason, "already_handled");
    });

    it("an existing assistant RESULT for Prompt B does not suppress Prompt A's failure", async () => {
      const tA = new Date("2026-11-20T10:00:00.000Z");
      const tB = new Date("2026-11-20T10:00:00.001Z"); // 1ms apart
      const tResB = new Date("2026-11-20T10:00:05.000Z"); // Prompt B succeeded 5 seconds later

      const { prisma, messages } = createMockPrisma([
        {
          id: "msg-prompt-A",
          projectId: "proj-b-res",
          content: "Prompt A",
          role: "USER",
          type: "RESULT",
          createdAt: tA,
          updatedAt: tA,
        },
        {
          id: "msg-prompt-B",
          projectId: "proj-b-res",
          content: "Prompt B",
          role: "USER",
          type: "RESULT",
          createdAt: tB,
          updatedAt: tB,
        },
        {
          id: "msg-asst-B",
          projectId: "proj-b-res",
          content: "Prompt B succeeded",
          role: "ASSISTANT",
          type: "RESULT",
          createdAt: tResB,
          updatedAt: tResB,
        },
      ]);

      const failureEventA = {
        data: {
          event: {
            data: {
              projectId: "proj-b-res",
              userMessageId: "msg-prompt-A",
              value: "Prompt A",
            },
          },
        },
      };

      const resultA = await handleGenerationFailure({
        event: failureEventA,
        prisma,
      });

      // Prompt B's assistant result MUST NOT suppress Prompt A's failure
      assert.equal(resultA.persisted, true);
      assert.equal(messages.length, 4);
      const createdError = messages.find((m) => m.id === resultA.messageId);
      assert.ok(createdError);
      assert.equal(createdError.role, "ASSISTANT");
      assert.equal(createdError.type, "ERROR");
    });

    it("legacy event with duplicate prompt content avoids guessing and logs ambiguity", async () => {
      const t1 = new Date("2026-11-20T09:00:00.000Z");
      const t2 = new Date("2026-11-20T09:02:00.000Z");

      const { prisma, messages } = createMockPrisma([
        {
          id: "msg-dup-1",
          projectId: "proj-dup-content",
          content: "Add shopping cart",
          role: "USER",
          type: "RESULT",
          createdAt: t1,
          updatedAt: t1,
        },
        {
          id: "msg-dup-2",
          projectId: "proj-dup-content",
          content: "Add shopping cart",
          role: "USER",
          type: "RESULT",
          createdAt: t2,
          updatedAt: t2,
        },
      ]);

      // Legacy event with prompt content that appears twice
      const legacyEvent = {
        data: {
          event: {
            data: {
              projectId: "proj-dup-content",
              value: "Add shopping cart",
            },
          },
        },
      };

      const result = await handleGenerationFailure({
        event: legacyEvent,
        prisma,
      });

      // Must NOT blindly pick latest or guess
      assert.equal(result.persisted, false);
      assert.equal(result.reason, "ambiguous_legacy_event");
      assert.equal(messages.length, 2); // No new message created
    });

    it("legacy event without safe matching candidate does not create misleading error", async () => {
      const tFuture = new Date("2026-11-20T11:00:00.000Z");

      const { prisma, messages } = createMockPrisma([
        {
          id: "msg-future",
          projectId: "proj-skew",
          content: "Some prompt",
          role: "USER",
          type: "RESULT",
          createdAt: tFuture,
          updatedAt: tFuture,
        },
      ]);

      // Event was triggered at 10:00 AM (earlier than the message at 11:00 AM)
      const legacyEvent = {
        data: {
          event: {
            data: {
              projectId: "proj-skew",
              value: "Some prompt",
            },
            ts: new Date("2026-11-20T10:00:00.000Z").getTime(),
          },
        },
      };

      const result = await handleGenerationFailure({
        event: legacyEvent,
        prisma,
      });

      // User message created after event was dispatched must not match
      assert.equal(result.persisted, false);
      assert.equal(result.reason, "ambiguous_legacy_event");
      assert.equal(messages.length, 1);
    });

    it("legacy event strictly excludes prompts created even 1 ms after the event timestamp (no unsafe future buffer)", async () => {
      const tEvent = new Date("2026-11-20T10:00:00.000Z").getTime();
      const tSubsequentPrompt = new Date("2026-11-20T10:00:00.001Z"); // 1ms after event was dispatched

      const { prisma, messages } = createMockPrisma([
        {
          id: "msg-later-prompt",
          projectId: "proj-buffer-test",
          content: "Prompt created after event",
          role: "USER",
          type: "RESULT",
          createdAt: tSubsequentPrompt,
          updatedAt: tSubsequentPrompt,
        },
      ]);

      const legacyEvent = {
        data: {
          event: {
            data: {
              projectId: "proj-buffer-test",
              value: "Prompt created after event",
            },
            ts: tEvent,
          },
        },
      };

      const result = await handleGenerationFailure({
        event: legacyEvent,
        prisma,
      });

      // Must strictly exclude subsequent prompt and not attach failure
      assert.equal(result.persisted, false);
      assert.equal(result.reason, "ambiguous_legacy_event");
      assert.equal(messages.length, 1);
    });

    it("new events with userMessageId correlate authoritatively even when duplicate content exists", async () => {
      const t1 = new Date("2026-11-20T09:00:00.000Z");
      const t2 = new Date("2026-11-20T09:02:00.000Z");

      const { prisma, messages } = createMockPrisma([
        {
          id: "msg-authoritative-1",
          projectId: "proj-authoritative",
          content: "Add checkout page",
          role: "USER",
          type: "RESULT",
          createdAt: t1,
          updatedAt: t1,
        },
        {
          id: "msg-authoritative-2",
          projectId: "proj-authoritative",
          content: "Add checkout page",
          role: "USER",
          type: "RESULT",
          createdAt: t2,
          updatedAt: t2,
        },
      ]);

      // New event specifies exact userMessageId: msg-authoritative-2
      const newEvent = {
        data: {
          event: {
            data: {
              projectId: "proj-authoritative",
              userMessageId: "msg-authoritative-2",
              value: "Add checkout page",
            },
          },
        },
      };

      const result = await handleGenerationFailure({
        event: newEvent,
        prisma,
      });

      assert.equal(result.persisted, true);
      assert.equal(messages.length, 3);
      const createdError = messages.find((m) => m.id === result.messageId);
      assert.ok(createdError);
      assert.equal(createdError.role, "ASSISTANT");
      assert.equal(createdError.type, "ERROR");
    });

    it("persists ASSISTANT ERROR message through step.run when step is provided", async () => {
      const { prisma, messages } = createMockPrisma([
        {
          id: "msg-user-step",
          projectId: "proj-step-fail",
          content: "Generate portfolio",
          role: "USER",
          type: "RESULT",
          createdAt: new Date(),
        },
      ]);

      let stepRunCalled = false;
      let recordedStepId = "";
      const step = {
        run: async (id: string, fn: () => Promise<unknown>) => {
          stepRunCalled = true;
          recordedStepId = id;
          return await fn();
        },
      };

      const failureEvent = {
        data: {
          event: {
            data: {
              projectId: "proj-step-fail",
              userMessageId: "msg-user-step",
            },
          },
        },
      };

      const result = await handleGenerationFailure({
        event: failureEvent,
        prisma,
        step,
      });

      assert.equal(result.persisted, true);
      assert.equal(stepRunCalled, true);
      assert.equal(recordedStepId, "save-terminal-failure");
      assert.equal(messages.length, 2);
    });

    it("handles Prisma errors gracefully without throwing unhandled exceptions", async () => {
      const failingPrisma: FailurePrismaClient = {
        message: {
          findFirst: async (args) => {
            if (args?.where?.role === "ASSISTANT") {
              return null;
            }
            if (args?.where?.NOT?.id === "user-1") {
              return null;
            }
            if (
              args?.where?.createdAt &&
              typeof args.where.createdAt === "object" &&
              "gt" in args.where.createdAt
            ) {
              return null;
            }
            return {
              id: "user-1",
              role: "USER",
              type: "RESULT",
              createdAt: new Date(),
            };
          },
          create: async () => {
            throw new Error("PostgreSQL connection refused: ECONNREFUSED");
          },
        },
      };

      const failureEvent = {
        data: {
          event: {
            data: {
              projectId: "proj-db-crash",
              userMessageId: "user-1",
            },
          },
        },
      };

      const result = await handleGenerationFailure({
        event: failureEvent,
        prisma: failingPrisma,
      });

      assert.equal(result.persisted, false);
      assert.equal(result.reason, "prisma_error");
      assert.ok(result.error?.includes("ECONNREFUSED"));
    });

    it("returns missing_project_id when event is invalid", async () => {
      const { prisma, messages } = createMockPrisma();

      const result = await handleGenerationFailure({
        event: { data: {} },
        prisma,
      });

      assert.equal(result.persisted, false);
      assert.equal(result.reason, "missing_project_id");
      assert.equal(messages.length, 0);
    });
  });

  describe("loadPreviousConversationMessages & History Isolation", () => {
    it("Prompt A and Prompt B sharing the same timestamp: Prompt B does not receive Prompt A, Error A, or itself in history", async () => {
      const t = new Date("2026-11-20T10:00:00.000Z");

      const { prisma } = createMockPrisma([
        {
          id: "msg-prompt-A",
          projectId: "proj-same-time",
          content: "Prompt A",
          role: "USER",
          type: "RESULT",
          createdAt: t,
        },
        {
          id: "msg-prompt-B",
          projectId: "proj-same-time",
          content: "Prompt B",
          role: "USER",
          type: "RESULT",
          createdAt: t,
        },
        {
          id: "msg-error-A",
          projectId: "proj-same-time",
          content: "Something went wrong. Please try again.",
          role: "ASSISTANT",
          type: "ERROR",
          createdAt: t,
        },
      ]);

      const history = await loadPreviousConversationMessages({
        projectId: "proj-same-time",
        userMessageId: "msg-prompt-B",
        prisma,
      });

      // Strictly excludes messages sharing prompt B's timestamp
      assert.equal(history.length, 0);
    });

    it("Error A sharing the same timestamp: Prompt B must not receive Error A in its history", async () => {
      const t = new Date("2026-11-20T10:00:00.000Z");

      const { prisma } = createMockPrisma([
        {
          id: "msg-prompt-A",
          projectId: "proj-error-iso",
          content: "Prompt A",
          role: "USER",
          type: "RESULT",
          createdAt: t,
        },
        {
          id: "msg-error-A",
          projectId: "proj-error-iso",
          content: "Failure in prompt A",
          role: "ASSISTANT",
          type: "ERROR",
          createdAt: t,
        },
        {
          id: "msg-prompt-B",
          projectId: "proj-error-iso",
          content: "Prompt B",
          role: "USER",
          type: "RESULT",
          createdAt: t,
        },
      ]);

      const history = await loadPreviousConversationMessages({
        projectId: "proj-error-iso",
        userMessageId: "msg-prompt-B",
        prisma,
      });

      // Error A must never appear in Prompt B's history
      const hasErrorA = history.some((m) => m.content === "Failure in prompt A");
      assert.equal(hasErrorA, false);
      assert.equal(history.length, 0);
    });

    it("normal historical conversation remains available and correctly sequenced", async () => {
      const t1 = new Date("2026-11-20T09:00:00.000Z");
      const t2 = new Date("2026-11-20T09:00:10.000Z");
      const t3 = new Date("2026-11-20T09:05:00.000Z");

      const { prisma } = createMockPrisma([
        {
          id: "msg-turn1-user",
          projectId: "proj-normal",
          content: "Build landing page",
          role: "USER",
          type: "RESULT",
          createdAt: t1,
        },
        {
          id: "msg-turn1-asst",
          projectId: "proj-normal",
          content: "I built the landing page",
          role: "ASSISTANT",
          type: "RESULT",
          createdAt: t2,
        },
        {
          id: "msg-turn2-user",
          projectId: "proj-normal",
          content: "Add a footer",
          role: "USER",
          type: "RESULT",
          createdAt: t3,
        },
      ]);

      const history = await loadPreviousConversationMessages({
        projectId: "proj-normal",
        userMessageId: "msg-turn2-user",
        prisma,
        take: 5,
      });

      // Must receive Turn 1 prompt and assistant response in chronological order
      assert.equal(history.length, 2);
      assert.deepEqual(history, [
        { type: "text", role: "user", content: "Build landing page" },
        { type: "text", role: "assistant", content: "I built the landing page" },
      ]);
    });

    it("limits history to specified take count while retaining the most recent messages", async () => {
      const msgs = [];
      for (let i = 1; i <= 8; i++) {
        msgs.push({
          id: `msg-${i}`,
          projectId: "proj-limit",
          content: `Message ${i}`,
          role: i % 2 === 1 ? ("USER" as const) : ("ASSISTANT" as const),
          type: "RESULT" as const,
          createdAt: new Date(1700000000000 + i * 1000),
        });
      }
      msgs.push({
        id: "msg-current",
        projectId: "proj-limit",
        content: "Current prompt",
        role: "USER" as const,
        type: "RESULT" as const,
        createdAt: new Date(1700000000000 + 10 * 1000),
      });

      const { prisma } = createMockPrisma(msgs);

      const history = await loadPreviousConversationMessages({
        projectId: "proj-limit",
        userMessageId: "msg-current",
        prisma,
        take: 5,
      });

      assert.equal(history.length, 5);
      // Last 5 messages before msg-current (msg-4, msg-5, msg-6, msg-7, msg-8) in chronological order
      assert.equal(history[0].content, "Message 4");
      assert.equal(history[4].content, "Message 8");
    });

    it("returns safe empty history array when userMessageId is missing, undefined, null, or whitespace without guessing", async () => {
      const { prisma } = createMockPrisma([
        {
          id: "msg-prompt-1",
          projectId: "proj-missing-id",
          content: "Prompt 1",
          role: "USER",
          type: "RESULT",
          createdAt: new Date("2026-11-20T09:00:00.000Z"),
        },
        {
          id: "msg-asst-1",
          projectId: "proj-missing-id",
          content: "Answer 1",
          role: "ASSISTANT",
          type: "RESULT",
          createdAt: new Date("2026-11-20T09:00:05.000Z"),
        },
      ]);

      // Test undefined
      const resUndefined = await loadPreviousConversationMessages({
        projectId: "proj-missing-id",
        userMessageId: undefined,
        prisma,
      });
      assert.deepEqual(resUndefined, []);

      // Test null
      const resNull = await loadPreviousConversationMessages({
        projectId: "proj-missing-id",
        userMessageId: null,
        prisma,
      });
      assert.deepEqual(resNull, []);

      // Test empty string / whitespace
      const resEmpty = await loadPreviousConversationMessages({
        projectId: "proj-missing-id",
        userMessageId: "   ",
        prisma,
      });
      assert.deepEqual(resEmpty, []);
    });

    it("returns safe empty history array when userMessageId cannot be found in database without guessing", async () => {
      const { prisma } = createMockPrisma([
        {
          id: "msg-prompt-existing",
          projectId: "proj-invalid-id",
          content: "Existing prompt",
          role: "USER",
          type: "RESULT",
          createdAt: new Date("2026-11-20T09:00:00.000Z"),
        },
        {
          id: "msg-asst-existing",
          projectId: "proj-invalid-id",
          content: "Existing response",
          role: "ASSISTANT",
          type: "RESULT",
          createdAt: new Date("2026-11-20T09:00:05.000Z"),
        },
      ]);

      const resNotFound = await loadPreviousConversationMessages({
        projectId: "proj-invalid-id",
        userMessageId: "non-existent-user-message-id",
        prisma,
      });
      assert.deepEqual(resNotFound, []);
    });
  });

  describe("End-to-end Lifecycle Consistency (No unintended regression to happy path)", () => {
    it("ensures successful generation obtains sandbox URL and saves fragment properly", async () => {
      const { prisma, messages } = createMockPrisma([
        {
          id: "msg-u1",
          projectId: "proj-e2e",
          content: "Build my site",
          role: "USER",
          type: "RESULT",
          createdAt: new Date(),
        },
      ]);

      // 1. Generation succeeded:
      const isError = false;
      assert.equal(shouldRetrieveSandboxUrl(isError), true);

      // 2. Sandbox URL resolved:
      const sandboxUrl = await resolveSandboxUrl("sb-valid", async () => ({
        getHost: async () => "preview.vibe.dev",
      }));
      assert.equal(sandboxUrl, "https://preview.vibe.dev");

      // 3. Mini agent outputs extracted:
      const title = extractAgentOutputText(
        [{ type: "text", content: "My E-Commerce Site" }],
        "Fragment"
      );
      const response = extractAgentOutputText(
        [{ type: "text", content: "I built your e-commerce site with cart." }],
        "Response"
      );

      // 4. Save result:
      await saveGenerationResult({
        projectId: "proj-e2e",
        isError: false,
        sandboxUrl,
        title,
        response,
        files: { "app/page.tsx": "export default function Page() {}" },
        prisma,
      });

      assert.equal(messages.length, 2);
      const assistantMessage = messages[1];
      assert.equal(assistantMessage.role, "ASSISTANT");
      assert.equal(assistantMessage.type, "RESULT");
      assert.equal(
        assistantMessage.content,
        "I built your e-commerce site with cart."
      );
      assert.equal(
        assistantMessage.fragments?.create?.sandboxUrl,
        "https://preview.vibe.dev"
      );
      assert.equal(
        assistantMessage.fragments?.create?.title,
        "My E-Commerce Site"
      );
    });
  });
});

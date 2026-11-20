import z from "zod";
import { Sandbox } from "@e2b/code-interpreter";
import {
  createAgent,
  createNetwork,
  createState,
  createTool,
  openai,
  Message,
  Tool,
} from "@inngest/agent-kit";

import { FRAGMENT_TITLE_PROMPT, PROMPT, RESPONSE_PROMPT } from "@/prompt";

import { inngest } from "./client";
import { getAsyncCtx } from "inngest/experimental";
import {
  extractAgentOutputText,
  handleGenerationFailure,
  loadPreviousConversationMessages,
  resolveSandboxUrl,
  saveGenerationResult,
} from "./failure";
import { executeCreateOrUpdateFilesTool } from "./files";
import { executeReadFilesTool } from "./read-files";
import {
  buildAgentSystemPrompt,
  executeRestoreProjectFiles,
  loadProjectFileSnapshot,
  reconcileFileWriteErrors,
  reconcileTerminalRecovery,
  shouldPersistFragment,
} from "./restore";
import { executeTerminalTool } from "./terminal";
import { getSandbox, lastAssistantTextMessageContent } from "./utils";

import { prisma } from "@/lib/db";
import { SANDBOX_TIMEOUT } from "./types";

interface AgentState {
  summary: string;
  files: { [path: string]: string };
  unresolvedFileErrors: Record<string, string>;
}

export const codeAgentFunctions = inngest.createFunction(
  {
    id: "code-agent",
    concurrency: [{ key: "event.data.projectId", limit: 1 }],
    onFailure: async ({ event, error, step }) => {
      await handleGenerationFailure({
        event,
        error,
        prisma,
        step,
      });
    },
  },
  { event: "code-agent/run" },
  async ({ event, step, ...args }) => {
    // Patch async context for @inngest/agent-kit v0.8.x compatibility
    const asyncCtx = (await getAsyncCtx()) as unknown as (Record<string, unknown> & { ctx?: unknown }) | null;
    if (asyncCtx && !asyncCtx.ctx) {
      asyncCtx.ctx = { step, event, ...args };
    }

    const previousSnapshot = await step.run("get-previous-files", async () => {
      return await loadProjectFileSnapshot(prisma, event.data.projectId);
    });

    if (previousSnapshot.invalidHistoricalEntries.length > 0) {
      console.warn(
        `[code-agent] Skipped ${previousSnapshot.invalidHistoricalEntries.length} invalid historical file entries for project ${event.data.projectId}:`,
        previousSnapshot.invalidHistoricalEntries
      );
    }

    const sandboxId = await step.run("get-sandbox-id", async () => {
      const sandbox = await Sandbox.create("vibe-prg1");
      await sandbox.setTimeout(SANDBOX_TIMEOUT);
      return sandbox.sandboxId;
    });

    const restoreResult = await executeRestoreProjectFiles({
      files: previousSnapshot.files,
      sandboxId,
      getSandbox,
      step,
    });

    if (!restoreResult.ok) {
      console.error(
        `[code-agent] Project file restoration failed for project ${event.data.projectId}:`,
        restoreResult.error,
        restoreResult.failedFiles
      );

      await step.run("save-restore-error", async () => {
        return await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content:
              "Something went wrong while restoring your previous project files. Please try again.",
            role: "ASSISTANT",
            type: "ERROR",
          },
        });
      });

      return {
        url: null,
        title: "Error",
        files: {},
        summary: "",
        error: restoreResult.error,
      };
    }

    const previousMessages = await step.run("get-previous-messages", async () => {
      return (await loadPreviousConversationMessages({
        projectId: event.data.projectId,
        userMessageId: event.data.userMessageId,
        prisma,
        take: 5,
      })) as Message[];
    });

    const restoredFilePaths = Object.keys(previousSnapshot.files);

    const state = createState<AgentState>(
      {
        summary: "",
        files: { ...previousSnapshot.files },
        unresolvedFileErrors: {},
      },
      {
        messages: previousMessages,
      }
    );

    const codeagent = createAgent<AgentState>({
      name: "code-agent",
      description: "An expert coding agent",
      system: buildAgentSystemPrompt(PROMPT, restoredFilePaths),
      model: openai({
        model: "gpt-4o",
        defaultParameters: { temperature: 0.5 },
      }),
      tools: [
        createTool({
          name: "terminal",
          description: "Use terminal to run commands",
          parameters: z.object({
            command: z.string(),
          }),

          handler: async (
            { command },
            { step, network }: Tool.Options<AgentState>
          ) => {
            const toolResult = await executeTerminalTool({
              command,
              sandboxId,
              getSandbox,
              step,
            });

            if (network) {
              network.state.data.unresolvedFileErrors = reconcileTerminalRecovery(
                network.state.data.unresolvedFileErrors || {},
                command,
                toolResult
              );
            }

            return toolResult;
          },
        }),

        createTool({
          name: "createOrUpdateFiles",
          description: "Create or update files in the sandbox",
          parameters: z.object({
            files: z.array(
              z.object({
                path: z.string(),
                content: z.string(),
              })
            ),
          }),
          handler: async (
            { files },
            { step, network }: Tool.Options<AgentState>
          ) => {
            const toolResult = await executeCreateOrUpdateFilesTool({
              files,
              sandboxId,
              getSandbox,
              network,
              step,
            });

            if (network) {
              network.state.data.unresolvedFileErrors = reconcileFileWriteErrors(
                network.state.data.unresolvedFileErrors || {},
                toolResult
              );
            }

            return toolResult;
          },
        }),
        createTool({
          name: "readFiles",
          description: "Read project-relative files from the sandbox",
          parameters: z.object({
            files: z.array(z.string()),
          }),
          handler: async ({ files }, { step }) => {
            return await executeReadFilesTool({
              files,
              sandboxId,
              getSandbox,
              step,
            });
          },
        }),
      ],
      lifecycle: {
        onResponse: async ({ result, network }) => {
          const lastAssistantTextMessageText =
            await lastAssistantTextMessageContent(result);

          if (lastAssistantTextMessageText && network) {
            if (lastAssistantTextMessageText.includes("<task_summary>")) {
              network.state.data.summary = lastAssistantTextMessageText;
            }
          }

          return result;
        },
      },
    });

    const network = createNetwork<AgentState>({
      name: "coding-agent-network",
      agents: [codeagent],
      maxIter: 15,
      defaultState: state,
      router: async ({ network }) => {
        const summary = network.state.data.summary;

        if (summary) {
          return;
        }
        return codeagent;
      },
    });

    const result = await network.run(event.data.value, { state });

    const isError = !shouldPersistFragment({
      summary: result.state.data.summary,
      files: result.state.data.files,
      restoredFileCount: restoredFilePaths.length,
      unresolvedFileErrors: result.state.data.unresolvedFileErrors || {},
    });

    if (isError) {
      await step.run("save-result", async () => {
        return await saveGenerationResult({
          projectId: event.data.projectId,
          isError: true,
          prisma,
        });
      });

      return {
        url: null,
        title: "Error",
        files: result.state.data.files,
        summary: result.state.data.summary,
      };
    }

    const sandboxUrl = await step.run("get-sandbox-url", async () => {
      return await resolveSandboxUrl(sandboxId, getSandbox);
    });

    const fragmentTitleGenerator = createAgent({
      name: "fragment-title-generator",
      description: "A fragment title generator",
      system: FRAGMENT_TITLE_PROMPT,
      model: openai({
        model: "gpt-4o-mini",
      }),
    });

    const responseGenerator = createAgent({
      name: "response-generator",
      description: "A response generator",
      system: RESPONSE_PROMPT,
      model: openai({
        model: "gpt-4o-mini",
      }),
    });

    const fragmentTitleOutput = await fragmentTitleGenerator
      .run(result.state.data.summary)
      .then((res) => res.output)
      .catch((err) => {
        console.warn(
          "[code-agent] Fragment title generation failed, using fallback:",
          err
        );
        return [];
      });

    const responseOutput = await responseGenerator
      .run(result.state.data.summary)
      .then((res) => res.output)
      .catch((err) => {
        console.warn(
          "[code-agent] Response generation failed, using fallback:",
          err
        );
        return [];
      });

    const title = extractAgentOutputText(fragmentTitleOutput, "Fragment");
    const content = extractAgentOutputText(responseOutput, "Response");

    await step.run("save-result", async () => {
      return await saveGenerationResult({
        projectId: event.data.projectId,
        isError: false,
        sandboxUrl,
        title,
        response: content,
        files: result.state.data.files,
        prisma,
      });
    });

    return {
      url: sandboxUrl,
      title,
      files: result.state.data.files,
      summary: result.state.data.summary,
    };
  }
);

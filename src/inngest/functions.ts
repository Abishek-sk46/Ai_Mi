import z from "zod";
import { Sandbox } from "@e2b/code-interpreter";
import {  createAgent, createNetwork, createState, createTool, openai, Message, Tool } from "@inngest/agent-kit";

import { FRAGMENT_TITLE_PROMPT, PROMPT, RESPONSE_PROMPT } from "@/prompt";

import { inngest } from "./client";
import { getAsyncCtx } from "inngest/experimental";
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
  },
  { event: "code-agent/run" },
  async ({ event, step, ...args }) => {
    // Patch async context for @inngest/agent-kit v0.8.x compatibility
    const asyncCtx = (await getAsyncCtx()) as any;
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

    const sandboxId = await step.run("get-sandbox-id" , async () => {
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

    // debug
    // After creating the sandbox
const sandbox = await getSandbox(sandboxId);

// List all files currently in the sandbox
try {
  const fileList = await sandbox.files.list("."); // E2B API to list files in root directory
  console.log("🗂 Sandbox files:", fileList);
} catch (err) {
  console.error("❌ Could not list sandbox files:", err);
}

// Check working directory
try {
  const cwd = await sandbox.commands.run("pwd");
  console.log("📂 Sandbox working directory:", cwd);
} catch (err) {
  console.error("❌ Could not get working directory:", err);
}

    const previousMessages = await step.run("get-previous-messages", async () => {
      const formattedMessages: Message[] = [];

        const messages = await prisma.message.findMany({
          where: {
            projectId: event.data.projectId,
          },
          orderBy: {
            createdAt: "desc",
          },
          take:5,
        });

        for( const message of messages){
          formattedMessages.push({
            type: "text",
            role: message.role === "ASSISTANT" ? "assistant" : "user",
            content: message.content,
          })
        }

        return formattedMessages.reverse();
      
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
      },
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

          handler: async ({ command }, { step, network }: Tool.Options<AgentState>) => {
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
              }),
            ),
          }),
          handler: async ({ files }, { step, network }: Tool.Options<AgentState>) => {
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
        onResponse: async ({ result, network}) => {
          const lastAssistantTextMessageText = 
            await lastAssistantTextMessageContent(result);

            if(lastAssistantTextMessageText && network) {
              if(lastAssistantTextMessageText.includes("<task_summary>")) {
                network.state.data.summary= lastAssistantTextMessageText
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
      }
    });

    const result = await network.run(event.data.value, { state });



    // 9.53.28
    const fragmentTitleGenerator = createAgent({
      name: "fragment-title-generator",
      description: "A fragment title generator",
      system: FRAGMENT_TITLE_PROMPT,
      model: openai({
        model: "gpt-4o-mini",
      })


    })

    const responseGenerator = createAgent({
      name: "response-generator",
      description: "A response generator",
      system: RESPONSE_PROMPT,
      model: openai({
        model: "gpt-4o-mini",
      })


    });

    const { output: fragmentTitleOutput } = await fragmentTitleGenerator.run(result.state.data.summary);
    const { output: responseOutput } = await responseGenerator.run(result.state.data.summary);
    const generateFragmentTitle = () => {
      if (fragmentTitleOutput[0].type !== "text") {
        return "Fragment";
      }

      if (Array.isArray(fragmentTitleOutput[0].content)) {
        return fragmentTitleOutput[0].content.map((txt) => txt).join("")
      } else{
        return fragmentTitleOutput[0].content;
      }
    }

      const generateResponse = () => {
      if (responseOutput[0].type !== "text") {
        return "Response";
      }

      if (Array.isArray(responseOutput[0].content)) {
        return responseOutput[0].content.map((txt) => txt).join("")
      } else{
        return responseOutput[0].content;
      }
    }

    const isError = !shouldPersistFragment({
      summary: result.state.data.summary,
      files: result.state.data.files,
      restoredFileCount: restoredFilePaths.length,
      unresolvedFileErrors: result.state.data.unresolvedFileErrors || {},
    });


    const sandboxUrl = await step.run("get-sandbox-url" , async () => {
      const sandbox = await getSandbox(sandboxId);
      const host = sandbox.getHost(3000);
      return `https://${host}`;
    });

    await step.run("save-result", async () =>{


      if(isError){
        return await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: "Something went wrong.Please try again",
            role:"ASSISTANT",
            type: "ERROR",
          },
        });
      }


      return await prisma.message.create({
        data: {
          projectId: event.data.projectId,
          content : generateResponse(),
          role: "ASSISTANT",
          type: "RESULT",
          fragments: {
            create: {
              sandboxUrl: sandboxUrl,
              title: generateFragmentTitle(),
              files: result.state.data.files,
            },
          },
        },
      })
    });


    

    return {
      url: sandboxUrl,
      title: "Fragment",
      files: result.state.data.files,
      summary: result.state.data.summary,
    };
  }
);

import { createAgent, gemini } from "@inngest/agent-kit";
import { inngest } from "./client";
import { Sandbox } from "@e2b/code-interpreter";
import { getSandbox } from "./utils";

export const helloWorld = inngest.createFunction(
  { id: "hello-world" },
  { event: "test/hello.world" },
  async ({ event, step }) => {
    const sandboxId = await step.run("get-sandbox-id" , async () => {
      const sandbox = await Sandbox.create("vibe-prg1");
      return sandbox.sandboxId;
    });
    
    const codeagent = createAgent({
      name: "code-agent",
      system: "You are an expert next.js developer . You write readable , maintainable code. you write simple Next.js & React snippets",
      model: gemini({ model: "gemini-1.5-flash" }),
    });

    const output = await codeagent.run(`Write the following code snippet: ${event.data.value}`);

    const sandboxUrl = await step.run("get-sandbox-url" , async () => {
      const sandbox = await getSandbox(sandboxId);
      const host = sandbox.getHost(3000);
      return `https://${host}`;
    });

    return { output , sandboxUrl};
  }
);

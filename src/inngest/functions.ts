import { createAgent, gemini } from "@inngest/agent-kit";
import { inngest } from "./client";

export const helloWorld = inngest.createFunction(
  { id: "hello-world" },
  { event: "test/hello.world" },
  async ({ event }) => {
    console.log('Inngest received event:', event);
    console.log('Event data:', event.data);
    console.log('Event data value:', event.data.value);
    
    const summerize = createAgent({
      name: "sumerizer",
      system: "You are a helpful assistant that summarizes text.",
      model: gemini({ model: "gemini-1.5-flash" }),
    });

    const textToSummarize = event.data.value || "No text provided";
    const output = await summerize.run(`Summarize the following text: ${textToSummarize}`);

    return { output };
  }
);

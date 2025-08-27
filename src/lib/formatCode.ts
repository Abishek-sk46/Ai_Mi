import prettier from "prettier";
import { ESLint } from "eslint";

export async function formatCode(code: string): Promise<string> {
  // Step 1: Prettier formats the code
  let pretty = await prettier.format(code, { parser: "typescript" });

  // Step 2: ESLint fixes small mistakes
  const eslint = new ESLint({ fix: true });
  const results = await eslint.lintText(pretty, { filePath: "file.tsx" });
  const fixed = results[0].output || pretty;

  return fixed;
}
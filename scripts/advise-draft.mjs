import { TypeSafeClient } from "@typesafe-ai/sdk";
import { routePrompt } from "./codex-router.mjs";

async function main() {
  if (!process.env.TYPESAFE_API_KEY) throw new Error("请先在项目 .env 配置 TYPESAFE_API_KEY");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 32_000) throw new Error("草稿过长，无法分析");
  }
  const { prompt, priority = "balanced" } = JSON.parse(input);
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Codex 输入框为空");
  const result = await routePrompt(prompt, new TypeSafeClient(), priority);
  // Only the recommendation crosses back to the native overlay; never echo the draft.
  process.stdout.write(JSON.stringify({
    model: result.model,
    effort: result.effort,
    taskKind: result.taskKind,
    reasoningDepth: result.reasoningDepth,
    needsHumanReview: result.needsHumanReview,
  }));
}

main().catch((error) => {
  process.stderr.write(String(error?.message ?? error));
  process.exitCode = 1;
});

import { TypeSafeClient } from "@typesafe-ai/sdk";
import { routePrompt } from "./codex-router.mjs";
import { readQuota, quotaSummary, applyQuota } from './codex-quota.mjs';

async function main() {
  if (!process.env.TYPESAFE_API_KEY) throw new Error("请先在项目 .env 配置 TYPESAFE_API_KEY");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 32_000) throw new Error("草稿过长，无法分析");
  }
  const { prompt, priority = "balanced", considerQuota = true } = JSON.parse(input);
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Codex 输入框为空");
  const started = performance.now();
  let quotaMs = 0;
  const quotaPromise = (considerQuota ? readQuota() : Promise.resolve(null)).then(snapshot => {
    quotaMs = Math.round(performance.now() - started);
    return snapshot;
  });
  const recommendation = await routePrompt(prompt, new TypeSafeClient(), priority);
  const jevMs = Math.round(performance.now() - started);
  emit(applyQuota(recommendation, { low: false, text: considerQuota ? '额度查询中…结果返回后自动更新' : '额度参考已关闭' }), { jevMs });
  if (considerQuota) {
    const snapshot = await quotaPromise;
    emit(applyQuota(recommendation, quotaSummary(snapshot)), { jevMs, quotaMs });
  }
}

function emit(result, timings) {
  // Only the recommendation crosses back to the native overlay; never echo the draft.
  process.stdout.write(JSON.stringify({
    model: result.model,
    effort: result.effort,
    taskKind: result.taskKind,
    reasoningDepth: result.reasoningDepth,
    needsHumanReview: result.needsHumanReview,
    quotaText: result.quotaText,
    budgetAdjusted: result.budgetAdjusted,
    timings,
  }) + '\n');
}

main().catch((error) => {
  process.stderr.write(String(error?.message ?? error));
  process.exitCode = 1;
});

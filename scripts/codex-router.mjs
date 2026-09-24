#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

const MAX_INPUT_CHARS = 8_000;
// Codex credit rates per 1M input/output tokens. These are not per-task estimates.
export const MODELS = [
  { model: "gpt-5.6-luna", tier: 1, input: 5, output: 30 },
  { model: "gpt-5.6-terra", tier: 2, input: 50, output: 300 },
  { model: "gpt-5.6-sol", tier: 3, input: 100, output: 500 },
  { model: "gpt-6-astra", tier: 4, input: 250, output: 1250 },
];

export function recommend(answers, priority = "balanced") {
  const kind = answers.task_kind?.choice;
  const depth = answers.reasoning_depth?.choice;
  const sensitive = answers.high_stakes?.noul;

  if (!kind || !depth || !Number.isFinite(sensitive)) {
    throw new Error("Jev 返回了不完整的判断结果");
  }

  if (!["balanced", "cost", "quality", "speed"].includes(priority)) throw new Error(`未知优化目标: ${priority}`);
  const baseTier = { quick: 1, routine: 2, complex_code: 3, research_design: 4, other: 2 }[kind];
  if (!baseTier) throw new Error(`未知任务类型: ${kind}`);
  // Capability floor is a policy heuristic, not a measured model benchmark.
  let minimumTier = Math.min(4, baseTier + (depth === "deep" && baseTier < 3 ? 1 : 0));
  if (sensitive >= 0.7) minimumTier = 4;
  const selectedTier = priority === "quality" ? Math.min(4, minimumTier + 1) : minimumTier;
  const selected = MODELS[selectedTier - 1];
  const effort = depth === "deep" ? (selectedTier >= 3 ? "xhigh" : "high")
    : depth === "light" ? "low" : selectedTier >= 3 ? "high" : "medium";

  return {
    model: selected.model,
    effort,
    priority,
    minimumCapabilityTier: minimumTier,
    pricing: { inputCreditsPerMillion: selected.input, outputCreditsPerMillion: selected.output },
    pricingNote: "公开 Codex credit 档位；实际消耗还取决于上下文、工具、缓存和输出长度。能力/速度排序为规则假设，未经你的任务集实测。",
    taskKind: kind,
    reasoningDepth: depth,
    highStakesProbability: sensitive,
    needsHumanReview: sensitive >= 0.7,
  };
}

export async function routePrompt(prompt, client = new TypeSafeClient(), priority = "balanced") {
  if (!prompt.trim()) throw new Error("请输入任务内容，或通过 stdin 传入");
  if (prompt.length > MAX_INPUT_CHARS) {
    throw new Error(`输入超过 ${MAX_INPUT_CHARS} 字；请提供任务摘要而非整份文件`);
  }
  const response = await client.systemOne({
    model: "jev-latest",
    state: { user_request: prompt },
    questions: {
      task_kind: choice(
        "Which task family best describes the main work requested in `user_request`? Judge the work required, not the length or politeness of the message.",
        {
          quick: "Short explanation, translation, summary, simple command, or a small factual question with little investigation.",
          routine: "Ordinary coding or writing task with limited scope and straightforward verification.",
          complex_code: "Multi-file coding, difficult debugging, architecture implementation, security review, or substantial testing.",
          research_design: "Open-ended research, ambiguous design tradeoffs, deep synthesis, or a large cross-system task.",
          other: "None of the task families above fits well or the request is too unclear to classify.",
        },
      ),
      reasoning_depth: choice(
        "How much reasoning is needed to complete `user_request` reliably, considering ambiguity, dependencies, and verification?",
        {
          light: "Little reasoning: direct response or a very small, clear change.",
          normal: "Some investigation or planning, but bounded scope and familiar steps.",
          deep: "Several uncertain dependencies, competing designs, difficult diagnosis, or extensive validation.",
        },
      ),
      high_stakes: noul(
        "A wrong answer or action on `user_request` could materially affect security, privacy, finances, health, legal rights, production data, or irreversible external state.",
        { true: "A material high-stakes consequence is plausible", false: "Consequences are limited or readily reversible" },
      ),
    },
  });
  return { ...recommend(response.answers, priority), usage: response.usage ?? null };
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const unknown = [...flags].filter((flag) => !["--json", "--run", "--help"].includes(flag) && !flag.startsWith("--priority="));
  if (unknown.length) throw new Error(`未知参数: ${unknown.join(", ")}`);
  const priorities = [...flags].filter((flag) => flag.startsWith("--priority="));
  if (priorities.length > 1) throw new Error("只能指定一个 --priority");
  const priority = priorities[0]?.split("=")[1] ?? "balanced";
  const text = argv.filter((arg) => !arg.startsWith("--")).join(" ");
  return { json: flags.has("--json"), run: flags.has("--run"), help: flags.has("--help"), priority, text };
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > MAX_INPUT_CHARS) throw new Error("stdin 输入过长");
  }
  return text;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("用法: node --env-file=.env scripts/codex-router.mjs [--json] [--run] [--priority=balanced|cost|quality|speed] [任务文字]\n不传任务文字时从 stdin 读取。默认只推荐；--run 会启动新的 codex exec。");
    return;
  }
  if (!process.env.TYPESAFE_API_KEY) throw new Error("缺少 TYPESAFE_API_KEY；可用 node --env-file=.env 启动");
  const prompt = args.text || (process.stdin.isTTY ? "" : await readStdin());
  console.error("提示：任务文本将发送给 TypeSafe/Jev 作分类；不要传入密钥、密码或未脱敏的个人资料。");
  const result = await routePrompt(prompt, new TypeSafeClient(), args.priority);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`建议：${result.model} / ${result.effort}\n任务：${result.taskKind}；深度：${result.reasoningDepth}；目标：${result.priority}${result.needsHumanReview ? "；建议人工复核" : ""}\n公开费率：输入 ${result.pricing.inputCreditsPerMillion}、输出 ${result.pricing.outputCreditsPerMillion} credits / 百万 token（不是本次预估费用）`);

  if (!args.run) return;
  console.error("正在以推荐配置启动一个新的 Codex CLI 任务（不会切换当前桌面任务）…");
  const child = spawn("codex", ["exec", "-m", result.model, "-c", `model_reasoning_effort=\"${result.effort}\"`, "-"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin.end(prompt);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`分流失败：${error.message}`);
    process.exitCode = 1;
  });
}

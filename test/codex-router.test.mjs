import test from "node:test";
import assert from "node:assert/strict";
import { recommend, routePrompt } from "../scripts/codex-router.mjs";

const answers = (taskKind, reasoningDepth, risk = 0.1) => ({
  task_kind: { choice: taskKind },
  reasoning_depth: { choice: reasoningDepth },
  high_stakes: { noul: risk },
});

test("routes a quick task to Luna low", () => {
  assert.deepEqual(
    [recommend(answers("quick", "light")).model, recommend(answers("quick", "light")).effort],
    ["gpt-5.6-luna", "low"],
  );
});

test("escalates a deep coding task", () => {
  assert.equal(recommend(answers("complex_code", "deep")).effort, "xhigh");
});

test("high-stakes work gets an Astra floor and human review", () => {
  const result = recommend(answers("quick", "light", 0.9));
  assert.equal(result.model, "gpt-6-astra");
  assert.equal(result.needsHumanReview, true);
});

test("quality priority buys one capability tier of headroom", () => {
  const result = recommend(answers("routine", "normal"), "quality");
  assert.equal(result.model, "gpt-5.6-sol");
  assert.deepEqual(result.pricing, { inputCreditsPerMillion: 100, outputCreditsPerMillion: 500 });
});

test("cost priority respects a high-stakes capability floor", () => {
  assert.equal(recommend(answers("quick", "light", 0.9), "cost").model, "gpt-6-astra");
});

test("mock client receives only bounded questions and supplied prompt", async () => {
  const client = {
    systemOne: async (payload) => {
      assert.deepEqual(payload.state, { user_request: "修复跨文件登录缺陷" });
      assert.deepEqual(Object.keys(payload.questions), ["task_kind", "reasoning_depth", "high_stakes"]);
      return { answers: answers("complex_code", "deep"), usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const result = await routePrompt("修复跨文件登录缺陷", client);
  assert.equal(result.model, "gpt-5.6-sol");
});

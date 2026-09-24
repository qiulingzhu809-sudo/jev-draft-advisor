import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaSummary, applyQuota, readQuota } from '../scripts/codex-quota.mjs';
import { recommend } from '../scripts/codex-router.mjs';
const now = 1800000000000;
const window = (usedPercent, seconds = 7200) => ({ usedPercent, resetsAt: now / 1000 + seconds, windowDurationMins: 10080 });
const answers = depth => ({ task_kind: { choice: 'complex_code' }, reasoning_depth: { choice: depth }, high_stakes: { noul: 0.1 } });

test('timeout identifies initialization versus quota request and closes the client', async () => {
  for (const initialized of [false, true]) {
    let closed = false;
    const never = () => new Promise(() => {});
    const client = { initialize: initialized ? async () => {} : never, request: never, close: () => { closed = true; } };
    const result = await readQuota(15, () => client);
    assert.match(result.unavailableReason, initialized ? /请求账户额度超时/ : /初始化 Codex超时/);
    assert.equal(closed, true);
  }
});

test('successful request provides separate initialization and total timings', async () => {
  const snapshot = {rateLimits:{primary:window(10)}};
  const result = await readQuota(100, () => ({ initialize:async()=>{},request:async()=>snapshot,close:()=>{} }));
  assert.deepEqual(result.rateLimits,snapshot.rateLimits);
  assert.ok(result.queryTimings.totalMs >= result.queryTimings.initializedMs);
});

test('missing, expired, invalid and unrelated windows are unknown, not empty', () => {
  for (const snapshot of [null, {rateLimits:{primary:window(null)}}, {rateLimits:{primary:window(99,-1)}}, {rateLimitsByLimitId:{other:{primary:window(99)}}}]) {
    assert.equal(quotaSummary(snapshot,now).low,false);
    assert.match(quotaSummary(snapshot,now).text,/未知/);
  }
});
test('uses stricter window and reports reset credits without redeeming', () => {
  const q=quotaSummary({rateLimits:{primary:window(6),secondary:window(95)},rateLimitResetCredits:{availableCount:2}},now);
  assert.equal(q.low,true);
  assert.match(q.text,/手动确认/);
  assert.equal(q.resetCount,2);
});
test('suggests waiting when constrained windows reset soon', () => {
  assert.match(quotaSummary({rateLimits:{primary:window(95,600)}},now).text,/等待自然重置/);
});
test('quota conserves optional effort but preserves deep work and quality', () => {
  const q={low:true,text:'low'};
  assert.equal(applyQuota(recommend(answers('normal')),q).effort,'low');
  assert.equal(applyQuota(recommend(answers('deep')),q).effort,'xhigh');
  assert.equal(applyQuota(recommend(answers('normal'),'quality'),q).effort,'high');
  const highRisk={...answers('normal'),high_stakes:{noul:0.9}};
  assert.equal(applyQuota(recommend(highRisk),q).budgetAdjusted,false);
});
test('cost and speed differ from balanced on appropriate tasks', () => {
  assert.equal(recommend(answers('normal'),'cost').effort,'low');
  assert.equal(recommend(answers('normal'),'balanced').effort,'high');
  assert.equal(recommend(answers('deep'),'speed').effort,'high');
  assert.equal(recommend(answers('deep'),'balanced').effort,'xhigh');
});
test('missing Codex executable degrades without hanging', async () => {
  const previous=process.env.JEV_CODEX_BIN;
  process.env.JEV_CODEX_BIN='/nonexistent/jev-test-codex';
  try { assert.match((await readQuota(100)).unavailableReason,/找不到 Codex/); }
  finally { if(previous===undefined)delete process.env.JEV_CODEX_BIN;else process.env.JEV_CODEX_BIN=previous; }
});

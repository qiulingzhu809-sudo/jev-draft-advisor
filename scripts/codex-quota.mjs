import { CodexAppClient } from './codex-app-client.mjs';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

export function resolveCodexCommand(env = process.env) {
  if (env.JEV_CODEX_BIN) return env.JEV_CODEX_BIN;
  const candidates = (env.PATH || '').split(delimiter).filter(Boolean).map(p => join(p, 'codex'));
  candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex',
    join(homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'), join(homedir(), 'Applications/Codex.app/Contents/Resources/codex'));
  return candidates.find(p => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } }) || 'codex';
}

export function quotaError(error) {
  if (error?.code === 'ENOENT') return '找不到 Codex 程序，请设置 JEV_CODEX_BIN';
  if (/timeout/i.test(error?.message || '')) return '额度查询超时，请检查网络后重试';
  if (/auth|login|401|登录/i.test(error?.message || '')) return 'Codex 登录不可用，请检查 CLI 登录账户';
  return 'Codex 额度接口不可用，请检查网络或 CLI 状态';
}

// Read-only: no login, thread creation, purchase, or reset redemption.
export async function readQuota(timeoutMs = 20000, createClient = () => new CodexAppClient(() => {}, resolveCodexCommand())) {
  const client = createClient();
  const started = performance.now();
  let stage = '启动/初始化 Codex';
  let initializedMs = null;
  let timer;
  try {
    return await Promise.race([
      (async () => {
        await client.initialize();
        initializedMs = Math.round(performance.now() - started);
        stage = '请求账户额度';
        const snapshot = await client.request('account/rateLimits/read');
        return { ...snapshot, queryTimings: { initializedMs, totalMs: Math.round(performance.now() - started) } };
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
  } catch (error) {
    const timeout = /timeout/i.test(error?.message || '');
    return { unavailableReason: timeout ? `${stage}超时（${Math.round(timeoutMs / 1000)}秒），可稍后重试` : quotaError(error),
      queryTimings: { initializedMs, totalMs: Math.round(performance.now() - started), stage } };
  }
  finally { clearTimeout(timer); client.close(); }
}

export function quotaSummary(snapshot, now = Date.now()) {
  const bucket = snapshot?.rateLimitsByLimitId
    ? snapshot.rateLimitsByLimitId.codex : snapshot?.rateLimits;
  const windows = [bucket?.primary, bucket?.secondary].filter(w =>
    w && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 &&
    Number.isFinite(w.resetsAt) && w.resetsAt * 1000 > now);
  if (!windows.length) return { low: false, text: `额度未知：${snapshot?.unavailableReason || '未返回有效额度窗口'}；按任务与偏好推荐`, resetCount: null };
  const remaining = Math.min(...windows.map(w => 100 - w.usedPercent));
  const text = windows.map(w => {
    const duration = w.windowDurationMins === 10080 ? '周' : w.windowDurationMins === 300 ? '5小时' : '窗口';
    const date = new Date(w.resetsAt * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    return `${duration}剩余${100 - w.usedPercent}% · ${date}重置`;
  }).join('；');
  const count = snapshot?.rateLimitResetCredits?.availableCount;
  const resetCount = Number.isInteger(count) && count >= 0 ? count : null;
  const expiries = (snapshot?.rateLimitResetCredits?.credits || []).filter(c =>
    c.status === 'available' && Number.isFinite(c.expiresAt) && c.expiresAt * 1000 > now).map(c => c.expiresAt * 1000);
  const expiry = expiries.length ? `，最早${new Date(Math.min(...expiries)).toLocaleDateString('zh-CN')}到期` : '';
  const constrained = windows.filter(w => w.usedPercent >= 90);
  const soon = constrained.length > 0 && constrained.every(w => w.resetsAt * 1000 - now <= 3600000);
  const advice = remaining <= 10 ? (soon ? '；可考虑等待自然重置' : resetCount > 0 ? '；急用时可手动确认使用重置机会' : '；建议节省额度或等待重置') : '';
  return { low: remaining <= 20, resetCount, text: `${text}${resetCount === null ? '；重置机会未知' : `；重置机会${resetCount}次${expiry}`}${advice}` };
}

export function applyQuota(result, quota) {
  // Preserve task capability and explicit quality preference; only reduce optional effort.
  if (quota.low && result.priority !== 'quality' && !result.needsHumanReview && result.reasoningDepth !== 'deep') {
    return { ...result, effort: 'low', quotaText: quota.text, budgetAdjusted: true };
  }
  return { ...result, quotaText: quota.text, budgetAdjusted: false };
}

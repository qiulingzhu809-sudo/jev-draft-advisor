#!/usr/bin/env node
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { MODELS, routePrompt } from "./codex-router.mjs";
import { CodexAppClient } from "./codex-app-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.SMART_COMPOSE_PORT ?? 8787);
const csrf = randomBytes(24).toString("hex");
const subscribers = new Set();
let catalog = [];
let analyzed = null;
let active = null;
const completedThreads = new Map();

function publish(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subscribers) res.write(data);
}

let codex = null;
function releaseWhenIdle(client, threadId) {
  setTimeout(() => {
    if (codex !== client || active) return;
    if (client.pending.size) return releaseWhenIdle(client, threadId);
    codex = null;
    client.close();
    publish({ type: "released", threadId });
  }, 100);
}
function createCodexClient() {
  const client = new CodexAppClient((event) => {
    if (event.type === "codex") {
      if (event.method === "turn/completed") {
        completedThreads.set(event.params?.threadId, event.params?.turn?.status ?? "completed");
        if (event.params?.threadId === active?.threadId) {
          active = null;
          releaseWhenIdle(client, event.params?.threadId);
        }
      }
      if (!["turn/completed", "error"].includes(event.method)) return;
    }
    publish(event);
  });
  return client;
}
async function ensureCodex() {
  if (codex) return codex;
  codex = createCodexClient();
  await codex.initialize();
  return codex;
}

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function json(res, status, value) { res.writeHead(status, headers); res.end(JSON.stringify(value)); }
async function body(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error("只接受 JSON 请求");
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 40_000) throw new Error("请求过长");
  }
  return JSON.parse(data);
}

function availableOptions() {
  return catalog.filter((m) => !m.hidden).map((m) => ({
    model: m.model ?? m.id,
    name: m.displayName ?? m.model ?? m.id,
    efforts: (m.supportedReasoningEfforts ?? []).map((x) => x.reasoningEffort),
  }));
}

function pick(recommendation) {
  const options = availableOptions();
  const desiredIndex = MODELS.findIndex((m) => m.model === recommendation.model);
  const candidates = MODELS.slice(desiredIndex).map((m) => options.find((x) => x.model === m.model)).filter(Boolean);
  const chosen = candidates[0];
  if (!chosen) throw new Error("当前 Codex 账号没有满足建议能力门槛的可用模型；请手动检查模型权限");
  const efforts = chosen.efforts;
  const requested = recommendation.effort;
  const effort = efforts.includes(requested) ? requested : efforts.includes("high") ? "high" : efforts.includes("medium") ? "medium" : efforts[0];
  if (!effort) throw new Error("Codex 未提供该模型的推理强度信息");
  return { model: chosen.model, effort };
}

async function handle(req, res) {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: "无效 Host" });
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'self'" });
    res.end(await readFile(join(here, "smart-compose.html")));
    return;
  }
  if (req.method === "GET" && req.url === "/smart-compose.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end(await readFile(join(here, "smart-compose.js")));
    return;
  }
  if (req.method === "GET" && req.url === "/api/session") return json(res, 200, { csrf, models: availableOptions(), cwd: process.cwd() });
  if (req.method === "GET" && req.url === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    subscribers.add(res);
    req.on("close", () => subscribers.delete(res));
    return;
  }
  if (req.method !== "POST" || !["/api/analyze", "/api/send", "/api/approval"].includes(req.url)) return json(res, 404, { error: "Not found" });
  if (req.headers.origin !== `http://127.0.0.1:${port}` && req.headers.origin !== `http://localhost:${port}`) return json(res, 403, { error: "来源校验失败" });
  if (req.headers["x-csrf-token"] !== csrf) return json(res, 403, { error: "请求令牌无效" });
  const input = await body(req);
  if (req.url === "/api/analyze") {
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt || prompt.length > 8000) throw new Error("任务内容须为 1–8000 字");
    const recommendation = await routePrompt(prompt, new TypeSafeClient(), input.priority ?? "balanced");
    const selection = pick(recommendation);
    analyzed = { prompt, selection, ticket: randomBytes(16).toString("hex"), expires: Date.now() + 5 * 60_000 };
    return json(res, 200, { recommendation, selection, ticket: analyzed.ticket, models: availableOptions() });
  }
  if (req.url === "/api/send") {
    if (active) throw new Error("当前任务尚未结束，请等待完成");
    if (!analyzed || input.ticket !== analyzed.ticket || Date.now() > analyzed.expires) throw new Error("请先重新分析任务");
    const prompt = String(input.prompt ?? "").trim();
    if (prompt !== analyzed.prompt) throw new Error("任务内容已变化，请重新分析");
    const chosen = availableOptions().find((x) => x.model === input.model && x.efforts.includes(input.effort));
    if (!chosen) throw new Error("所选模型或强度不可用");
    const cwd = await realpath(String(input.cwd ?? ""));
    if (!(await stat(cwd)).isDirectory()) throw new Error("工作目录不是文件夹");
    analyzed = null;
    active = { pending: true };
    try {
      const client = await ensureCodex();
      const result = await client.start(prompt, input.model, input.effort, cwd);
      const status = completedThreads.get(result.threadId);
      active = status ? null : result;
      if (status) releaseWhenIdle(client, result.threadId);
      return json(res, 200, { ...result, completed: Boolean(status), status });
    } catch (error) { active = null; throw error; }
  }
  if (!codex) throw new Error("任务已释放；没有待处理的审批");
  codex.approve(input.id, input.decision);
  return json(res, 200, { ok: true });
}

if (!process.env.TYPESAFE_API_KEY) throw new Error("缺少 TYPESAFE_API_KEY；请在本仓库 .env 配置并用 node --env-file=.env 启动");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("SMART_COMPOSE_PORT 无效");
codex = createCodexClient();
await codex.initialize();
catalog = await codex.models();
const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => json(res, 400, { error: error.message }));
});
server.listen(port, "127.0.0.1", () => console.log(`智能发送框：http://127.0.0.1:${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.close(); codex?.close(); });

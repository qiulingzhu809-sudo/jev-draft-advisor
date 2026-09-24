import { spawn } from "node:child_process";
import readline from "node:readline";

export class CodexAppClient {
  constructor(onEvent = () => {}, command = "codex") {
    this.onEvent = onEvent;
    this.proc = spawn(command, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.nextId = 1;
    this.pending = new Map();
    this.approvals = new Map();
    this.ready = false;
    this.closing = false;
    this.proc.on("error", (error) => { if (!this.closing) this.failAll(error); });
    this.proc.on("exit", (code) => { if (!this.closing) this.failAll(new Error(`Codex App Server 已退出 (${code})`)); });
    this.proc.stderr.on("data", (chunk) => this.onEvent({ type: "diagnostic", text: String(chunk).slice(0, 1000) }));
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => {
      try { this.handle(JSON.parse(line)); }
      catch (error) { this.onEvent({ type: "error", text: `协议解析失败：${error.message}` }); }
    });
  }

  write(message) {
    if (!this.proc.stdin.writable) throw new Error("Codex App Server 未运行");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ method, id, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  handle(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) {
        this.approvals.set(String(message.id), message);
        this.onEvent({ type: "approval", id: String(message.id), method: message.method, params: message.params });
      } else {
        // An unknown request must not remain pending or be silently approved.
        this.write({ id: message.id, error: { code: -32601, message: "此客户端暂不支持该交互，请在 Codex 原生客户端完成。" } });
        this.onEvent({ type: "error", text: `不支持的交互：${message.method}` });
      }
      return;
    }
    this.onEvent({ type: "codex", method: message.method, params: message.params });
  }

  async initialize() {
    await this.request("initialize", { clientInfo: { name: "jev_smart_compose", title: "Jev Smart Compose", version: "0.1.0" } });
    this.write({ method: "initialized", params: {} });
    this.ready = true;
  }

  async models() {
    if (!this.ready) throw new Error("App Server 尚未初始化");
    const result = await this.request("model/list", { limit: 100, includeHidden: false });
    return result.data ?? [];
  }

  async start(prompt, model, effort, cwd) {
    const started = await this.request("thread/start", { cwd, model });
    const threadId = started.thread?.id;
    if (!threadId) throw new Error("Codex 未返回任务 ID");
    const name = prompt.replace(/\s+/g, " ").trim().slice(0, 60);
    let titleSet = true;
    await this.request("thread/name/set", { threadId, name }).catch((error) => {
      titleSet = false;
      this.onEvent({ type: "error", text: `任务已创建，但标题设置失败：${error.message}` });
    });
    const turn = await this.request("turn/start", {
      threadId, input: [{ type: "text", text: prompt }], cwd, model, effort,
    });
    return { threadId, turnId: turn.turn?.id, title: titleSet ? name : null };
  }

  approve(id, decision) {
    const request = this.approvals.get(String(id));
    if (!request) throw new Error("审批请求不存在或已处理");
    if (!["accept", "decline", "cancel"].includes(decision)) throw new Error("无效的审批决定");
    this.approvals.delete(String(id));
    this.write({ id: request.id, result: { decision } });
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.onEvent({ type: "error", text: error.message });
  }

  close() {
    this.closing = true;
    this.proc.stdin.end();
    this.proc.kill();
  }
}

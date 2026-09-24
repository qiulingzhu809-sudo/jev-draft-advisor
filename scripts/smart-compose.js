const $ = (id) => document.getElementById(id);
let csrf = "", ticket = "", models = [], currentPrompt = "";
let threadId = null, activeTurnId = null, sending = false;
let earlyEvents = [];

function status(message) { $("status").textContent = message; }
async function api(path, payload) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
function fillOptions(select, values, chosen) {
  select.replaceChildren();
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value.value;
    option.textContent = value.label;
    select.append(option);
  }
  select.value = chosen;
}
function updateEfforts(preferred) {
  const model = models.find((item) => item.model === $("model").value);
  fillOptions($("effort"), (model?.efforts ?? []).map((value) => ({ value, label: value })), preferred ?? model?.efforts[0]);
}
function finishTurn(turn) {
  if (turn?.id !== activeTurnId) return;
  activeTurnId = null;
  sending = false;
  $("newTask").disabled = false;
  $("handoff-state").textContent = turn.status === "completed"
    ? "首轮已完成，正在释放本地会话；稍后请到 Codex 原生任务中继续对话。"
    : `首轮状态：${turn.status ?? "未知"}，正在释放本地会话。`;
  status("首轮已结束；正在释放 Jev 服务持有的会话。 ");
}

const session = await fetch("/api/session").then((response) => response.json());
csrf = session.csrf;
models = session.models;
$("cwd").value = session.cwd;
const events = new EventSource("/api/events");
events.onerror = () => {
  if (sending) status("审批事件通道已断开；请保持本地服务运行并刷新页面前先检查 Codex 任务状态。");
};
function handleEvent(item) {
  if (sending && !threadId && ["approval", "codex"].includes(item.type)) {
    earlyEvents.push(item);
    return;
  }
  if (item.type === "approval") {
    if (!threadId || item.params?.threadId !== threadId) return;
    const article = document.createElement("article");
    const label = document.createElement("div");
    label.textContent = `${item.method.includes("command") ? "命令执行" : "文件修改"}需要批准：${item.params?.reason ?? item.params?.command ?? "请核对操作"}`;
    article.append(label);
    for (const decision of ["accept", "decline"]) {
      const button = document.createElement("button");
      button.className = decision === "decline" ? "secondary" : "";
      button.textContent = decision === "accept" ? "允许这次" : "拒绝";
      button.onclick = async () => {
        try { await api("/api/approval", { id: item.id, decision }); article.remove(); }
        catch (error) { status(error.message); }
      };
      article.append(button);
    }
    $("approvals").append(article);
  } else if (item.type === "codex") {
    const params = item.params ?? {};
    if (!threadId || params.threadId !== threadId) return;
    if (item.method === "turn/completed") finishTurn(params.turn);
    if (item.method === "error") status(params.error?.message ?? "Codex 运行错误");
  } else if (item.type === "released" && item.threadId === threadId) {
    $("handoff-state").textContent = "本地会话已释放。请在 Codex 任务列表中打开本任务，继续原生对话。";
    status("已释放到 Codex 桌面版；网页不再占用此任务。");
  } else if (item.type === "error") status(item.text);
}
events.onmessage = (event) => handleEvent(JSON.parse(event.data));

$("model").onchange = () => updateEfforts();
for (const id of ["prompt", "priority"]) $(id).addEventListener("input", () => { ticket = ""; $("result").hidden = true; });
async function analyze(autoSend = false) {
  $("analyze").disabled = true;
  $("smartSend").disabled = true;
  status("Jev 正在判断任务…");
  try {
    currentPrompt = $("prompt").value.trim();
    const data = await api("/api/analyze", { prompt: currentPrompt, priority: $("priority").value });
    ticket = data.ticket;
    models = data.models;
    fillOptions($("model"), models.map((item) => ({ value: item.model, label: item.name })), data.selection.model);
    updateEfforts(data.selection.effort);
    $("reason").textContent = `Jev 判断：${data.recommendation.taskKind} / ${data.recommendation.reasoningDepth}；最低能力档 ${data.recommendation.minimumCapabilityTier}；推荐 ${data.selection.model} / ${data.selection.effort}${data.recommendation.needsHumanReview ? "；请人工复核结果" : ""}。`;
    $("cost").textContent = `推荐档公开费率：输入 ${data.recommendation.pricing.inputCreditsPerMillion}、输出 ${data.recommendation.pricing.outputCreditsPerMillion} credits / 百万 token；不是本次费用预测。`;
    $("result").hidden = false;
    if (autoSend && !data.recommendation.needsHumanReview) await sendTask();
    else status(data.recommendation.needsHumanReview && autoSend ? "检测到较高风险，请先核对再手动发送。" : "请核对工作目录、模型和强度，再发送到 Codex。");
  } catch (error) { status(error.message); }
  finally { $("analyze").disabled = false; $("smartSend").disabled = false; }
}
async function sendTask() {
  if (sending) return;
  if (!ticket || $("prompt").value.trim() !== currentPrompt) return status("任务已更改，请重新分析");
  if (events.readyState !== EventSource.OPEN) return status("审批事件通道未连接，暂不启动任务；请稍后重试。");
  sending = true;
  $("send").disabled = true;
  status("正在创建 Codex 任务…");
  try {
    const result = await api("/api/send", { ticket, prompt: currentPrompt, model: $("model").value, effort: $("effort").value, cwd: $("cwd").value });
    ticket = "";
    threadId = result.threadId;
    activeTurnId = result.turnId;
    $("thread-title").textContent = result.title ?? "未设置成功，请用任务 ID 定位";
    $("thread-id").textContent = threadId;
    $("newPromptSection").hidden = true;
    $("result").hidden = true;
    $("handoff").hidden = false;
    $("running").hidden = false;
    status("已发送至 Codex。首轮期间请保留本页，以处理可能出现的审批。不要在网页继续聊天。");
    for (const event of earlyEvents) handleEvent(event);
    earlyEvents = [];
    if (result.completed && activeTurnId) finishTurn({ id: activeTurnId, status: result.status });
  } catch (error) { sending = false; earlyEvents = []; status(error.message); $("send").disabled = false; }
}
$("analyze").onclick = () => analyze(false);
$("smartSend").onclick = () => analyze(true);
$("send").onclick = sendTask;
$("copyId").onclick = async () => {
  try { await navigator.clipboard.writeText(threadId); status("任务 ID 已复制。请在 Codex 任务列表中打开对应任务。"); }
  catch { status(`复制失败，请手动复制任务 ID：${threadId}`); }
};
$("newTask").onclick = () => {
  if (sending) return;
  threadId = null;
  activeTurnId = null;
  $("handoff").hidden = true;
  $("running").hidden = true;
  $("approvals").replaceChildren();
  $("newPromptSection").hidden = false;
  $("prompt").value = "";
  $("send").disabled = false;
  status("可以发起另一条 Codex 任务。上一条请在 Codex 桌面版继续。");
};

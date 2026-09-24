import test from "node:test";
import assert from "node:assert/strict";
import { CodexAppClient } from "../scripts/codex-app-client.mjs";

test("new Codex task gets a visible title before its first turn", async () => {
  const calls = [];
  const client = Object.create(CodexAppClient.prototype);
  client.onEvent = () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    return {};
  };

  const result = await client.start("  帮我写一篇\n开题报告  ", "gpt-5.6-terra", "medium", "/tmp/project");
  assert.deepEqual(calls.map((call) => call.method), ["thread/start", "thread/name/set", "turn/start"]);
  assert.deepEqual(calls[1].params, { threadId: "thread-1", name: "帮我写一篇 开题报告" });
  assert.deepEqual(result, { threadId: "thread-1", turnId: "turn-1", title: "帮我写一篇 开题报告" });
});

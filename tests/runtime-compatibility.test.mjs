import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import packageInfo from "../package.json" with { type: "json" };

test("plugin metadata supports DSH 0.2.2-rc.1 and its Node minimum without version exemption", () => {
  assert.equal(packageInfo.engines.dsh, "0.2.2-rc.1");
  assert.equal(packageInfo.engines.node, ">=24.9.0");
  for (const range of Object.values(packageInfo.peerDependencies)) assert.equal(range, packageInfo.engines.dsh);
});

test("native plugin and Agent load with the actual target DSH packages", { skip: !process.env.DSH_RUNTIME_MODULES }, async () => {
  const require = createRequire(join(process.env.DSH_RUNTIME_MODULES, "@deepseek-ai/dsh/package.json"));
  const runtime = JSON.parse(await readFile(require.resolve("@deepseek-ai/dsh/package.json"), "utf8"));
  assert.equal(runtime.version, packageInfo.engines.dsh);
  const aliases = new Map(["@deepseek-ai/dsh-home-paths", "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-typert-protocol", "@deepseek-ai/dsh-llm"].map((name) => [name, pathToFileURL(require.resolve(name)).href]));
  const hook = registerHooks({ resolve(specifier, context, next) { return next(aliases.get(specifier) || specifier, context); } });
  try {
    const plugin = await import("../dsh/index.mjs"), agent = await import("../dsh/agent.mjs"), bridge = await import("../dsh/bridge.mjs");
    assert.equal(typeof plugin.apply, "function"); assert.equal(typeof agent.apply, "function");
    const hooks = new Map(), definitions = [], masks = [];
    let reads = 0;
    agent.apply({ tools: { view: () => ({ knownNames: new Set(["pwsh", "web_fetch"]) }), restrict: (mask) => masks.push(mask), register: (definition) => definitions.push(definition) }, on: (event, fn) => hooks.set(event, fn), systemPrompt: { section() {} }, mailWorkbench: { service: { assistantSource: async (id) => { assert.equal(id, "mail-session"); reads++; return { message: { text: "Full quoted mail" } }; } } } });
    assert.deepEqual(masks, [{ deny: ["pwsh", "web_fetch"] }]); assert.equal(definitions.length, 9);
    const decision = { kind: "enter", messages: [] }, event = { agent: { session: { header: { id: "mail-session" } } }, step: 1, signal: new AbortController().signal };
    const admitted = await hooks.get("agent/pre-step")(event, async () => decision);
    assert.equal(admitted.messages.length, 1); assert.equal(admitted.messages[0].source.kind, "dsh-mail-context"); assert.match(admitted.messages[0].content[0].text, /Full quoted mail/);
    assert.equal(await hooks.get("agent/pre-step")({ ...event, step: 2 }, async () => decision), decision); assert.equal(reads, 1);
    const { createAiRunner, aiModelSelection } = await import("../dsh/ai.mjs");
    let finish = { kind: "stop" }, output = JSON.stringify({ subject: "合成主题", text: "合成译文" }), prepared;
    const services = { agentDefaultModel: { currentSelection: () => ({ provider: "fixture", model: "default" }) }, sessionProjections: { stateOf: () => ({ pending: { provider: "fixture", model: "pending" } }) }, llm: { prepareCall: async (config, signal) => { prepared = { config, signal }; return { config, async *stream(options) { assert.deepEqual(options.tools, []); assert.ok(!options.messages[0].content[0].text.includes("attachments")); yield { type: "block-end", index: 0, block: { type: "text", text: output } }; yield { type: "finish", reason: finish }; } }; } } };
    const modelCtx = { get: (key) => services[key] }, runner = createAiRunner(modelCtx), signal = new AbortController().signal;
    const result = await runner({ task: "translateMessage", source: { text: "合成正文" }, language: "简体中文", instruction: "", context: {}, signal });
    assert.equal(result.text, "合成译文"); assert.equal(result.model, "fixture/default"); assert.equal(prepared.signal, signal);
    assert.equal(aiModelSelection(modelCtx, { agent: { model: { current: () => ({ provider: "fixture", model: "agent-current" }) }, session: { requestHeader: () => ({ config: { provider: "fixture", model: "previous" } }) } } }).model, "agent-current");
    assert.equal(aiModelSelection(modelCtx, { agent: { session: { requestHeader: () => ({ config: { provider: "fixture", model: "previous" } }) } } }).model, "pending");
    services.sessionProjections = undefined;
    assert.equal(aiModelSelection(modelCtx, { agent: { session: { requestHeader: () => ({ config: { provider: "fixture", model: "previous" } }) } } }).model, "previous");
    finish = { kind: "max-tokens" }; await assert.rejects(runner({ task: "summary", source: {}, context: {}, signal }), { code: "AI_OUTPUT_TRUNCATED" });
    finish = { kind: "stop" }; output = "bad JSON"; await assert.rejects(runner({ task: "summary", source: {}, context: {}, signal }), { code: "AI_INVALID_RESULT" });
    const { Context } = await import(pathToFileURL(require.resolve("@deepseek-ai/cordis")));
    const ctx = new Context(), calls = [];
    ctx.provide("mailWorkbench", { service: { invoke: async (operation, context) => { calls.push({ operation, context }); return { ok: true }; } } });
    try {
      const service = new bridge.MailUiService(ctx);
      await service.invokeGlobal({ action: "state" });
      await service.invoke({ session: { header: { id: "session" } } }, { action: "state" });
      assert.equal(calls[0].context.kind, "human"); assert.equal(calls[1].context.sessionId, "session");
    } finally { await ctx.fiber.dispose(); }
  } finally { hook.deregister(); }
});

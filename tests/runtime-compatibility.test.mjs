import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import packageInfo from "../package.json" with { type: "json" };

test("plugin metadata supports DSH 0.2.2-rc.2 and its Node minimum without version exemption", () => {
  assert.equal(packageInfo.engines.dsh, "0.2.2-rc.2");
  assert.equal(packageInfo.engines.node, ">=24.9.0");
  for (const range of Object.values(packageInfo.peerDependencies)) assert.equal(range, packageInfo.engines.dsh);
});

test("native plugin and Agent load with the actual target DSH packages", { skip: !process.env.DSH_RUNTIME_MODULES }, async () => {
  const require = createRequire(join(process.env.DSH_RUNTIME_MODULES, "@deepseek-ai/dsh/package.json"));
  const runtime = JSON.parse(await readFile(require.resolve("@deepseek-ai/dsh/package.json"), "utf8"));
  assert.equal(runtime.version, packageInfo.engines.dsh);
  const { evaluatePluginCompatibility, getDshRuntimeVersion } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-app-boot")));
  assert.equal(getDshRuntimeVersion(), packageInfo.engines.dsh);
  assert.equal(evaluatePluginCompatibility(packageInfo), undefined);
  const { engines, ...peerManifest } = packageInfo;
  assert.equal(evaluatePluginCompatibility(peerManifest), undefined);
  for (const name of Object.keys(packageInfo.peerDependencies)) {
    const peer = JSON.parse(await readFile(join(process.env.DSH_RUNTIME_MODULES, name, "package.json"), "utf8"));
    assert.equal(peer.version, packageInfo.engines.dsh, name);
  }
  const aliases = new Map(["@deepseek-ai/dsh-home-paths", "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-typert-protocol", "@deepseek-ai/dsh-llm"].map((name) => [name, pathToFileURL(require.resolve(name)).href]));
  const hook = registerHooks({ resolve(specifier, context, next) { return next(aliases.get(specifier) || specifier, context); } });
  try {
    const plugin = await import("../dsh/index.mjs"), agent = await import("../dsh/agent.mjs"), bridge = await import("../dsh/bridge.mjs");
    assert.equal(typeof plugin.apply, "function"); assert.equal(typeof agent.apply, "function");
    const hooks = new Map(), definitions = [], masks = [];
    let reads = 0;
    agent.apply({ tools: { view: () => ({ knownNames: new Set(["pwsh", "web_fetch"]) }), restrict: (mask) => masks.push(mask), register: (definition) => definitions.push(definition) }, on: (event, fn) => hooks.set(event, fn), systemPrompt: { section() {} }, mailWorkbench: { service: { assistantSource: async (id) => { assert.equal(id, "mail-session"); reads++; return { message: { text: "Full quoted mail" } }; } } } });
    assert.deepEqual(masks, [{ deny: ["pwsh", "web_fetch"] }]); assert.equal(definitions.length, 10);
    const decision = { kind: "enter", messages: [] }, event = { agent: { session: { header: { id: "mail-session" } } }, step: 1, signal: new AbortController().signal };
    const admitted = await hooks.get("agent/pre-step")(event, async () => decision);
    assert.equal(admitted.messages.length, 1); assert.equal(admitted.messages[0].source.kind, "dsh-mail-context"); assert.match(admitted.messages[0].content[0].text, /Full quoted mail/);
    assert.equal(await hooks.get("agent/pre-step")({ ...event, step: 2 }, async () => decision), decision); assert.equal(reads, 1);
    const { createAiRunner, aiModelSelection } = await import("../dsh/ai.mjs");
    let statusListener;
    const sourceAgent = { status: "idle", cancel() { this.status = "idle"; }, model: { current: () => ({ provider: "fixture", model: "native-current" }) } };
    const quick = { id: "quick-one" };
    const services = { sessionProjections: { stateOf: () => "dsh-mail" }, mailWorkbench: { service: { quickAi: { read: () => quick }, settings: () => ({ calendarTimeZone: "Asia/Hong_Kong" }) } }, sessionController: { async prompt(request, signal) { assert.equal(request.sessionId, "mail-session"); assert.equal(request.requestId, "quick-one"); assert.match(request.content[0].text, /邮件快捷任务/); assert.doesNotMatch(request.content[0].text, /mail_results|quick-one/); sourceAgent.status = "running"; setTimeout(() => { quick.output = { text: "合成译文" }; sourceAgent.status = "idle"; statusListener({ agent: sourceAgent }); }, 5); } } };
    const modelCtx = { get: (key) => services[key], on: (event, listener) => { assert.equal(event, "agent/status"); statusListener = listener; return () => {}; } }, runner = createAiRunner(modelCtx), signal = new AbortController().signal;
    const result = await runner({ task: "translateMessage", language: "简体中文", instruction: "", style: "professional", context: { agent: sourceAgent, sessionId: "mail-session", quickRunId: "quick-one" }, signal });
    assert.equal(result.text, "合成译文"); assert.equal(result.model, "fixture/native-current");
    services.sessionProjections.stateOf = () => "standard"; await assert.rejects(runner({ task: "summary", context: { agent: sourceAgent, sessionId: "mail-session", quickRunId: "quick-one" }, signal }), { code: "AI_UNAVAILABLE" });
    await assert.rejects(runner({ task: "summary", context: {}, signal }), { code: "AI_UNAVAILABLE" });
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

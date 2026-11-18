import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { boot, getDshRuntimeVersion, evaluatePluginCompatibility, prepareProfileEntries } from "@deepseek-ai/dsh-app-boot";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolsService } from "@deepseek-ai/dsh-tools";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { CredentialProvider } from "@deepseek-ai/dsh-credentials";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentPresetRegistry } from "@deepseek-ai/dsh-agent-preset-registry";
import { inRange } from "./contracts.mjs";

class SyntheticCredentials extends CredentialProvider { async resolve() { throw new Error("No credentials in mail compatibility smoke"); } }
const packageRoot = resolve(process.env.DSH_SMOKE_PACKAGE), out = resolve(process.env.DSH_SMOKE_OUT);
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const runtime = getDshRuntimeVersion(), expected = process.env.DSH_EXPECTED_VERSION;
const source = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const report = { plugin: `${pkg.name}@${pkg.version}`, revision: process.env.DSH_PLUGIN_REVISION ?? "local", runtime, node: process.version, range: pkg.engines.dsh,
  dirty: process.env.DSH_PLUGIN_DIRTY === "true",
  archiveSha256: createHash("sha256").update(readFileSync(process.env.DSH_SMOKE_ARCHIVE)).digest("hex"),
  dailyProfileLoaded: false, realModelCalls: 0, transportCalls: 0 };
let ctx;
try {
  assert.equal(pkg.name, source.name); assert.equal(pkg.version, source.version);
  assert.equal(runtime, expected); assert.ok(inRange(runtime, pkg.engines.dsh));
  assert.equal(evaluatePluginCompatibility(pkg), undefined);
  const require = createRequire(pathToFileURL(join(packageRoot, "package.json")));
  report.peers = Object.fromEntries(Object.entries(pkg.peerDependencies).map(([name, range]) => {
    const version = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")).version;
    assert.equal(version, expected, `${name}: npm must not silently select another runtime`);
    assert.ok(inRange(version, range), `${name}: peer range`);
    return [name, version];
  }));
  const home = mkdtempSync(join(out, "home-")), config = join(home, "cordis.json"), errors = [];
  process.env.DSH_HOME = home; process.env.DSH_AGENTS_HOME = join(home, "agents"); process.env.DSH_PROFILE = "compatibility";
  writeFileSync(config, "[]\n");
  const rows = [{ id: "packed-mail", name: pathToFileURL(join(packageRoot, "dsh/index.mjs")).href }];
  const agentRow = { id: "packed-mail-agent", name: pathToFileURL(join(packageRoot, "dsh/agent.mjs")).href };
  const start = () => boot("dsh-mail-compatibility", config, [{ insert: rows }], async host => {
    host.provide("profileContext", { dir: home, name: "compatibility" });
    for (const row of prepareProfileEntries(host, [...rows, agentRow], pathToFileURL(config).href)) assert.equal(row.disabled, undefined);
    host.logger.exporter({ levels: { default: 2 }, export: m => {
      if (m.type === "warn" || m.type === "error") errors.push(m.args.map(String).join(" "));
    } });
    for (const [plugin, options] of [[SystemPrompt, {}], [ToolsService], [TypertRegistry], [LlmRuntime], [SessionStore], [SyntheticCredentials], [SessionProjectionRegistry], [AgentRegistry], [AgentPresetRegistry, { default: "dsh-mail" }]]) await host.plugin(plugin, options);
  });
  const activatePreset = async () => {
    // Mail Agent belongs in an actual preset scope; loading it globally would mask every agent.
    const unregister = await ctx.agentPresets.register({ id: "dsh-mail", plugins: [agentRow] });
    ctx.effect(() => unregister);
    assert.equal((await ctx.agentPresets.resolve("dsh-mail")).broken, undefined);
    const lease = await ctx.agentPresets.acquireScope("dsh-mail");
    try {
      assert.equal(ctx.tools.definitions(lease.key).filter(t => t.name.startsWith("mail_")).length, 10);
      assert.equal(ctx.tools.definitions().filter(t => t.name.startsWith("mail_")).length, 0, "mail tools must stay scoped");
    } finally { await lease[Symbol.asyncDispose](); }
  };
  const guardService = async () => {
    assert.ok(ctx.mailWorkbench?.service, "the installed package must actually activate through Loader");
    const service = ctx.mailWorkbench.service;
    await service.transport.close();
    service.transport = new Proxy({ close: async () => {} }, { get(target, key) {
      if (key in target) return target[key];
      return () => { report.transportCalls++; throw new Error(`Mail transport disabled: ${String(key)}`); };
    } });
    service.vault = { open() { throw new Error("No real mailbox credentials"); }, seal() { throw new Error("No real mailbox credentials"); } };
    service.ai = () => { report.realModelCalls++; throw new Error("No models in mail compatibility smoke"); };
    assert.ok(service.directory.startsWith(home));
    assert.ok(service.store.list("accounts").every(account => account.local));
    assert.equal(service.store.list("credentials").length, 0);
    return service;
  };
  ctx = await start(); let service = await guardService();
  await activatePreset();
  assert.equal(ctx.typert.local.get("mailUi/invokeGlobal").id, `${pkg.name}#mailUi/invokeGlobal`);
  assert.equal(ctx.typert.local.get("mailUi/invoke").id, `${pkg.name}#mailUi/invoke`);
  const raw = ["From: Synthetic <sender@example.invalid>", "To: Reader <reader@example.invalid>", "Message-ID: <mailcompatfixture@example.invalid>", "Subject: Mailcompatfixture isolated smoke", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "Mailcompatfixture body. Local import, search and read; no mailbox connection."].join("\r\n");
  const imported = await ctx.mailUi.invokeGlobal({ action: "mail.import", base64: Buffer.from(raw).toString("base64") });
  assert.equal(imported.imported, 1);
  const found = await ctx.mailUi.invokeGlobal({ action: "search", q: "Mailcompatfixture" });
  assert.equal(found.total, 1); assert.equal(found.items[0].id, imported.ids[0]);
  const message = await ctx.mailUi.invokeGlobal({ action: "message.read", id: imported.ids[0] });
  assert.match(message.text, /Mailcompatfixture body/);
  const draft = await ctx.mailUi.invokeGlobal({ action: "drafts.save", draft: { accountId: "local", to: "sender@example.invalid", subject: "Synthetic reply", text: "Saved locally; never sent." } });
  assert.equal(draft.status, "draft");
  let browserModule;
  runInNewContext(readFileSync(join(packageRoot, "dist/client.js"), "utf8"), { window: { __ModuleLoader__: { load: value => { browserModule = value; } } } });
  assert.equal(browserModule.id, pkg.name); assert.equal(typeof browserModule.factory, "function");
  await ctx.fiber.dispose(); ctx = await start(); service = await guardService();
  await activatePreset();
  assert.match((await ctx.mailUi.invokeGlobal({ action: "message.read", id: message.id })).text, /Mailcompatfixture body/);
  assert.equal((await ctx.mailUi.invokeGlobal({ action: "drafts.read", id: draft.id })).text, "Saved locally; never sent.");
  assert.equal(service.store.list("previews").length, 0);
  assert.equal(service.store.list("drafts").filter(row => ["queued", "sending", "sent"].includes(row.status)).length, 0);
  assert.equal(existsSync(join(home, "compatibility.json")), false);
  assert.equal(readFileSync(process.env.DSH_KERNEL_NETWORK_LOG, "utf8"), "");
  assert.equal(report.transportCalls, 0); assert.equal(report.realModelCalls, 0); assert.deepEqual(errors, []);
  Object.assign(report, { status: "passed", activation: true, scopedPreset: true, tenTools: true, remote: true, localImportSearchRead: true, localDraft: true, restartPersistence: true, browserEntry: true, externalAttempts: 0, sentMessages: 0 });
} catch (error) { Object.assign(report, { status: "failed", error: error.stack }); throw error; }
finally {
  try { await ctx?.fiber.dispose(); }
  finally { writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
}

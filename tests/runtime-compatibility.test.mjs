import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import packageInfo from "../package.json" with { type: "json" };

test("plugin metadata supports the verified DSH rc.5 runtime without version exemption", () => {
  assert.equal(packageInfo.engines.dsh, "0.2.1-rc.5");
  for (const range of Object.values(packageInfo.peerDependencies)) assert.equal(range, packageInfo.engines.dsh);
});

test("native plugin and Agent load with the actual target DSH packages", { skip: !process.env.DSH_RUNTIME_MODULES }, async () => {
  const require = createRequire(join(process.env.DSH_RUNTIME_MODULES, "@deepseek-ai/dsh/package.json"));
  const runtime = JSON.parse(await readFile(require.resolve("@deepseek-ai/dsh/package.json"), "utf8"));
  assert.equal(runtime.version, packageInfo.engines.dsh);
  const aliases = new Map(["@deepseek-ai/dsh-home-paths", "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-typert-protocol"].map((name) => [name, pathToFileURL(require.resolve(name)).href]));
  const hook = registerHooks({ resolve(specifier, context, next) { return next(aliases.get(specifier) || specifier, context); } });
  try {
    const plugin = await import("../dsh/index.mjs"), agent = await import("../dsh/agent.mjs"), bridge = await import("../dsh/bridge.mjs");
    assert.equal(typeof plugin.apply, "function"); assert.equal(typeof agent.apply, "function");
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

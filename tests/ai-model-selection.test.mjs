import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const llmFixture = pathToFileURL(join(import.meta.dirname, "fixtures", "dsh-llm.mjs")).href;
const hook = registerHooks({ resolve(specifier, context, next) { return next(specifier === "@deepseek-ai/dsh-llm" ? llmFixture : specifier, context); } });
const { aiModelSelection } = await import("../dsh/ai.mjs");
hook.deregister();

test("AI follows the current Agent model without reading deprecated projection state", () => {
  const ctx = { get(name) { if (name === "sessionProjections") return { stateOf() { throw new Error("deprecated registry state must not be read"); } }; } };
  const agent = { model: { current: () => ({ provider: "fixture", model: "agent-current", reasoningEffort: "high" }) }, session: { requestHeader: () => ({ config: { provider: "fixture", model: "previous" } }) } };
  assert.deepEqual(aiModelSelection(ctx, { agent }), { provider: "fixture", model: "agent-current", reasoningEffort: "high" });
});

test("AI falls back to the legacy request header, then deployment default", () => {
  const ctx = { get(name) { if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "fixture", model: "default" }) }; } };
  assert.deepEqual(aiModelSelection(ctx, { agent: { session: { requestHeader: () => ({ config: { provider: "fixture", model: "previous", reasoningEffort: "medium" } }) } } }), { provider: "fixture", model: "previous", reasoningEffort: "medium" });
  assert.deepEqual(aiModelSelection(ctx, {}), { provider: "fixture", model: "default" });
});

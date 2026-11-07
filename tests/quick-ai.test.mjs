import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailService } from "../src/service.mjs";
const human = { kind: "human", sessionId: "one", agent: { status: "idle" } };
async function fixture(t) {
  const service = new MailService({ directory: await mkdtemp(join(tmpdir(), "mail-quick-")), transport: { close: async () => {} } }); t.after(() => service.close());
  service.store.put("accounts", { id: "local", local: true, enabled: true }); service.store.put("folders", { id: "inbox", accountId: "local", path: "INBOX" });
  for (let i = 0; i < 2; i++) service.store.upsertMessage({ id: `m${i}`, accountId: "local", folderId: "inbox", uidValidity: "1", uid: i + 1, subject: `Mail ${i}`, date: new Date().toISOString(), text: `Current ${i}`, html: `<p>Current ${i}</p><blockquote>Oldest ${i}</blockquote>`, from: [], to: [], cc: [], attachments: [], bodyLoaded: true, flags: [] });
  return service;
}
test("quick task snapshots complete context, exposes its progress, and does not follow later UI selections", async (t) => {
  const service = await fixture(t); let release;
  service.ai = async ({ context }) => { await new Promise((r) => release = r); const source = await service.assistantSource(context.sessionId); assert.equal(source.message.id, "m0"); assert.match(source.message.text, /Oldest 0/); service.quickAi.progress(context.sessionId, "search", "completed"); return { text: "done" }; };
  const run = await service.invoke({ action: "assistant.quick.start", task: "summary", messageId: "m0" }, human);
  await service.invoke({ action: "assistant.context", messageId: "m1" }, human);
  while (!release) await new Promise((r) => setImmediate(r)); release(); await service.quickAi.read(run.id, "one").work;
  const result = await service.invoke({ action: "assistant.quick.read", id: run.id }, human);
  assert.equal(result.status, "completed"); assert.equal(result.result.sourceId, "m0"); assert.equal(result.progress[0].action, "search");
  assert.equal((await service.assistantSource("one")).message.id, "m1");
});
test("quick results and cancellation are session-scoped and never grant human-only permissions", async (t) => {
  const service = await fixture(t);
  service.ai = ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  await assert.rejects(service.invoke({ action: "assistant.quick.start", task: "summary", messageId: "m0" }, { kind: "agent", sessionId: "one" }), { code: "USER_ACTION_REQUIRED" });
  const run = await service.invoke({ action: "assistant.quick.start", task: "summary", messageId: "m0" }, human);
  await assert.rejects(service.invoke({ action: "assistant.quick.start", task: "summary", messageId: "m1" }, human), { code: "AI_BUSY" });
  await assert.rejects(service.invoke({ action: "assistant.quick.result", id: run.id, text: "forged" }, { kind: "agent", sessionId: "two" }), { code: "AI_RUN_NOT_FOUND" });
  await assert.rejects(service.invoke({ action: "assistant.quick.result", id: run.id, text: "forged" }, human), { code: "AGENT_ACTION_REQUIRED" });
  for (const action of ["settings.save", "storage.clean", "preview.confirm", "accounts.sync-settings"]) await assert.rejects(service.invoke({ action, id: run.id }, { kind: "agent", sessionId: "one" }), { code: "USER_ACTION_REQUIRED" });
  await service.invoke({ action: "assistant.quick.cancel", id: run.id }, human); await service.quickAi.read(run.id, "one").work;
  await assert.rejects(service.invoke({ action: "assistant.quick.result", id: run.id, text: "late" }, { kind: "agent", sessionId: "one" }), { code: "AI_RUN_FINISHED" });
  assert.equal(service.quickAi.active.size, 0);
});
test("same-session result publishing is single-use; quick candidates never overwrite their source draft", async (t) => {
  const service = await fixture(t), draft = service.saveDraft({ accountId: "local", text: "user original" }); let release;
  service.ai = async ({ context }) => { await new Promise((r) => release = r); return service.quickAi.read(context.quickRunId, context.sessionId).output; };
  const run = await service.invoke({ action: "assistant.quick.start", task: "polish", draftId: draft.id, revision: draft.revision }, human);
  while (!release) await new Promise((r) => setImmediate(r));
  const agent = { kind: "agent", sessionId: "one" };
  await service.invoke({ action: "assistant.quick.result", id: run.id, text: "candidate" }, agent);
  await assert.rejects(service.invoke({ action: "assistant.quick.result", id: run.id, text: "again" }, agent), { code: "AI_RESULT_EXISTS" });
  service.saveDraft({ id: draft.id, text: "new user edit" }); release(); await service.quickAi.read(run.id, "one").work;
  assert.equal(service.store.get("drafts", draft.id).text, "new user edit");
  assert.equal(service.quickAi.view(service.quickAi.read(run.id, "one")).result.sourceRevision, draft.revision);
});

test("legacy generate wraps the native quick Agent and stale draft versions fail before model execution", async (t) => {
  const service = await fixture(t); let executions = 0;
  service.ai = Object.assign(async ({ context }) => { executions++; assert.ok(context.quickRunId); return { text: "native candidate" }; }, { nativeAgent: true });
  const result = await service.invoke({ action: "ai.generate", task: "summary", messageId: "m0" }, human);
  assert.equal(result.sourceId, "m0"); assert.equal(result.text, "native candidate"); assert.equal(service.quickAi.active.size, 0);
  const draft = service.saveDraft({ accountId: "local", text: "first" }); service.saveDraft({ ...draft, text: "new edit" });
  await assert.rejects(service.invoke({ action: "assistant.quick.start", task: "reply", messageId: "m0", draftId: draft.id, revision: draft.revision }, human), { code: "CONFLICT" });
  assert.equal(executions, 1); assert.equal(service.quickAi.active.size, 0);
});

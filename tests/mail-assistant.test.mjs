import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailService } from "../src/service.mjs";
import { normalizeAccount } from "../src/mail.mjs";

async function fixture(t) {
  const service = new MailService({ directory: await mkdtemp(join(tmpdir(), "dsh-assistant-")), transport: { close: async () => {} } });
  t.after(() => service.close());
  service.store.put("accounts", normalizeAccount({ id: "me", email: "me@example.invalid", imapHost: "127.0.0.1", smtpHost: "127.0.0.1" }));
  service.store.put("folders", { id: "inbox", accountId: "me", path: "INBOX" });
  const message = service.store.upsertMessage({ accountId: "me", folderId: "inbox", uid: 1, uidValidity: "1", messageId: "<full@example.invalid>", from: [{ address: "client@example.invalid" }], to: [], subject: "Full history", text: "Latest only", html: "<p>Latest only</p><blockquote>Previous quote<blockquote>Oldest quote</blockquote></blockquote>", attachments: [], bodyLoaded: true });
  return { service, message };
}

test("reply AI includes every HTML quote even when the plain MIME part omits history", async (t) => {
  const { service, message } = await fixture(t);
  service.ai = async ({ source }) => { assert.match(source.text, /Latest only/); assert.match(source.text, /Previous quote/); assert.match(source.text, /Oldest quote/); return { text: "reply" }; };
  await service.invoke({ action: "ai.generate", task: "reply", messageId: message.id }, { kind: "human" });
  service.store.upsertMessage({ ...message, bodyTruncated: true });
  await assert.rejects(service.invoke({ action: "ai.generate", task: "reply", messageId: message.id }, { kind: "human" }), { code: "AI_SOURCE_TRUNCATED" });
});

test("assistant bindings are human-only and current mail is isolated per session", async (t) => {
  const { service, message } = await fixture(t);
  const human = { kind: "human", sessionId: "one" }, agent = { kind: "agent", sessionId: "one" };
  for (const action of ["assistant.context", "assistant.session"]) await assert.rejects(service.invoke({ action, key: "main", messageId: message.id }, agent), { code: "USER_ACTION_REQUIRED" });
  await service.invoke({ action: "assistant.context", messageId: message.id }, human);
  const source = await service.invoke({ action: "assistant.read" }, agent);
  assert.equal(source.message.id, message.id); assert.match(source.message.text, /Oldest quote/);
  assert.deepEqual(await service.assistantSource("two"), { message: null, draft: null });
  const draft = await service.replyDraft({ id: message.id });
  await service.invoke({ action: "assistant.context", draftId: draft.id }, human);
  assert.equal((await service.assistantSource("one")).draft.id, draft.id);
  assert.equal((await service.assistantSource("one")).message.id, message.id);
  const preview = await service.invoke({ action: "send.preview", id: draft.id }, agent);
  assert.equal(preview.workbench.status, "queued");
  assert.equal(service.workbenchView("one").draftId, draft.id);
  await service.invoke({ action: "assistant.context" }, human);
  assert.deepEqual(await service.assistantSource("one"), { bound: true, message: null, draft: null });
  await service.invoke({ action: "assistant.session", key: "main", sessionId: "one" }, human);
  assert.equal((await service.invoke({ action: "assistant.session", key: "main" }, human)).sessionId, "one");
  await assert.rejects(service.invoke({ action: "preview.confirm", id: "anything" }, agent), { code: "USER_ACTION_REQUIRED" });
});

test("HTML conversion cannot drop information unique to the plain MIME part", async (t) => {
  const { service } = await fixture(t);
  const text = await service.completeMailText({ text: "Budget > 100\nPlain-only history", html: "<p>Budget 100</p><blockquote>HTML-only history</blockquote>" });
  assert.match(text, /Budget > 100/); assert.match(text, /Plain-only history/); assert.match(text, /HTML-only history/);
});

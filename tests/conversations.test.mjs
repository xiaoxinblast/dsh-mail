import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailService } from "../src/service.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-mail-conversations-"));
  const service = new MailService({ directory, transport: { close: async () => {} } });
  t.after(() => service.stopped ? undefined : service.close());
  for (const accountId of ["me", "other"]) {
    service.store.put("accounts", { id: accountId, local: true, enabled: true, email: `${accountId}@example.invalid` });
    for (const folder of ["inbox", "sent", "project"]) service.store.put("folders", { id: `${accountId}-${folder}`, accountId, path: folder === "inbox" ? "INBOX" : folder, role: folder === "sent" ? "\\Sent" : undefined });
  }
  let uid = 0;
  const add = (id, value = {}) => service.store.upsertMessage({ id, accountId: "me", folderId: "me-inbox", uid: ++uid, uidValidity: "1", messageId: `<${id}@example.invalid>`, subject: "交付计划", date: new Date(Date.UTC(2026, 9, 30, 0, uid)).toISOString(), text: "合成正文", bodyLoaded: true, from: [{ address: "client@example.invalid" }], to: [], cc: [], flags: [], attachments: [], ...value });
  const thread = (id, args = {}) => service.invoke({ action: "thread.read", id, ...args }, { kind: "human" });
  return { service, directory, add, thread };
}

test("folder copies count as one logical mail and retain the currently selected instance", async (t) => {
  const { add, thread } = await fixture(t), root = add("root");
  const copy = add("copy", { messageId: root.messageId, folderId: "me-project", date: root.date });
  for (const id of [root.id, copy.id]) { const result = await thread(id); assert.equal(result.total, 1); assert.deepEqual(result.items.map((m) => m.id), [id]); assert.equal(result.current.id, id); assert.equal(result.items[0].locations.length, 2); }
});

test("reply chains connect through intermediate messages and include sent replies regardless of insertion order", async (t) => {
  const { add, thread } = await fixture(t);
  add("last", { subject: "Re: 回复：交付计划", inReplyTo: "<reply@example.invalid>", references: ["<reply@example.invalid>"] });
  add("reply", { subject: "Re: 交付计划", folderId: "me-sent", references: ["<root@example.invalid>"] });
  add("root");
  const result = await thread("last");
  assert.equal(result.total, 3); assert.deepEqual(result.items.map((m) => m.id), ["root", "reply", "last"]);
  assert.equal(result.items.find((m) => m.id === "reply").folderId, "me-sent");
});

test("changed subjects create a new conversation, while identical subjects and stale thread ids alone do not merge", async (t) => {
  const { add, thread } = await fixture(t), root = add("root");
  add("new-topic", { subject: "另一项目", references: [root.messageId] });
  add("new-topic-reply", { subject: "Re: 另一项目", references: [root.messageId, "<new-topic@example.invalid>"] });
  add("unrelated", { threadId: root.threadId });
  add("no-id-a", { messageId: null, threadId: root.threadId }); add("no-id-b", { messageId: null, threadId: root.threadId });
  assert.equal((await thread("root")).total, 1);
  assert.deepEqual(new Set((await thread("new-topic")).items.map((m) => m.id)), new Set(["new-topic", "new-topic-reply"]));
  for (const id of ["unrelated", "no-id-a", "no-id-b"]) assert.equal((await thread(id)).total, 1);
});

test("missing roots can connect replies but never cross accounts or include unavailable folder copies", async (t) => {
  const { service, add, thread } = await fixture(t);
  add("a", { references: ["<missing@example.invalid>"] }); add("b", { inReplyTo: "<missing@example.invalid>" });
  add("other-account", { accountId: "other", folderId: "other-inbox", references: ["<missing@example.invalid>"] });
  add("gone", { folderId: "me-project", references: ["<missing@example.invalid>"] });
  service.store.put("folders", { ...service.folder("me-project"), missing: true });
  assert.deepEqual(new Set((await thread("a")).items.map((m) => m.id)), new Set(["a", "b"]));
  assert.equal((await thread("other-account")).total, 1);
});

test("conversations deduplicate before pagination and return the current mail even outside the page", async (t) => {
  const { service, add, thread } = await fixture(t), root = add("root");
  for (let i = 0; i < 55; i++) { const reply = add(`reply-${i}`, { references: [root.messageId] }); add(`copy-${i}`, { messageId: reply.messageId, folderId: "me-project", date: reply.date, references: [root.messageId] }); }
  const first = await thread("root", { limit: 10 }), second = await thread("root", { limit: 10, offset: 10 });
  assert.equal(first.total, 56); assert.equal(first.items.length, 10); assert.equal(first.nextOffset, 10); assert.equal(first.current.id, "root");
  assert.equal(new Set([...first.items, ...second.items].map((m) => m.messageId)).size, 20);
  await service.invoke({ action: "thread.read", id: "root" }, { kind: "agent", sessionId: "session" });
  const view = service.workbenchView("session"), search = await service.invoke({ action: "search", ...view.query, limit: 10 });
  assert.equal(search.total, 56); assert.equal(search.items.length, 10); assert.equal(search.items[0].threadId, first.threadId);
});

test("conversation metadata cache survives flag changes and refreshes for late headers, deletion and restart", async (t) => {
  const { service, directory, add, thread } = await fixture(t), root = add("root"), reply = add("reply", { subject: "Re: 交付计划" });
  assert.equal((await thread("root")).total, 1);
  const cache = service.store.conversations(); service.store.upsertMessage({ ...root, flags: ["\\Seen"] }); assert.equal(service.store.conversations(), cache);
  service.store.upsertMessage({ ...reply, references: [root.messageId] }); assert.equal((await thread("root")).total, 2);
  service.store.deleteMessage(reply.id); assert.equal((await thread("root")).total, 1);
  add("reply-again", { inReplyTo: root.messageId }); await service.close();
  const reopened = new MailService({ directory }); t.after(() => reopened.close());
  assert.equal((await reopened.invoke({ action: "thread.read", id: "root" })).total, 2);
});

test("forwarded drafts start a new chain; replies retain reference headers", async (t) => {
  const { service, add } = await fixture(t), root = add("root");
  const forwarded = await service.invoke({ action: "drafts.reply", id: root.id, mode: "forward" });
  assert.deepEqual(forwarded.references, []); assert.equal(forwarded.inReplyTo, undefined);
  const replied = await service.invoke({ action: "drafts.reply", id: root.id });
  assert.deepEqual(replied.references, [root.messageId]); assert.equal(replied.inReplyTo, root.messageId);
});

test("rolled-back reply headers never leave unrelated conversations joined", async (t) => {
  const { service, add, thread } = await fixture(t), a = add("a"), b = add("b");
  assert.throws(() => service.store.transaction(() => { add("bridge", { references: [a.messageId, b.messageId] }); assert.equal(service.store.conversationId(a), service.store.conversationId(b)); throw new Error("rollback"); }), /rollback/);
  assert.equal((await thread(a.id)).total, 1); assert.equal((await thread(b.id)).total, 1);
});

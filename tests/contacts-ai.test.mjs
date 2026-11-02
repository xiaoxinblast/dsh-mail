import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailService } from "../src/service.mjs";

const human = { kind: "human" };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-mail-contact-ai-"));
  const calls = [], service = new MailService({ directory, transport: { close: async () => {} }, ai: async (request) => { calls.push(request); return { text: "生成的正文", subject: "生成的主题", model: "fixture/model" }; }, ...options });
  t.after(() => service.stopped ? undefined : service.close());
  for (const key of ["me", "other"]) service.store.put("accounts", { id: key, email: `${key}@example.invalid`, enabled: true });
  for (const [key, role] of [["sent", "\\Sent"], ["inbox", "\\Inbox"], ["project", ""]]) service.store.put("folders", { id: key, accountId: "me", path: key, role });
  let uid = 0;
  const add = (fields = {}) => service.store.upsertMessage({ accountId: "me", folderId: "sent", uidValidity: "1", uid: ++uid, from: [{ address: "me@example.invalid" }], to: [{ name: "客户", address: "client@example.invalid" }], cc: [], bcc: [], bodyLoaded: true, subject: "合成主题", text: "合成正文", attachments: [], flags: [], ...fields });
  return { service, calls, add, directory };
}

test("outgoing contact backfill collects all recipient roles, preserves manual data and tombstones, and resumes after restart", async (t) => {
  const { service, add, directory } = await fixture(t);
  const existing = service.saveResource("contacts", { name: "手工姓名", email: "CLIENT@example.invalid", group: "客户" });
  service.store.put("contacts", { email: "deleted@example.invalid", name: "已删除", deleted: true });
  add({ cc: [{ address: "cc@example.invalid" }, { address: "other@example.invalid" }], bcc: [{ address: "bcc@example.invalid" }, { address: "deleted@example.invalid" }, { address: "bad" }] });
  add({ from: [{ address: "stranger@example.invalid" }], to: [{ address: "wrong@example.invalid" }] });
  add({ folderId: "inbox", to: [{ address: "incoming-only@example.invalid" }] });
  const sent = service.store.put("drafts", { accountId: "me", status: "sent", to: "accepted@example.invalid,rejected@example.invalid", accepted: ["accepted@example.invalid"] });
  await service.backfillContacts();
  assert.deepEqual(new Set(service.state().contacts.map((c) => c.email)), new Set(["client@example.invalid", "cc@example.invalid", "bcc@example.invalid", "accepted@example.invalid"]));
  assert.equal(service.store.get("contacts", existing.id).name, "手工姓名");
  assert.equal(service.store.get("contacts", existing.id).group, "客户");
  const revisions = service.store.list("contacts").map((c) => [c.id, c.revision]);
  await service.backfillContacts(); assert.deepEqual(service.store.list("contacts").map((c) => [c.id, c.revision]), revisions);
  service.collectOutgoingContacts({ ...sent, status: "failed" });
  service.collectOutgoingContacts({ ...sent, status: "uncertain", accepted: ["uncertain@example.invalid"], to: "uncertain@example.invalid" });
  assert.ok(!service.state().contacts.some((c) => c.email === "uncertain@example.invalid"));
  await service.close();
  const reopened = new MailService({ directory, transport: { close: async () => {} } }); t.after(() => reopened.close());
  await reopened.backfillContacts(); assert.deepEqual(reopened.store.list("contacts").map((c) => [c.id, c.revision]), revisions);
  const restored = reopened.saveResource("contacts", { email: "deleted@example.invalid", name: "主动恢复" }); assert.equal(restored.deleted, false);
});

test("recipient collection handles sent folder mappings, accepted SMTP recipients and contact persistence failures independently", async (t) => {
  const { service, add } = await fixture(t);
  service.store.put("accounts", { ...service.account("me"), folders: { sent: "project" } });
  const ignored = add(); service.collectOutgoingContacts(ignored);
  const mapped = add({ folderId: "project" }); service.collectOutgoingContacts(mapped);
  assert.equal(service.state().contacts.length, 1);
  service.collectOutgoingContacts({ status: "sent", accountId: "me", to: "client@example.invalid,rejected@example.invalid", cc: "cc@example.invalid", bcc: "bcc@example.invalid", accepted: ["client@example.invalid", "bcc@example.invalid"] });
  assert.deepEqual(new Set(service.state().contacts.map((c) => c.email)), new Set(["client@example.invalid", "bcc@example.invalid"]));
  const put = service.store.put.bind(service.store); service.store.put = (kind, ...args) => { if (kind === "contacts") throw new Error("contact write failure"); return put(kind, ...args); };
  assert.doesNotThrow(() => service.collectOutgoingContacts({ status: "sent", to: "new@example.invalid", accepted: ["new@example.invalid"] }));
  assert.ok(service.store.logs().some((l) => l.kind === "contact-collection-error"));
});

test("participant search matches complete addresses in both directions and all roles with valid folder scope", async (t) => {
  const { service, add } = await fixture(t);
  const a = add(), b = add({ folderId: "inbox", from: [{ address: "client@example.invalid" }], to: [] }), c = add({ to: [], cc: [{ address: "CLIENT@example.invalid" }] }), d = add({ to: [], bcc: [{ address: "client@example.invalid" }] });
  add({ to: [{ address: "other-client@example.invalid" }] }); add({ to: [{ address: "client@example.invalid.evil" }] });
  service.store.put("folders", { id: "gone", accountId: "me", path: "gone", missing: true }); add({ folderId: "gone" });
  const result = await service.invoke({ action: "search", participant: "CLIENT@example.invalid" }, human);
  assert.deepEqual(new Set(result.items.map((m) => m.id)), new Set([a.id, b.id, c.id, d.id]));
  assert.equal((await service.invoke({ action: "search", participant: "client@example.invalid", folderId: "inbox" }, human)).total, 1);
  assert.equal((await service.invoke({ action: "search", participant: "client@example.invalid", limit: 1, offset: 1 }, human)).items.length, 1);
  await assert.rejects(service.invoke({ action: "search", participant: "a@example.invalid,b@example.invalid" }, human), { code: "INVALID_PARTICIPANT" });
});

test("AI is human-only, has bounded current-source input and defaults for all six tasks, with no automatic draft mutation", async (t) => {
  const { service, add, calls } = await fixture(t), message = add(), draft = service.saveDraft({ accountId: "me", subject: "草稿", text: "草稿正文", to: "client@example.invalid" });
  await assert.rejects(service.invoke({ action: "ai.generate", task: "summary", messageId: message.id }), { code: "USER_ACTION_REQUIRED" });
  for (const task of ["compose", "polish", "translateDraft", "translateMessage", "summary", "reply"]) {
    const args = ["compose", "polish", "translateDraft"].includes(task) ? { draftId: draft.id, revision: draft.revision } : { messageId: message.id };
    const result = await service.invoke({ action: "ai.generate", task, ...args, instruction: "合成要求" }, human);
    assert.equal(result.text, "生成的正文"); assert.equal(result.sourceId, args.draftId || args.messageId);
    assert.equal(calls.at(-1).source.text, args.draftId ? "草稿正文" : "合成正文");
    assert.equal(calls.at(-1).language, task === "polish" ? "preserve" : task === "reply" ? "original" : "简体中文");
    assert.equal(calls.at(-1).source.attachments, undefined); assert.equal(calls.at(-1).source.rawHeaders, undefined);
  }
  assert.equal(service.store.get("drafts", draft.id).revision, draft.revision); assert.equal(service.store.list("drafts").length, 1);
  service.saveDraft({ id: draft.id, revision: draft.revision, text: "更新" });
  await assert.rejects(service.invoke({ action: "ai.generate", task: "polish", draftId: draft.id, revision: draft.revision }, human), { code: "CONFLICT" });
  const truncated = add({ bodyTruncated: true }); await assert.rejects(service.invoke({ action: "ai.generate", task: "translateMessage", messageId: truncated.id }, human), { code: "AI_SOURCE_TRUNCATED" });
  const long = add({ text: "长".repeat(100000) }); await assert.rejects(service.invoke({ action: "ai.generate", task: "summary", messageId: long.id }, human), { code: "AI_INPUT_TOO_LONG" });
  const abort = new AbortController(); abort.abort(); await assert.rejects(service.invoke({ action: "ai.generate", task: "summary", messageId: message.id }, { ...human, signal: abort.signal }), { name: "AbortError" });
});

test("AI cancellation and missing models leave mail usable, contact backup preserves deletion and backfill state", async (t) => {
  const { service, add } = await fixture(t, { ai: null }), m = add();
  await assert.rejects(service.invoke({ action: "ai.generate", task: "summary", messageId: m.id }, human), { code: "AI_UNAVAILABLE" });
  assert.equal((await service.invoke({ action: "message.read", id: m.id }, human)).id, m.id);
  await service.backfillContacts(); const c = service.state().contacts[0]; await service.invoke({ action: "resources.delete", kind: "contacts", id: c.id }, human);
  const backup = await service.backup(), restored = new MailService({ directory: await mkdtemp(join(tmpdir(), "dsh-mail-contact-restore-")), transport: { close: async () => {} } }); t.after(() => restored.close());
  await restored.restore({ base64: backup.base64 }); await restored.backfillContacts(); assert.equal(restored.state().contacts.length, 0);
});

test("AI cancellation during generation reaches the runner and never changes the draft", async (t) => {
  let started, cancelled = false;
  const ready = new Promise((resolve) => started = resolve);
  const { service } = await fixture(t, { ai: ({ signal }) => new Promise((resolve, reject) => { started(); signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true }); }) });
  const draft = service.saveDraft({ accountId: "me", text: "用户正文", subject: "用户主题" });
  const controller = new AbortController(), pending = service.invoke({ action: "ai.generate", task: "polish", draftId: draft.id, revision: draft.revision }, { ...human, signal: controller.signal });
  await ready; controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true); assert.equal(service.store.get("drafts", draft.id).revision, draft.revision);
  for (const args of [{ task: "bad" }, { task: "compose", draftId: draft.id, language: "" }, { task: "compose", draftId: draft.id, instruction: "x".repeat(8001) }]) await assert.rejects(service.invoke({ action: "ai.generate", ...args }, human));
});

test("SMTP partial acceptance collects only successful recipients; failed collection cannot change delivery status", async (t) => {
  let mode = "partial";
  const { service, add } = await fixture(t, { transport: { close: async () => {}, send: async () => { if (mode === "uncertain") throw Object.assign(new Error("connection closed"), { code: "ECONNRESET" }); if (mode === "failed") throw Object.assign(new Error("535 denied"), { responseCode: 535 }); return { accepted: ["good@example.invalid"], rejected: ["bad@example.invalid"] }; } } });
  const send = async () => { const draft = service.saveDraft({ accountId: "me", to: "good@example.invalid,bad@example.invalid", subject: "合成发送", text: "正文" }), preview = service.preview("send", { draftId: draft.id }, human); const queued = await service.confirm(preview.id, human); await service.deliver(queued); return service.store.get("drafts", draft.id); };
  const sent = await send(); assert.equal(sent.status, "sent"); assert.deepEqual(service.state().contacts.map((c) => c.email), ["good@example.invalid"]);
  const copy = add({ messageId: sent.messageId, to: [{ address: "good@example.invalid" }, { address: "bad@example.invalid" }] }); service.collectOutgoingContacts(copy); await service.backfillContacts(); assert.deepEqual(service.state().contacts.map((c) => c.email), ["good@example.invalid"]);
  service.store.remove("contacts", service.state().contacts[0].id);
  mode = "uncertain"; assert.equal((await send()).status, "uncertain"); assert.equal(service.state().contacts.length, 0);
  mode = "failed"; assert.equal((await send()).status, "failed"); assert.equal(service.state().contacts.length, 0);
  mode = "partial"; const put = service.store.put.bind(service.store); service.store.put = (kind, ...args) => { if (kind === "contacts") throw new Error("contact disk failure"); return put(kind, ...args); };
  assert.equal((await send()).status, "sent");
});

test("contact backfill resumes at its saved batch cursor after an interrupted startup", async (t) => {
  const { service, add, directory } = await fixture(t);
  for (let i = 0; i < 201; i++) add({ to: [{ address: `person-${i}@example.invalid` }] });
  const work = service.backfillContacts(); service.stopped = true; await work;
  assert.equal(service.state().contacts.length, 200); assert.equal(service.store.get("settings", "outgoing-contacts-v1").complete, undefined);
  service.stopped = false; await service.close();
  const reopened = new MailService({ directory, transport: { close: async () => {} } }); t.after(() => reopened.close());
  await reopened.backfillContacts(); assert.equal(reopened.state().contacts.length, 201); assert.equal(reopened.store.get("settings", "outgoing-contacts-v1").complete, true);
});

test("subsequent sent-folder syncs collect newly discovered outgoing recipients without collecting incoming senders", async (t) => {
  let cycle = 0;
  const { service } = await fixture(t, { transport: { close: async () => {}, folders: async () => [{ path: "sent", role: "\\Sent", selectable: true }, { path: "INBOX", role: "\\Inbox", selectable: true }], scan: async (account, folder, known, batch) => { const outgoing = folder.role === "\\Sent"; await batch([{ accountId: account.id, folderId: folder.id, uid: cycle + 1, uidValidity: "1", from: [{ address: outgoing ? account.email : "incoming-only@example.invalid" }], to: [{ address: outgoing ? `new-${cycle}@example.invalid` : account.email }], text: "正文", bodyLoaded: true, attachments: [], flags: [] }]); return { uids: [cycle + 1], uidValidity: "1" }; } } });
  await service.syncAccount(service.account("me")); cycle++; await service.syncAccount(service.account("me"));
  assert.deepEqual(new Set(service.state().contacts.map((c) => c.email)), new Set(["new-0@example.invalid", "new-1@example.invalid"]));
});

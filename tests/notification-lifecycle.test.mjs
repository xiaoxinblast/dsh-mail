import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailService } from "../src/service.mjs";
const human = { kind: "human" };
async function fixture(t, notify = async () => {}) {
  const removed = [], directory = await mkdtemp(join(tmpdir(), "mail-reminder-"));
  const service = new MailService({ directory, notify, dismissNotify: async (id) => removed.push(id), transport: { close: async () => {} } }); t.after(() => service.close());
  for (const id of ["a", "b"]) { service.store.put("accounts", { id, local: true, enabled: true }); service.store.put("folders", { id: id + "-inbox", accountId: id, path: "INBOX", role: "\\Inbox" }); }
  for (let i = 0; i < 3; i++) { const accountId = i === 2 ? "b" : "a"; service.store.upsertMessage({ id: `m${i}`, accountId, folderId: accountId + "-inbox", uidValidity: "1", uid: i + 1, subject: "Synthetic", text: "body", flags: [], attachments: [], bodyLoaded: true }); }
  return { service, removed };
}
test("opening mail acknowledges just its reminder even when automatic read flags are disabled", async (t) => {
  const { service, removed } = await fixture(t);
  await service.invoke({ action: "settings.save", value: { markReadOnOpen: false } }, human);
  const batch = service.addNotification("new-mail", "old title", { accountId: "a", messageIds: ["m0", "m1"] }), other = service.addNotification("new-mail", "other", { accountId: "b", messageIds: ["m2"] });
  await service.invoke({ action: "message.read", id: "m0", acknowledge: true }, { kind: "agent" });
  assert.equal(service.store.get("notifications", batch.id).dismissed, undefined);
  await assert.rejects(service.invoke({ action: "message.read", id: "missing", acknowledge: true }, human));
  assert.equal(service.store.get("notifications", batch.id).dismissed, undefined);
  const opened = await service.invoke({ action: "message.read", id: "m0", acknowledge: true }, human);
  assert.equal(opened.notificationsChanged, true); assert.equal(service.message("m0").seen, false);
  const remaining = service.store.get("notifications", batch.id); assert.deepEqual(remaining.data.messageIds, ["m1"]); assert.equal(remaining.title, "未读邮件 · 1 封");
  assert.equal(service.store.get("notifications", other.id).dismissed, undefined);
  const delta = await service.invoke({ action: "ui.state", resources: ["notifications"] }, human); assert.equal(delta.changes.notifications.find((n) => n.id === batch.id).data.messageIds, undefined);
  await service.invoke({ action: "message.read", id: "m1", acknowledge: true }, human); await Promise.all(service.notificationWork);
  assert.equal(service.store.get("notifications", batch.id).dismissed, true); assert.deepEqual(removed, [batch.id]);
});
test("marking a mail read clears its reminder; opening before a sync finishes cannot create a stale alert", async (t) => {
  const { service } = await fixture(t);
  const notice = service.addNotification("new-mail", "new", { accountId: "a", messageIds: ["m0"] });
  await service.messageAction("m0", { operation: "read", value: true }); assert.equal(service.store.get("notifications", notice.id).dismissed, true);
  await service.invoke({ action: "message.read", id: "m1", acknowledge: true }, human);
  assert.equal(service.addNotification("new-mail", "late", { accountId: "a", messageIds: ["m1"] }), null);
});
test("native removal waits for an in-flight toast so a late delivery cannot resurrect the read notification", async (t) => {
  let release, started = false;
  const { service, removed } = await fixture(t, () => { started = true; return new Promise((r) => release = r); });
  const notice = service.addNotification("new-mail", "new", { accountId: "a", messageIds: ["m0"] });
  await new Promise((r) => setImmediate(r)); assert.ok(started);
  await service.invoke({ action: "message.read", id: "m0", acknowledge: true }, human); assert.deepEqual(removed, []);
  release(); await Promise.all(service.notificationWork); assert.deepEqual(removed, [notice.id]);
});
test("app-only reminders clear without launching native notification work", async (t) => {
  const { service, removed } = await fixture(t);
  await service.invoke({ action: "settings.save", value: { desktopNotifications: false } }, human);
  const notice = service.addNotification("new-mail", "new", { accountId: "a", messageIds: ["m0"] });
  await service.invoke({ action: "message.read", id: "m0", acknowledge: true }, human);
  assert.equal(service.store.get("notifications", notice.id).dismissed, true); assert.deepEqual(removed, []); assert.equal(service.notificationWork.size, 0);
});

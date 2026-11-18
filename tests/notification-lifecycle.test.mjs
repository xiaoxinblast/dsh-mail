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

test("notification deltas shrink or dismiss stale batches after mail moves, deletions and read flag changes", async (t) => {
  const { service, removed } = await fixture(t);
  const poll = (previous = {}) => service.invoke({ action: "ui.state", resources: ["notifications"], epoch: previous.epoch, versions: previous.versions }, human);
  const batch = service.addNotification("new-mail", "batch", { accountId: "a", messageIds: ["m1", "m0"] });
  const other = service.addNotification("new-mail", "other", { accountId: "b", messageIds: ["m2"] });
  const task = service.addNotification("task", "Task", { taskId: "task" }), event = service.addNotification("event", "Event", { eventId: "event" });
  const initial = await poll();
  assert.equal(initial.changes.notifications.find((notice) => notice.id === batch.id).data.messageId, "m1");
  service.store.put("folders", { id: "archive", accountId: "a", path: "Archive", role: "\\Archive" });
  service.store.upsertMessage({ ...service.message("m1"), folderId: "archive" });
  const partial = await poll(initial);
  assert.deepEqual(partial.changes.notifications?.find((notice) => notice.id === batch.id)?.data, { accountId: "a", messageId: "m0", count: 1 });
  assert.deepEqual((await poll(partial)).changes, {});
  await service.messageAction("m0", { operation: "purge" });
  assert.deepEqual(new Set(service.state().notifications.map((notice) => notice.id)), new Set([other.id, task.id, event.id]));
  service.store.upsertMessage({ ...service.message("m2"), flags: ["\\Seen"] });
  const final = await poll(partial);
  assert.deepEqual(new Set(final.changes.notifications.map((notice) => notice.id)), new Set([task.id, event.id]));
  await Promise.all(service.notificationWork);
  assert.deepEqual(removed.sort(), [batch.id, other.id].sort());
});

test("first refresh repairs stored reminders without borrowing newer mail or mail from another account", async (t) => {
  const { service } = await fixture(t);
  for (const data of [{ accountId: "a", messageIds: ["gone", "m2"] }, { accountId: "a" }, { accountId: "a" }]) {
    service.store.put("notifications", { kind: "new-mail", data, createdAt: "2000-01-01T00:00:00Z", nativeNotification: false });
  }
  const delta = await service.invoke({ action: "ui.state", resources: ["notifications"] }, human);
  assert.deepEqual(delta.changes.notifications, []);
  assert.equal(delta.summary.unread, 3);
  assert.ok(service.store.list("notifications").every((notice) => notice.dismissed));
});

test("only unread mail in an available inbox can enter a batch, and folder-only changes invalidate it", async (t) => {
  const { service } = await fixture(t);
  const folder = service.folder("a-inbox");
  service.store.put("folders", { ...folder, role: null, path: "inbox" });
  service.store.upsertMessage({ ...service.message("m1"), flags: ["\\Seen"] });
  const batch = service.addNotification("new-mail", "late", { accountId: "a", messageIds: ["m1", "gone", "m0", "m2"] });
  assert.deepEqual(batch.data.messageIds, ["m0"]);
  const legacy = service.store.put("notifications", { kind: "new-mail", data: { accountId: "a" }, createdAt: service.message("m0").date, nativeNotification: false });
  const first = await service.invoke({ action: "ui.state", resources: ["notifications"] }, human);
  assert.equal(first.changes.notifications.length, 2);
  assert.deepEqual(service.store.get("notifications", legacy.id).data, { accountId: "a" });
  service.store.put("folders", { ...folder, missing: true });
  const next = await service.invoke({ action: "ui.state", resources: ["notifications"], epoch: first.epoch, versions: first.versions }, human);
  assert.deepEqual(next.changes.notifications, []);
  assert.equal(service.addNotification("new-mail", "late", { accountId: "a", messageIds: ["m0"] }), null);
});

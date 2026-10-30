import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailService } from "../src/service.mjs";
import { mailPaneSizes } from "../ui/mail-layout.mjs";
import { toastXml } from "../src/notifications.mjs";

const human = { kind: "human" };
async function fixture(t, notify = async () => ({ status: "submitted" })) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-mail-notifications-"));
  const service = new MailService({ directory, notify, transport: { close: async () => {} } });
  t.after(() => service.stopped ? undefined : service.close());
  return { service, directory };
}

test("pane widths stay within the available space without overwriting saved preferences", () => {
  const settings = { mailFolderWidth: 480, mailListWidth: 720 };
  for (const [rootWidth, width] of [[1440, 1376], [1100, 1036], [1024, 960], [760, 696]]) {
    const sizes = mailPaneSizes(width, rootWidth, settings);
    assert.ok(sizes.list >= 260);
    assert.ok(sizes.reader >= 300);
    assert.ok(sizes.folder + sizes.list + sizes.reader + sizes.handles <= width);
    assert.equal(sizes.folder > 0, rootWidth >= 1100);
  }
  assert.equal(mailPaneSizes(338, 390, settings).handles, 0);
  assert.deepEqual(settings, { mailFolderWidth: 480, mailListWidth: 720 });
});

test("widths and notification preference validate, merge and persist after restart", async (t) => {
  const { service, directory } = await fixture(t);
  assert.equal(service.settings().desktopNotifications, true);
  for (const value of [{ mailFolderWidth: 179 }, { mailFolderWidth: 481 }, { mailListWidth: 259 }, { mailListWidth: 721 }, { mailListWidth: 300.5 }, { mailFolderWidth: "240" }, { desktopNotifications: "true" }]) {
    await assert.rejects(service.invoke({ action: "settings.save", value }, human));
  }
  await service.invoke({ action: "settings.save", value: { mailFolderWidth: 290, mailListWidth: 420, desktopNotifications: false } }, human);
  await service.invoke({ action: "settings.save", value: { firstDay: 0 } }, human);
  await service.close();
  const reopened = new MailService({ directory }); t.after(() => reopened.close());
  assert.equal(reopened.settings().mailFolderWidth, 290);
  assert.equal(reopened.settings().mailListWidth, 420);
  assert.equal(reopened.settings().desktopNotifications, false);
});

test("new reminders reach the native sender once; disabled reminders stay in the app", async (t) => {
  const sent = [], { service, directory } = await fixture(t, async (n) => sent.push(n));
  service.store.put("tasks", { id: "task", title: "核对报价", due: new Date(Date.now() - 1000).toISOString() });
  service.reminders(); service.reminders();
  await service.close();
  assert.equal(sent.length, 1); assert.equal(sent[0].kind, "task");
  const reopened = new MailService({ directory, notify: async (n) => sent.push(n) }); t.after(() => reopened.stopped ? undefined : reopened.close());
  reopened.reminders();
  await reopened.invoke({ action: "settings.save", value: { desktopNotifications: false } }, human);
  reopened.addNotification("new-mail", "新邮件", { accountId: "demo" });
  await reopened.close();
  assert.equal(sent.length, 1);
});

test("native notification failures preserve the in-app reminder and do not break mail operations", async (t) => {
  const { service } = await fixture(t, async () => { throw new Error("Windows notifications disabled"); });
  service.addNotification("new-mail", "收到新邮件", {});
  await Promise.all([...service.notificationWork]);
  assert.equal(service.state().notifications.length, 1);
  assert.ok(service.store.logs().some((l) => l.kind === "notification-error"));
  assert.equal(service.state().version.length > 0, true);
});

test("test notifications are human-only and can check delivery while the preference is disabled", async (t) => {
  const sent = [], { service } = await fixture(t, async (n) => { sent.push(n); return { status: "submitted" }; });
  await assert.rejects(service.invoke({ action: "notifications.test" }, { kind: "agent" }), { code: "USER_ACTION_REQUIRED" });
  await service.invoke({ action: "settings.save", value: { desktopNotifications: false } }, human);
  assert.equal((await service.invoke({ action: "notifications.test" }, human)).status, "submitted");
  assert.equal(sent.length, 1); assert.equal(service.state().notifications.length, 0);
});

test("Windows toast escapes untrusted text and uses the default system sound", () => {
  const xml = toastXml({ title: '<客户 & "项目">\u0000', kind: "new-mail" });
  assert.ok(xml.includes("&lt;客户 &amp; &quot;项目&quot;&gt;"));
  assert.ok(!xml.includes("\u0000"));
  assert.ok(xml.includes('src="ms-winsoundevent:Notification.Default"'));
  assert.ok(!xml.includes('silent="true"'));
});

test("sync notifies only new inbox mail, skipping first sync, sent copies and UIDVALIDITY rebuilds", async (t) => {
  const sent = [], { service } = await fixture(t, async (n) => sent.push(n));
  let validity = "1", count = 1;
  service.store.put("accounts", { id: "demo", name: "测试邮箱", email: "demo@example.invalid", enabled: true });
  service.transport.folders = async () => [{ id: "inbox", path: "INBOX", selectable: true }, { id: "sent", path: "Sent", role: "\\Sent", selectable: true }];
  service.transport.scan = async (account, folder, known, batch) => {
    const messages = Array.from({ length: count }, (_, i) => ({ accountId: account.id, folderId: folder.id, uid: i + 1, uidValidity: validity, subject: `邮件 ${i}`, bodyLoaded: true, flags: [], attachments: [] }));
    await batch(messages); return { uids: messages.map((m) => m.uid), uidValidity: validity };
  };
  await service.syncAccount(service.account("demo")); assert.equal(sent.length, 0);
  count = 2; await service.syncAccount(service.account("demo"));
  await Promise.all([...service.notificationWork]);
  assert.equal(sent.length, 1); assert.match(sent[0].title, /收到 1 封新邮件/);
  await service.syncAccount(service.account("demo"));
  validity = "2"; await service.syncAccount(service.account("demo"));
  await Promise.all([...service.notificationWork]); assert.equal(sent.length, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailService } from "../src/service.mjs";
import { DEFAULT_SETTINGS, notificationAllowed } from "../src/settings.mjs";
import { toastXml } from "../src/notifications.mjs";
const human = { kind: "human" };
async function fixture(t) { const directory = await mkdtemp(join(tmpdir(), "mail-experience-")), notifications = []; const service = new MailService({ directory, clock: () => Date.parse("2026-11-07T15:00:00Z"), notify: (n) => notifications.push(n), transport: { close: async () => {} } }); t.after(() => service.close()); return { service, directory, notifications }; }

test("experience preferences validate all fields and preserve partial saves", async (t) => {
  const { service } = await fixture(t);
  await service.invoke({ action: "settings.save", value: { theme: "dark", density: "compact", pageSize: 100, markReadDelay: 3, aiLanguage: "日本語" } }, human);
  await service.invoke({ action: "settings.save", value: { accent: "teal" } }, human);
  assert.equal(service.settings().theme, "dark"); assert.equal(service.settings().pageSize, 100);
  for (const value of [{ theme: "other" }, { pageSize: 10000 }, { markReadDelay: -1 }, { showAvatars: 1 }, { quietStart: "25:00" }, { aiLanguage: " " }, { quietHours: true, quietStart: "12:00", quietEnd: "12:00" }]) await assert.rejects(service.invoke({ action: "settings.save", value }, human));
  const state = await service.invoke({ action: "ui.state", resources: ["settings", "accounts"] }, human);
  assert.equal(state.changes.settings.theme, "dark");
});

test("UI delta versions observe inserts, updates, deletes and rollbacks without sending unused resources", async (t) => {
  const { service } = await fixture(t), read = (previous = {}) => service.invoke({ action: "ui.state", resources: ["tasks", "drafts", "settings"], epoch: previous.epoch, versions: previous.versions }, human);
  service.store.put("drafts", { id: "draft", text: "private large body".repeat(1000), html: "big", status: "draft" });
  const first = await read(); assert.equal(first.changes.drafts[0].text, undefined); assert.equal(first.changes.contacts, undefined);
  assert.deepEqual((await read(first)).changes, {});
  service.store.put("tasks", { id: "one", title: "test" });
  const second = await read(first); assert.equal(second.changes.tasks.length, 1); assert.equal(second.changes.drafts, undefined);
  assert.throws(() => service.store.transaction(() => { service.store.put("tasks", { id: "two" }); throw Error("rollback"); }));
  assert.deepEqual((await read(second)).changes, {});
  service.store.remove("tasks", "one"); assert.deepEqual((await read(second)).changes.tasks, []);
  await assert.rejects(service.invoke({ action: "ui.state", resources: ["credentials"] }, human));
});

test("new preferences and account sync policy survive backup restore and invalidate previously read UI resources", async (t) => {
  const { service } = await fixture(t), { service: restored } = await fixture(t);
  await service.invoke({ action: "settings.save", value: { theme: "dark", motion: "off", notificationSound: false, quietHours: true, aiLanguage: "日本語", composeFormat: "plain" } }, human);
  service.store.put("accounts", { id: "one", enabled: true, local: false, syncPaused: true, syncIntervalMinutes: 9 });
  service.store.put("tasks", { id: "one", title: "retained", priority: "high" });
  const before = await restored.invoke({ action: "ui.state", resources: ["settings", "accounts", "tasks"] }, human), backup = await service.backup();
  await restored.invoke({ action: "backup.restore", base64: backup.base64 }, human);
  const after = await restored.invoke({ action: "ui.state", resources: ["settings", "accounts", "tasks"], versions: before.versions, epoch: before.epoch }, human);
  assert.equal(after.changes.settings.theme, "dark"); assert.equal(after.changes.settings.notificationSound, false); assert.equal(after.changes.settings.aiLanguage, "日本語"); assert.equal(after.changes.settings.composeFormat, "plain");
  assert.equal(after.changes.accounts[0].syncPaused, true); assert.equal(after.changes.accounts[0].syncIntervalMinutes, 9); assert.equal(after.changes.tasks[0].title, "retained");
});

test("notification categories, quiet hours across midnight, and silent delivery retain in-app reminders", async (t) => {
  const { service, notifications } = await fixture(t);
  assert.equal(notificationAllowed({ ...DEFAULT_SETTINGS, quietHours: true }, "new-mail", service.clock()), false);
  assert.equal(notificationAllowed({ ...DEFAULT_SETTINGS, quietHours: true }, "new-mail", Date.parse("2026-11-08T00:00:00Z")), true);
  assert.equal(notificationAllowed({ ...DEFAULT_SETTINGS, notifyCalendar: false }, "event", service.clock()), false);
  await service.invoke({ action: "settings.save", value: { quietHours: true } }, human);
  service.addNotification("new-mail", "private subject", {}); await Promise.all(service.notificationWork);
  assert.equal(notifications.length, 0); assert.equal(service.store.list("notifications").length, 1);
  await service.invoke({ action: "settings.save", value: { quietHours: false, notificationSound: false } }, human);
  service.addNotification("task", "test", {}); await Promise.all(service.notificationWork);
  assert.equal(notifications[0].silent, true); assert.match(toastXml(notifications[0]), /audio silent="true"/);
});

test("account auto-sync can pause independently of sending and global sync preferences", async (t) => {
  const { service } = await fixture(t);
  service.store.put("accounts", { id: "one", enabled: true, status: "connected" });
  await service.invoke({ action: "accounts.sync-settings", id: "one", paused: true, interval: 7 }, human);
  assert.equal(service.account("one").enabled, true);
  let calls = 0; service.syncAccount = async () => { calls++; };
  service.scheduleSync(service.account("one")); assert.equal(calls, 0);
  service.scheduleSync(service.account("one"), true); await Promise.all(service.syncing.values()); assert.equal(calls, 1);
  await assert.rejects(service.invoke({ action: "accounts.sync-settings", id: "one", paused: false, interval: 0 }, human));
});

test("temporary cleanup requires a fresh explicit preview and protects backup and legacy files", async (t) => {
  const { service } = await fixture(t);
  const temp = await service.download("example.txt", "text/plain", Buffer.from("temporary")), backup = await service.download("backup.zip", "application/zip", Buffer.from("backup"), "backup");
  await assert.rejects(service.invoke({ action: "storage.preview", ids: [backup.id] }, human), { code: "PROTECTED_FILE" });
  const preview = await service.invoke({ action: "storage.preview", ids: [temp.id] }, human);
  await assert.rejects(service.invoke({ action: "storage.clean", id: preview.id }), { code: "USER_ACTION_REQUIRED" });
  const info = service.store.get("exports", temp.id); await writeFile(info.path, "changed");
  await assert.rejects(service.invoke({ action: "storage.clean", id: preview.id }, human), { code: "PREVIEW_CHANGED" });
  const next = await service.invoke({ action: "storage.preview", ids: [temp.id] }, human);
  assert.equal((await service.invoke({ action: "storage.clean", id: next.id }, human)).removed, 1);
  assert.equal((await readFile(service.store.get("exports", backup.id).path)).toString(), "backup");
});

test("diagnostics exclude content, addresses, paths and raw errors", async (t) => {
  const { service } = await fixture(t);
  service.store.put("accounts", { id: "one", email: "private@example.invalid", name: "SECRET", error: { message: "password: SECRET", code: "SECRET with data" }, status: "error" });
  service.store.log("failure", { message: "SECRET" });
  const report = JSON.stringify(await service.invoke({ action: "diagnostics.read" }, human));
  assert.ok(!report.includes("SECRET")); assert.ok(!report.includes("private@example.invalid")); assert.ok(!report.includes(service.directory));
});

test("contact pagination can locate an Agent target without loading the entire address book", async (t) => {
  const { service } = await fixture(t);
  for (let i = 0; i < 75; i++) service.store.put("contacts", { id: `contact-${String(i).padStart(2, "0")}`, name: `Person ${i}`, email: `person${i}@example.invalid` });
  const page = await service.invoke({ action: "resources.list", kind: "contacts", targetId: "contact-00", limit: 25 }, human);
  assert.ok(page.items.some((c) => c.id === "contact-00")); assert.equal(page.items.length, 25); assert.equal(page.total, 75);
  service.store.put("contacts", { id: "deleted", deleted: true });
  await assert.rejects(service.invoke({ action: "resources.list", kind: "contacts", targetId: "deleted", limit: 25 }, human), { code: "NOT_FOUND" });
});

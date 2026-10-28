import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailService } from "../src/service.mjs";
import { normalizeAccount } from "../src/mail.mjs";

const HUMAN = { kind: "human" };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-mail-settings-"));
  let time = Date.parse("2026-10-28T08:00:00Z");
  const flags = [], transport = { close: async () => {}, reset: async () => {}, folders: async () => [], flags: async (...args) => flags.push(args) };
  const service = new MailService({ directory, transport, clock: () => time });
  for (const id of ["first", "second"]) service.store.put("accounts", { ...normalizeAccount({ id, email: `${id}@163.com` }), nextSyncAt: time + 120000 });
  t.after(() => service.stopped ? undefined : service.close());
  return { service, directory, transport, flags, advance: (ms) => time += ms, now: () => time };
}

test("preferences validate input, merge changes, persist after reopen and survive backup", async (t) => {
  const { service, directory } = await fixture(t);
  assert.equal(service.state().settings.calendarTimeZone, "Asia/Hong_Kong");
  assert.equal(service.state().settings.firstDay, 1);
  await assert.rejects(service.invoke({ action: "settings.save", value: {} }), { code: "USER_ACTION_REQUIRED" });
  const value = { calendarTimeZone: "America/New_York", eventTimeZone: "Asia/Tokyo", calendarView: "timeGridWeek", firstDay: 1, defaultAccountId: "second", syncIntervalMinutes: 5, markReadOnOpen: false };
  for (const bad of [{ calendarTimeZone: "Invalid/Zone" }, { eventTimeZone: "Invalid/Zone" }, { calendarView: "invalid" }, { firstDay: 7 }, { syncIntervalMinutes: 0 }, { syncIntervalMinutes: 1.5 }, { syncIntervalMinutes: 61 }, { markReadOnOpen: "false" }, { defaultAccountId: "missing" }, { defaultAccountId: "local" }]) {
    await assert.rejects(service.invoke({ action: "settings.save", value: bad }, HUMAN));
  }
  await service.invoke({ action: "settings.save", value }, HUMAN);
  await service.invoke({ action: "settings.save", value: { firstDay: 0 } }, HUMAN);
  const expected = { ...value, firstDay: 0 };
  const check = (settings) => { for (const [key, v] of Object.entries(expected)) assert.equal(settings[key], v); };
  const backup = await service.backup();
  await service.close();
  const reopened = new MailService({ directory }); t.after(() => reopened.close()); check(reopened.state().settings);
  const restored = new MailService({ directory: await mkdtemp(join(tmpdir(), "dsh-mail-settings-restore-")) }); t.after(() => restored.close());
  await restored.invoke({ action: "backup.restore", base64: backup.base64 }, HUMAN); check(restored.state().settings);
});

test("configured interval changes periodic sync without retrying before the due time", async (t) => {
  const { service, advance, now } = await fixture(t);
  await service.syncAccount(service.account("first"));
  assert.equal(service.account("first").nextSyncAt, now() + 120000);
  await service.invoke({ action: "settings.save", value: { syncIntervalMinutes: 5 } }, HUMAN);
  assert.equal(service.account("first").nextSyncAt, now() + 300000);
  const synced = []; service.scheduleSync = (account) => synced.push(account.id);
  advance(299999); await service.tick(); assert.deepEqual(synced, []);
  advance(1); await service.tick(); assert.ok(synced.includes("first"));
});

test("new drafts use preferred account and its signature, preserve edits and fall back if disabled", async (t) => {
  const { service } = await fixture(t);
  const signature = service.saveResource("signatures", { name: "工作签名", text: "第二账号签名" });
  service.store.put("accounts", { ...service.account("second"), signatureId: signature.id });
  await service.invoke({ action: "settings.save", value: { defaultAccountId: "second" } }, HUMAN);
  const draft = await service.invoke({ action: "drafts.save", draft: {} });
  assert.equal(draft.accountId, "second"); assert.equal(draft.text, "第二账号签名");
  const edited = await service.invoke({ action: "drafts.save", draft: { id: draft.id, text: "用户正文" } }); assert.equal(edited.text, "用户正文");
  const blank = await service.invoke({ action: "drafts.save", draft: { accountId: "second", text: "", html: "" } }); assert.equal(blank.text, "");
  service.store.put("folders", { id: "inbox", accountId: "second", path: "INBOX" });
  const message = service.store.upsertMessage({ accountId: "second", folderId: "inbox", uidValidity: "1", uid: 1, subject: "原邮件", text: "原正文", bodyLoaded: true, from: [{ address: "client@example.com" }], to: [], cc: [], flags: [], attachments: [] });
  await service.invoke({ action: "settings.save", value: { defaultAccountId: "first" } }, HUMAN);
  const reply = await service.invoke({ action: "drafts.reply", id: message.id }); assert.match(reply.text, /第二账号签名[\s\S]*原正文/); assert.equal(reply.accountId, "second");
  const forward = await service.invoke({ action: "drafts.reply", id: message.id, mode: "forward" }); assert.match(forward.text, /第二账号签名[\s\S]*原正文/);
  await service.invoke({ action: "settings.save", value: { defaultAccountId: "second" } }, HUMAN);
  service.store.put("accounts", { ...service.account("second"), enabled: false });
  assert.equal((await service.invoke({ action: "drafts.save", draft: {} })).accountId, "first");
});

test("sync failures keep their retry delay when preferences change", async (t) => {
  const { service, now } = await fixture(t);
  service.store.put("accounts", { ...service.account("first"), status: "error", nextSyncAt: now() + 1800000 });
  await service.invoke({ action: "settings.save", value: { syncIntervalMinutes: 1 } }, HUMAN);
  assert.equal(service.account("first").nextSyncAt, now() + 1800000);
});

test("event defaults apply only to new events; changing display zone never rewrites existing instants", async (t) => {
  const { service } = await fixture(t);
  await service.invoke({ action: "settings.save", value: { eventTimeZone: "Asia/Tokyo" } }, HUMAN);
  const event = await service.invoke({ action: "events.save", event: { title: "默认时区", start: "2026-10-28T09:00:00", end: "2026-10-28T10:00:00" } });
  assert.equal(event.timeZone, "Asia/Tokyo"); assert.equal(Date.parse(event.start), Date.parse("2026-10-28T00:00:00Z"));
  await service.invoke({ action: "settings.save", value: { calendarTimeZone: "America/New_York", eventTimeZone: "UTC" } }, HUMAN);
  const edited = await service.invoke({ action: "events.save", event: { id: event.id, title: "保留原时区" } });
  assert.equal(edited.timeZone, "Asia/Tokyo"); assert.equal(edited.start, event.start);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailService } from "../src/service.mjs";
import { Store } from "../src/store.mjs";
import { WindowsVault } from "../src/vault.mjs";
import { normalizeAccount, composeDraft, parseMessage, MailTransport } from "../src/mail.mjs";
import { normalizeEvent, exportEvents, importEvents, occurrences, applyInvitation } from "../src/calendar.mjs";
import { validateRule } from "../src/rules.mjs";
import JSZip from "jszip";
import { EVENT_COLORS, eventAppearance, eventColor } from "../ui/event-color.mjs";

const HUMAN = { kind: "human", sessionId: "human-test" }, AGENT = { kind: "agent", sessionId: "agent-test" };
test("event colors override calendar, choose readable text and reject invalid input", () => {
  const base = { title: "Color", start: "2026-10-28", end: "2026-10-29", allDay: true };
  assert.throws(() => normalizeEvent({ ...base, start: "2026-10-28T10:00:00", end: "2026-10-28T11:00:00" }), { code: "INVALID_EVENT_RANGE" });
  for (const color of ["red", "#123", "url(https://example.com)", 123]) assert.throws(() => normalizeEvent({ ...base, color }), { code: "INVALID_EVENT_COLOR" });
  const calendars = [{ id: "default", color: "#15803d" }];
  assert.equal(eventColor(normalizeEvent(base), calendars), "#15803d");
  assert.equal(eventAppearance({ color: "#ffead7" }, calendars).backgroundColor, "#ffb878");
  assert.equal(eventAppearance({ color: "#15803d" }, []).backgroundColor, "#15803d");
  const luminance = (hex) => { const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722; };
  for (const color of [...EVENT_COLORS.map(([, value]) => value), "#2563eb", "#155e75", "#15803d", "#7c3aed", "#be185d", "#dc2626", "#c2410c", "#475569", "#ffffff", "#000000"]) {
    const event = { color }, style = eventAppearance(event, []);
    assert.ok((Math.max(luminance(style.backgroundColor), luminance(style.textColor)) + 0.05) / (Math.min(luminance(style.backgroundColor), luminance(style.textColor)) + 0.05) >= 4.5, `Readable text for ${color}`);
    assert.equal(event.color, color);
  }
});
test("event color persists through update, recurrence exceptions and database reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-mail-colors-"));
  let service = new MailService({ directory }); t.after(() => service.close());
  const base = await service.invoke({ action: "events.save", event: { title: "颜色事件", start: "2026-10-28", end: "2026-10-29", allDay: true, color: "#7c3aed", rrule: "FREQ=DAILY;COUNT=3" } }, HUMAN);
  await service.invoke({ action: "events.save", event: { id: base.id, title: "改名保留颜色" } }, AGENT);
  await service.invoke({ action: "events.save", event: { ...base, id: undefined, revision: undefined, recurrenceId: "2026-10-29", start: "2026-10-29", end: "2026-10-30", color: "#dc2626", rrule: "" } }, HUMAN);
  await service.close(); service = new MailService({ directory });
  const events = await service.invoke({ action: "events.list", start: "2026-10-28", end: "2026-11-01" });
  assert.deepEqual(events.map((e) => e.color), ["#7c3aed", "#dc2626", "#7c3aed"]);
  const restored = await service.invoke({ action: "events.save", event: { id: base.id, color: "" } }, HUMAN);
  assert.equal(eventColor(restored, service.state().calendars), "#155e75");
});
const raw = Buffer.from("From: Client <client@example.com>\r\nTo: me@163.com\r\nSubject: =?UTF-8?B?5oql5Lu3?=\r\nMessage-ID: <quote-1@example.com>\r\nDate: Tue, 27 Oct 2026 10:00:00 +0800\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n项目报价。日本語の見積書。\r\nFrom original line\r\n");
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-mail-test-")); let clock = Date.parse("2026-10-28T08:00:00Z");
  const sent = [], transport = { reset: async () => {}, close: async () => {}, send: async (...args) => { sent.push(args); return { accepted: ["client@example.com"], rejected: [] }; }, ...overrides };
  const service = new MailService({ directory, transport, clock: () => clock, vault: { seal: async (x) => `sealed:${x}`, open: async (x) => x.slice(7) } });
  service.store.put("accounts", { id: "me", ...normalizeAccount({ id: "me", email: "me@163.com" }), nextSyncAt: Infinity });
  t.after(() => service.close());
  return { service, directory, sent, advance: (ms) => { clock += ms; }, transport };
}
async function draft(service) { return service.invoke({ action: "drafts.save", draft: { accountId: "me", to: "client@example.com", subject: "报价回复", text: "周五前交付。" } }, AGENT); }
async function queued(service) { const d = await draft(service), p = await service.invoke({ action: "send.preview", id: d.id }, AGENT); await service.invoke({ action: "preview.confirm", id: p.id }, HUMAN); return d.id; }
async function drain(service) { await Promise.all([...service.work.values()]); }

test("runtime version matches the package version", async (t) => {
  const { service } = await fixture(t), pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal((await service.invoke({ action: "state" })).version, pkg.version);
});

test("FTS searches Chinese/Japanese; UID identity is scoped; unchanged refresh preserves revision", async (t) => {
  const { service } = await fixture(t); const s = service.store;
  const m = s.upsertMessage({ accountId: "me", folderId: "a", uidValidity: "1", uid: 1, subject: "项目报价", text: "日本語の見積書", from: [{ address: "client@example.com" }], flags: [], bodyLoaded: true });
  assert.equal(s.upsertMessage(m).revision, m.revision);
  assert.equal(s.search({ q: "报价" }).total, 1); assert.equal(s.search({ q: "見積" }).total, 1); assert.equal(s.search({ from: "client" }).total, 1);
  const n = s.upsertMessage({ ...m, id: undefined, folderId: "b" }); assert.notEqual(n.id, m.id);
  assert.notEqual(s.upsertMessage({ ...m, id: undefined, uidValidity: "2" }).id, m.id);
  assert.equal(s.search({ q: '" OR 1=1 --' }).total, 0);
});
test("agent cannot confirm, accept credentials, enable rules, or spoof status", async (t) => {
  const { service } = await fixture(t), d = await draft(service), p = await service.invoke({ action: "send.preview", id: d.id }, AGENT);
  await assert.rejects(service.invoke({ action: "preview.confirm", id: p.id, confirmed: true }, AGENT), { code: "USER_ACTION_REQUIRED" });
  await assert.rejects(service.invoke({ action: "accounts.save", account: { email: "a@163.com" }, password: "secret" }, AGENT), { code: "USER_ACTION_REQUIRED" });
  await assert.rejects(service.invoke({ action: "drafts.save", draft: { accountId: "me", secret: "secret" } }, AGENT), { code: "SECRET_INPUT_FORBIDDEN" });
  const saved = await service.invoke({ action: "drafts.save", draft: { ...d, status: "queued", sendAt: "2000-01-01" } }, AGENT); assert.equal(saved.status, "draft"); assert.equal(saved.sendAt, undefined);
  assert.throws(() => validateRule({ name: "bad", conditions: [{ field: "subject", operator: "contains", value: "x" }], actions: [{ action: "send" }] }), { code: "RULE_ACTION_FORBIDDEN" });
});
test("concrete preview invalidates on draft edit but survives sync status changes", async (t) => {
  const { service } = await fixture(t), d = await draft(service), p = await service.invoke({ action: "send.preview", id: d.id }, AGENT);
  service.store.put("accounts", { ...service.account("me"), status: "syncing" }); await service.invoke({ action: "preview.confirm", id: p.id }, HUMAN);
  await service.invoke({ action: "drafts.cancel", id: d.id }, AGENT);
  const next = service.store.get("drafts", d.id), p2 = await service.invoke({ action: "send.preview", id: d.id }, AGENT);
  await service.invoke({ action: "drafts.save", draft: { ...next, text: "改变承诺" } }, AGENT);
  await assert.rejects(service.invoke({ action: "preview.confirm", id: p2.id }, HUMAN), { code: "PREVIEW_CHANGED" });
});
test("10 second outbox, sent-copy failure never repeats SMTP, cancellation", async (t) => {
  const { service, advance, sent } = await fixture(t), key = await queued(service);
  advance(9999); await service.tick(); assert.equal(sent.length, 0);
  advance(2); await service.tick(); assert.equal(sent.length, 1); assert.equal(service.store.get("drafts", key).status, "sent"); assert.equal(service.store.get("drafts", key).sentCopyStatus, "failed");
  await service.tick(); assert.equal(sent.length, 1);
  const cancelled = await queued(service); await service.invoke({ action: "drafts.cancel", id: cancelled }, AGENT); advance(11000); await service.tick(); assert.equal(sent.length, 1);
});
test("ambiguous SMTP never retries automatically; authentication rejection is definite", async (t) => {
  let attempts = 0; const { service, advance, transport } = await fixture(t, { send: async () => { attempts++; throw Object.assign(new Error("socket closed after DATA"), { code: "ECONNRESET" }); } });
  const key = await queued(service); advance(11000); await service.tick(); await service.tick(); assert.equal(attempts, 1); assert.equal(service.store.get("drafts", key).status, "uncertain");
  transport.send = async () => { throw Object.assign(new Error("535 denied"), { responseCode: 535 }); }; const key2 = await queued(service); advance(11000); await service.tick(); assert.equal(service.store.get("drafts", key2).status, "failed");
});
test("restart recovers missed scheduled send without sending and preserves unknown result", async (t) => {
  const { service } = await fixture(t); service.store.put("drafts", { id: "missed", accountId: "me", status: "queued", sendAt: "2020-01-01T00:00:00Z" }); service.store.put("drafts", { id: "unknown", status: "sending" }); service.recover();
  assert.equal(service.store.get("drafts", "missed").status, "needs-confirmation"); assert.equal(service.store.get("drafts", "unknown").status, "uncertain");
});
test("EML/MBOX export actually exists, roundtrips content, local copy and purge require preview", async (t) => {
  const { service } = await fixture(t), imported = await service.invoke({ action: "mail.import", base64: raw.toString("base64") }, HUMAN);
  const message = await service.invoke({ action: "message.read", id: imported.ids[0] }); assert.match(message.text, /見積書/); assert.equal(message.rawPath, undefined); assert.ok(service.state().folders[0].path);
  const exp = await service.invoke({ action: "mail.export", ids: imported.ids, format: "mbox" }); assert.ok((await readFile(exp.localPath)).length > 0);
  const again = await service.invoke({ action: "mail.import", base64: exp.base64, format: "mbox" }, HUMAN); assert.match(service.message(again.ids[0]).text, /From original line/);
  const target = await service.invoke({ action: "folders.action", operation: "create", accountId: "local", path: "目标/日文" }, HUMAN);
  await service.invoke({ action: "messages.action", ids: imported.ids, operation: "copy", destinationId: target.id }); await drain(service); assert.equal(service.store.folderMessages(target.id).length, 1);
  const p = await service.invoke({ action: "messages.action", ids: imported.ids, operation: "purge", confirmed: true }); assert.ok(service.message(imported.ids[0])); await service.invoke({ action: "preview.confirm", id: p.id }, HUMAN); await drain(service); assert.equal(service.store.message(imported.ids[0]), null);
});
test("MIME keeps Bcc out of headers; inline image uses CID; receipt is requested", async (t) => {
  const { service } = await fixture(t), a = await service.upload({ filename: "图.png", contentType: "image/png", base64: Buffer.from("fakepng").toString("base64") });
  const result = await composeDraft({ to: "x@example.com", bcc: "hidden@example.com", subject: "日文日本語", html: '<img src="data:image/png;base64,ZmFrZXBuZw==" alt="cid:test@dsh-mail">', text: "内嵌图片", requestReceipt: true, attachments: [{ id: a.id, cid: "test@dsh-mail" }] }, service.account("me"), (key) => service.store.get("attachments", key));
  assert.ok(result.envelope.to.includes("hidden@example.com")); assert.doesNotMatch(result.raw.toString(), /^Bcc:/im); assert.match(result.raw.toString(), /Disposition-Notification-To:/);
  const parsed = await parseMessage(result.raw, join(service.directory, "parse")); assert.match(parsed.html, /src="cid:test@dsh-mail"/); assert.equal(parsed.attachments.length, 1);
});
test("calendar repeat crosses DST with wall time preserved; import duplicate/update/cancel", async (t) => {
  const { service } = await fixture(t), event = normalizeEvent({ title: "纽约会议", start: "2026-03-01T09:00:00", end: "2026-03-01T10:00:00", timeZone: "America/New_York", rrule: "FREQ=WEEKLY;COUNT=3", organizer: "host@example.com" });
  const [parsed] = importEvents(exportEvents([event])); const expanded = occurrences([parsed], "2026-03-01", "2026-03-25"); assert.equal(expanded.length, 3); assert.match(expanded[0].start, /14:00:00/); assert.match(expanded[1].start, /13:00:00/);
  assert.equal(applyInvitation(service.store, parsed).status, "created"); assert.equal(applyInvitation(service.store, parsed).status, "unchanged"); assert.equal(applyInvitation(service.store, { ...parsed, sequence: 1, title: "更新" }).status, "updated"); assert.equal(applyInvitation(service.store, { ...parsed, sequence: 2, status: "CANCELLED" }).status, "cancelled"); assert.equal(service.store.list("events").length, 1);
  assert.equal(applyInvitation(service.store, { ...parsed, sequence: 3, organizer: "attacker@example.com" }).status, "organizer-conflict");
});
test("CSV and vCard contacts roundtrip", async (t) => {
  const { service } = await fixture(t); service.saveResource("contacts", { name: "测试联系人", email: "client@example.com", group: "客户" });
  for (const format of ["csv", "vcard"]) { const file = await service.exportContacts(format); const results = service.importContacts({ format, text: Buffer.from(file.base64, "base64").toString() }); assert.equal(results.length, 1); assert.equal(results[0].status, "saved"); }
});
test("backup restores cached originals and excludes credentials and pending sends", async (t) => {
  const { service } = await fixture(t); service.store.put("credentials", { id: "me", ciphertext: "super-secret-ciphertext" }); await service.importMail({ base64: raw.toString("base64") }); await queued(service);
  const file = await service.backup(), zip = await JSZip.loadAsync(Buffer.from(file.base64, "base64")); assert.doesNotMatch(await zip.file("snapshot.json").async("string"), /super-secret-ciphertext/);
  const directory = await mkdtemp(join(tmpdir(), "dsh-mail-restore-")), next = new MailService({ directory, transport: { close: async () => {} } }); t.after(() => next.close()); await next.restore({ base64: file.base64 }); assert.equal(next.store.search({ q: "报价" }).total, 1); assert.equal(next.store.list("credentials").length, 0); assert.equal(next.store.list("drafts")[0].status, "draft"); assert.equal(next.account("me").enabled, false);
});
test("backup rejects host paths and credentials before any database mutation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-mail-invalid-")), service = new MailService({ directory, transport: { close: async () => {} } }); t.after(() => service.close());
  const zip = new JSZip(); zip.file("snapshot.json", JSON.stringify({ version: 1, messages: [], entities: [{ kind: "accounts", data: { id: "x" } }, { kind: "attachments", data: { id: "evil", path: "C:/Windows/win.ini" } }] }));
  await assert.rejects(service.restore({ base64: await zip.generateAsync({ type: "base64" }) }), { code: "INVALID_BACKUP_PATH" }); assert.equal(service.store.list("accounts").length, 0);
});
test("DPAPI roundtrip under current Windows user", { skip: process.platform !== "win32" }, async () => { const vault = new WindowsVault(), secret = "测试随机授权码-for-test-only"; const sealed = await vault.seal(secret); assert.notEqual(sealed, secret); assert.equal(await vault.open(sealed), secret); });

test("suspend gap and changed sender config both require fresh send confirmation", async (t) => {
  const { service, advance, sent } = await fixture(t); const key = await queued(service); advance(3600000); await service.tick(); assert.equal(sent.length, 0); assert.equal(service.store.get("drafts", key).status, "needs-confirmation");
  const changed = await queued(service); service.store.put("accounts", { ...service.account("me"), email: "another@163.com" }); advance(11000); await service.tick(); assert.equal(sent.length, 0); assert.equal(service.store.get("drafts", changed).status, "needs-confirmation");
});
test("sync loads text but defers attachment bytes; UIDVALIDITY reset removes stale instances", async (t) => {
  let validity = "1", downloads = 0;
  const { service } = await fixture(t, {
    folders: async () => [{ path: "INBOX", name: "收件箱", role: "\\Inbox", delimiter: "/", selectable: true }],
    scan: async (account, folder, known, callback) => { await callback([{ accountId: account.id, folderId: folder.id, uidValidity: validity, uid: 1, subject: "带附件", size: 50000000, flags: [], bodyStructure: { type: "multipart/mixed" }, attachments: [{ id: `file-${validity}`, part: "2", filename: "报告.pdf", size: 30000000, contentType: "application/pdf" }] }]); return { uidValidity: validity, uids: [1] }; },
    body: async () => ({ text: "正文单独缓存", html: "", bodyLoaded: true }), attachment: async () => { downloads++; return Buffer.from("%PDF fixture"); }
  });
  await service.syncAccount(service.account("me")); const old = service.store.search({}).items[0]; assert.equal(downloads, 0); assert.equal(old.bodyLoaded, true);
  const file = await service.attachmentDownload({ id: "file-1" }); assert.equal(downloads, 1); assert.ok(file.base64); await service.attachmentDownload({ id: "file-1" }); assert.equal(downloads, 1);
  validity = "2"; await service.syncAccount(service.account("me")); assert.equal(service.store.message(old.id), null); assert.equal(service.store.search({}).total, 1);
});
test("folder copy freezes hierarchy and supports restarting pending per-message work", async (t) => {
  const { service } = await fixture(t); const imported = await service.importMail({ base64: raw.toString("base64"), folderName: "项目" });
  await assert.rejects(service.invoke({ action: "folders.action", operation: "copy", id: imported.folderId, path: "项目/子级", accountId: "local" }), { code: "INVALID_FOLDER_DESTINATION" });
  const job = await service.invoke({ action: "folders.action", operation: "copy", id: imported.folderId, path: "项目副本", accountId: "local" }); await drain(service);
  const done = service.store.get("jobs", job.id); assert.equal(done.status, "completed"); assert.equal(done.items[0].copies[0].status, "done"); const targetId = done.items[0].targetFolderId;
  service.store.put("jobs", { ...done, status: "interrupted", items: [{ ...done.items[0], status: "interrupted", copies: [...done.items[0].copies, { id: imported.ids[0], status: "pending" }] }] });
  service.retryJob(job.id); await drain(service); assert.equal(service.store.folderMessages(targetId).length, 2); assert.equal(service.store.get("jobs", job.id).status, "completed");
});
test("cross-account copy without APPENDUID retains source and reports verification", async (t) => {
  const { service } = await fixture(t, { append: async () => ({ uid: 12 }) }); const imported = await service.importMail({ base64: raw.toString("base64") });
  service.store.put("folders", { id: "remote", accountId: "me", path: "Target", delimiter: "/" });
  await assert.rejects(service.messageAction(imported.ids[0], { operation: "move", destinationId: "remote" }), { code: "COPY_VERIFICATION_REQUIRED" }); assert.ok(service.message(imported.ids[0]));
});
test("calendar single exception, all-day and cancellation without DTSTART", async (t) => {
  const { service } = await fixture(t), base = normalizeEvent({ title: "Weekly", start: "2026-10-01T09:00:00+08:00", end: "2026-10-01T10:00:00+08:00", rrule: "FREQ=WEEKLY;COUNT=3", organizer: "host@example.com" });
  const exception = normalizeEvent({ ...base, id: "exception", recurrenceId: "2026-10-08T09:00:00+08:00", start: "2026-10-09T11:00:00+08:00", end: "2026-10-09T12:00:00+08:00", rrule: "" });
  const list = occurrences([base, exception], "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"); assert.equal(list.length, 3); assert.ok(list.some((e) => e.id === "exception")); assert.ok(!list.some((e) => e.start === "2026-10-08T01:00:00.000Z"));
  const allDay = normalizeEvent({ title: "All day", start: "2026-10-03", end: "2026-10-05", allDay: true }); assert.equal(importEvents(exportEvents([allDay]))[0].end, "2026-10-05");
  applyInvitation(service.store, base); const cancel = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:CANCEL\r\nBEGIN:VEVENT\r\nUID:${base.uid}\r\nSEQUENCE:1\r\nORGANIZER:mailto:host@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const [parsed] = importEvents(cancel); assert.equal(applyInvitation(service.store, parsed).status, "cancelled"); assert.equal(service.store.list("events")[0].start, base.start);
});
test("MDN received is reported; no MDN remains unknown", async (t) => {
  const { service } = await fixture(t); const d = service.store.put("drafts", { status: "sent", accountId: "local", messageId: "<sent@example.com>" });
  const report = Buffer.from('From: receiver@example.com\r\nTo: me@163.com\r\nSubject: receipt\r\nMIME-Version: 1.0\r\nContent-Type: multipart/report; report-type=disposition-notification; boundary="receipt"\r\n\r\n--receipt\r\nContent-Type: text/plain\r\n\r\nDisplayed\r\n--receipt\r\nContent-Type: message/disposition-notification\r\n\r\nFinal-Recipient: rfc822;receiver@example.com\r\nOriginal-Message-ID: <sent@example.com>\r\nDisposition: manual-action/MDN-sent-manually; displayed\r\n\r\n--receipt--\r\n');
  const imported = await service.importMail({ base64: report.toString("base64") }); assert.equal(service.store.get("drafts", d.id).receipt, undefined); await service.inspectReceipts(service.message(imported.ids[0])); assert.match(service.store.get("drafts", d.id).receipt.disposition, /displayed/);
});

test("move preserves stable links and attachment cache; copies have independent lazy attachment identities", async (t) => {
  const fetched = [], { service } = await fixture(t, { attachment: async (account, folder, message) => { fetched.push([folder.id, message.uid]); return Buffer.from("attachment"); }, move: async () => ({ uidMap: new Map([[1, 22]]), uidValidity: 2n }), copy: async () => ({ uidMap: new Map([[22, 33]]), uidValidity: 3n }) });
  for (const [id, path] of [["source", "INBOX"], ["target", "Archive"], ["copy", "Copy"]]) service.store.put("folders", { id, path, accountId: "me" });
  const m = service.store.upsertMessage({ accountId: "me", folderId: "source", uid: 1, uidValidity: "1", subject: "attachment", flags: [], attachments: [{ id: "lazy", part: "2", filename: "a.txt" }] }); service.store.put("attachments", { ...m.attachments[0], messageId: m.id });
  service.scheduleSync = () => {};
  const moved = await service.messageAction(m.id, { operation: "move", destinationId: "target" }); assert.equal(moved.messageId, m.id); assert.equal(service.store.location("me", "source", "1", 1), null); assert.equal(service.store.search({ folderId: "target" }).items[0].id, m.id); assert.deepEqual(fetched, [["source", 1]]);
  const a = service.store.get("attachments", "lazy"); service.store.put("attachments", { ...a, path: undefined });
  const copied = await service.messageAction(m.id, { operation: "copy", destinationId: "copy" }); const copy = service.message(copied.messageId); assert.notEqual(copy.attachments[0].id, "lazy"); service.store.deleteMessage(m.id);
  service.store.put("attachments", { ...service.store.get("attachments", copy.attachments[0].id), path: undefined });
  await service.ensureAttachment(copy.attachments[0].id); assert.deepEqual(fetched.at(-1), ["copy", 33]);
});

test("cross-account copy keeps a readable raw source and attachments after source deletion", async (t) => {
  const { service } = await fixture(t); const imported = await service.importMail({ base64: raw.toString("base64") }); const source = service.message(imported.ids[0]);
  service.store.put("accounts", { id: "other", local: true, enabled: true }); const folder = service.store.put("folders", { accountId: "other", path: "target", delimiter: "/" });
  const copied = await service.messageAction(source.id, { operation: "copy", destinationId: folder.id }); service.store.deleteMessage(source.id); assert.deepEqual(await service.ensureRaw(copied.messageId), raw);
});

test("missing special folder mapping is actionable and never changes the message", async (t) => {
  const { service } = await fixture(t), imported = await service.importMail({ base64: raw.toString("base64") }); const original = service.message(imported.ids[0]);
  await assert.rejects(service.messageAction(original.id, { operation: "archive" }), { code: "FOLDER_MAPPING_REQUIRED" }); assert.deepEqual(service.message(original.id), original);
});

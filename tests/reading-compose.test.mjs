import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayName, personLabel, addressPeople, splitQuotedText, quotedTextSections, isQuoteBoundary, pendingDrafts } from "../src/message-format.mjs";
import { scheduledInstant } from "../src/send-options.mjs";
import { validateAddresses } from "../src/util.mjs";
import { MailService } from "../src/service.mjs";
import { normalizeAccount, composeDraft } from "../src/mail.mjs";
import { simpleParser } from "mailparser";
const human = { kind: "human" };
async function fixture(t, send) {
  let time = Date.parse("2026-11-05T08:00:00Z"), calls = 0;
  const directory = await mkdtemp(join(tmpdir(), "dsh-reading-"));
  const service = new MailService({ directory, clock: () => time, transport: { close: async () => {}, send: async (...args) => { calls++; return send ? send(...args) : { accepted: ["client@example.invalid"] }; }, findSent: async () => { throw new Error("synthetic sent-copy failure"); } } });
  t.after(() => service.close());
  service.store.put("accounts", { ...normalizeAccount({ id: "me", email: "me@example.invalid", imapHost: "127.0.0.1", smtpHost: "127.0.0.1" }), authFailed: true, folders: {} });
  return { service, advance: (ms) => time += ms, calls: () => calls };
}
test("empty quoted names fall back to addresses; quoted commas keep one recipient", () => {
  for (const name of ["", '""', '" "', '“”', "''"]) { assert.equal(displayName(name), ""); assert.equal(personLabel({ name, address: "a@example.com" }), "a@example.com"); }
  const value = '"Doe, Jane" <jane@example.com>; "" <empty@example.com>；中文 <cn@example.com>';
  assert.deepEqual(validateAddresses(value), addressPeople(value));
  assert.equal(addressPeople(value).length, 3); assert.equal(addressPeople(value)[0].name, "Doe, Jane");
  assert.equal(displayName('"张三"'), "张三");
});
test("quote segmentation preserves every character and leaves normal prose alone", () => {
  for (const marker of ["> old reply\n>> older", "On Tue, client wrote:\nold", "在昨天客户写道：\n旧文", "-----Original Message-----\nold", "—— 2026-11-05 client@example.com ——\nold"]) {
    const value = `current\n\n${marker}`, parts = splitQuotedText(value); assert.equal(parts.current + parts.quoted, value); assert.equal(parts.current, "current\n\n");
  }
  assert.equal(splitQuotedText("We wrote: on the board\n价格 > 3").quoted, "");
});
test("flat timestamp/email reply separators split every quoted mail without deleting text", () => {
  const first = "—— 2026-11-04T08:21:44.000Z previous@example.invalid ——", second = "—\u00a02026-11-03T12:00:00+09:00\u00a0older@example.invalid\u00a0—";
  assert.ok(isQuoteBoundary(first)); assert.ok(isQuoteBoundary(second));
  const text = `今回の返信\r\n\r\n${first}\r\n前回のメール\r\n\r\n${second}\r\n以前のメール`;
  const sections = quotedTextSections(text); assert.equal(sections.filter((s) => s.quoted).length, 2); assert.equal(sections.map((s) => s.text).join(""), text);
  assert.equal(splitQuotedText(text).current, "今回の返信\r\n\r\n");
  for (const line of ["2026-11-04 previous@example.invalid", "—— 著者 ——", "—— 2026-11-04 ——", "contact previous@example.invalid on 2026-11-04"]) assert.equal(isQuoteBoundary(line), false);
});
test("send time conversion handles zones and rejects DST gaps, repeated hours and invalid dates", () => {
  assert.equal(scheduledInstant("2026-11-06T09:00", "Asia/Shanghai"), "2026-11-06T01:00:00.000Z");
  for (const [local, zone] of [["2026-03-08T02:30", "America/New_York"], ["2026-11-01T01:30", "America/New_York"], ["bad", "UTC"], ["2026-11-06T09:00", "Bad/Zone"]]) assert.throws(() => scheduledInstant(local, zone));
});
test("reply preserves HTML and text history in sent MIME; drafting AI receives only new text", async (t) => {
  const { service } = await fixture(t);
  service.store.put("folders", { id: "inbox", accountId: "me", path: "INBOX" });
  const message = service.store.upsertMessage({ accountId: "me", folderId: "inbox", uid: 1, uidValidity: "1", messageId: "<original@example.invalid>", from: [{ address: "client@example.invalid" }], to: [], cc: [], subject: "topic", text: "Original\n> Older", html: "<p>Original</p><blockquote>Older</blockquote>", attachments: [], bodyLoaded: true, date: "2026-11-05T07:00:00Z" });
  let draft = await service.replyDraft({ id: message.id });
  assert.match(draft.html, /data-mail-quote/); assert.match(draft.html, /Older/);
  draft = service.saveDraft({ ...draft, text: `New answer\n> literal new code\n\n${draft.quotedText}` });
  service.ai = async ({ source }) => { assert.equal(source.text.trim(), "New answer\n> literal new code"); return { text: "Polished" }; };
  await service.invoke({ action: "ai.generate", task: "polish", draftId: draft.id, revision: draft.revision }, human);
  const mime = await composeDraft(draft, service.account("me"), () => {}), parsed = await simpleParser(mime.raw);
  assert.match(parsed.text, /New answer/); assert.match(parsed.text, /Older/); assert.match(parsed.html, /Original/);
});
test("schedule persists, stale confirmations reject and cancellation during MIME preparation prevents SMTP", async (t) => {
  const { service, advance, calls } = await fixture(t);
  const scheduledAt = "2026-11-05T08:01:00Z";
  const draft = service.saveDraft({ accountId: "me", to: "client@example.invalid", text: "synthetic", scheduledAt, sendTimeZone: "Asia/Shanghai" });
  assert.equal(service.store.get("drafts", draft.id).scheduledAt, scheduledAt);
  const stale = service.preview("send", { draftId: draft.id, scheduledAt }, human); advance(55000);
  await assert.rejects(service.confirm(stale.id, human), { code: "INVALID_SEND_TIME" });
  const preview = service.preview("send", { draftId: draft.id, scheduledAt: null }, human); const queued = await service.confirm(preview.id, human);
  advance(10000); const delivery = service.deliver(queued); await service.invoke({ action: "drafts.cancel", id: draft.id }, human); await delivery;
  assert.equal(calls(), 0); assert.equal(service.store.get("drafts", draft.id).status, "draft");
});
for (const scheduled of [false, true]) test(`${scheduled ? "scheduled" : "immediate"} accepted mail leaves drafts even if sent copy fails; failed and uncertain stay`, async (t) => {
  const { service, advance, calls } = await fixture(t);
  const draft = service.saveDraft({ accountId: "me", to: "client@example.invalid", text: "synthetic" });
  const preview = service.preview("send", { draftId: draft.id, scheduledAt: scheduled ? "2026-11-05T08:01:00Z" : null }, human);
  await service.confirm(preview.id, human); assert.equal(pendingDrafts(service.state(human).drafts).length, 1);
  advance(scheduled ? 60000 : 10000); await service.tick(); assert.equal(calls(), 1);
  assert.equal(service.store.get("drafts", draft.id).status, "sent"); assert.equal(pendingDrafts(service.store.list("drafts")).length, 0);
  await service.tick(); assert.equal(calls(), 1);
});
for (const scheduled of [false, true]) for (const [code, status] of [["EAUTH", "failed"], ["ECONNRESET", "uncertain"]]) test(`${scheduled ? "scheduled" : "immediate"} ${status} sends retain the draft and never retry`, async (t) => {
  const { service, advance, calls } = await fixture(t, async () => { throw Object.assign(new Error("synthetic"), { code }); });
  const draft = service.saveDraft({ accountId: "me", to: "client@example.invalid", text: "synthetic" });
  const preview = service.preview("send", { draftId: draft.id, scheduledAt: scheduled ? "2026-11-05T08:01:00Z" : null }, human); await service.confirm(preview.id, human); advance(scheduled ? 60000 : 10000); await service.tick(); await service.tick();
  assert.equal(calls(), 1); assert.equal(service.store.get("drafts", draft.id).status, status); assert.equal(pendingDrafts(service.store.list("drafts")).length, 1);
});
test("MIME failure after cancel cannot overwrite the user's updated draft", async (t) => {
  const { service, calls } = await fixture(t);
  const attachment = await service.upload({ filename: "synthetic.txt", contentType: "text/plain", base64: Buffer.from("fixture").toString("base64") });
  const draft = service.saveDraft({ accountId: "me", to: "client@example.invalid", text: "old", attachments: [attachment] });
  const queued = await service.confirm(service.preview("send", { draftId: draft.id, scheduledAt: null }, human).id, human);
  let reject; service.ensureAttachment = () => new Promise((_resolve, fail) => reject = fail);
  const delivery = service.deliver(queued); const cancelled = await service.invoke({ action: "drafts.cancel", id: draft.id }, human); service.saveDraft({ ...cancelled, text: "new user input" }); reject(new Error("synthetic read failure")); await delivery;
  assert.equal(service.store.get("drafts", draft.id).text, "new user input"); assert.equal(service.store.get("drafts", draft.id).status, "draft"); assert.equal(calls(), 0);
});
test("sender config changes during MIME compilation require a fresh preview", async (t) => {
  const { service, calls } = await fixture(t);
  const attachment = await service.upload({ filename: "synthetic.txt", contentType: "text/plain", base64: Buffer.from("fixture").toString("base64") });
  const draft = service.saveDraft({ accountId: "me", to: "client@example.invalid", text: "old", attachments: [attachment] });
  const queued = await service.confirm(service.preview("send", { draftId: draft.id, scheduledAt: null }, human).id, human);
  let done; const stored = service.store.get("attachments", attachment.id); service.ensureAttachment = () => new Promise((resolve) => done = () => resolve(stored));
  const delivery = service.deliver(queued); service.store.put("accounts", { ...service.account("me"), email: "changed@example.invalid" }); done(); await delivery;
  assert.equal(service.store.get("drafts", draft.id).status, "needs-confirmation"); assert.equal(calls(), 0);
});
test("all recipients rejected keeps the draft with a definite failure", async (t) => {
  const { service, advance } = await fixture(t, async () => ({ accepted: [], rejected: ["client@example.invalid"] }));
  const draft = service.saveDraft({ accountId: "me", to: "client@example.invalid", text: "synthetic" });
  await service.confirm(service.preview("send", { draftId: draft.id, scheduledAt: null }, human).id, human); advance(10000); await service.tick();
  assert.equal(service.store.get("drafts", draft.id).status, "failed"); assert.equal(pendingDrafts(service.store.list("drafts")).length, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailTransport, parseMessage } from "../src/mail.mjs";

test("IMAP metadata keeps inline images but excludes Content-ID body and multipart nodes", async () => {
  const tree = { type: "multipart/related", id: "<container>", childNodes: [
    { part: "1", type: "text/html", id: "<body>" },
    { part: "2", type: "image/png", id: "<logo>", disposition: "inline", size: 20 },
    { part: "3", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "brief.pdf" }, size: 50 },
  ] };
  const client = { mailbox: { uidValidity: 1n }, enabled: new Set(), capabilities: new Map(), getMailboxLock: async () => ({ release() {} }), search: async () => [1], async *fetch() { yield { uid: 1, flags: new Set(), envelope: {}, bodyStructure: tree }; } };
  const transport = new MailTransport({ getPassword: async () => "unused" });
  transport.serial = async (account, action) => action(client);
  let message;
  await transport.scan({ id: "account" }, { id: "inbox", path: "INBOX" }, [], async (batch) => { [message] = batch; });
  assert.deepEqual(message.attachments.map((a) => a.part), ["2", "3"]);
  assert.equal(message.attachments[0].cid, "logo");
});

test("an attached EML is one attachment, without exposing its nested MIME children", async () => {
  const tree = { type: "multipart/mixed", childNodes: [{ type: "text/plain", part: "1" }, { type: "message/rfc822", part: "2", disposition: "attachment", dispositionParameters: { filename: "original.eml" }, childNodes: [{ type: "image/png", part: "2.1", disposition: "attachment", parameters: { name: "inside.png" } }] }] };
  const client = { mailbox: { uidValidity: 1n }, enabled: new Set(), capabilities: new Map(), getMailboxLock: async () => ({ release() {} }), search: async () => [1], async *fetch() { yield { uid: 1, flags: new Set(), envelope: {}, bodyStructure: tree }; } };
  const transport = new MailTransport({ getPassword: async () => "unused" }); transport.serial = async (account, action) => action(client);
  let message; await transport.scan({ id: "account" }, { id: "inbox" }, [], async (batch) => { [message] = batch; });
  assert.deepEqual(message.attachments.map((a) => a.filename), ["original.eml"]);
});

test("inline-only and mixed raw MIME preserve CID rendering and expose only real downloads", async () => {
  const { downloadableAttachments } = await import("../src/attachments.mjs");
  const directory = await mkdtemp(join(tmpdir(), "dsh-mail-mime-"));
  const raw = (extra = "") => Buffer.from(`From: sender@example.invalid\r\nTo: reader@example.invalid\r\nSubject: Inline fixture\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="fixture"\r\n\r\n--fixture\r\nContent-Type: text/html; charset=utf-8\r\nContent-ID: <body>\r\n\r\n<p>Share invitation</p><img src="cid:logo">\r\n--fixture\r\nContent-Type: image/png\r\nContent-ID: <logo>\r\nContent-Disposition: inline; filename="logo.png"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n${extra}--fixture--\r\n`);
  const inline = await parseMessage(raw(), directory);
  assert.equal(inline.attachments.length, 1); assert.equal(inline.attachments[0].cid, "logo");
  assert.deepEqual(downloadableAttachments(inline), []);
  const mixed = await parseMessage(raw('--fixture\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="brief.pdf"\r\n\r\npdf fixture\r\n'), directory);
  assert.deepEqual(downloadableAttachments(mixed).map((a) => a.filename), ["brief.pdf"]);
});

test("legacy BODYSTRUCTURE records hide phantom parts while explicit image attachments remain downloadable", async () => {
  const { downloadableAttachments } = await import("../src/attachments.mjs");
  const message = { bodyStructure: { type: "multipart/related", childNodes: [{ part: "1", type: "text/html", id: "<body>" }, { part: "2", type: "image/png", id: "<logo>" }, { part: "3", type: "image/jpeg", id: "<photo>", disposition: "attachment", dispositionParameters: { filename: "photo.jpg" } }] }, attachments: [
    { id: "body", part: "1", contentType: "text/html", cid: "body", filename: "attachment", disposition: "attachment" },
    { id: "logo", part: "2", contentType: "image/png", cid: "logo", filename: "attachment", disposition: "attachment" },
    { id: "photo", part: "3", contentType: "image/jpeg", cid: "photo", filename: "photo.jpg", disposition: "attachment" },
  ] };
  assert.deepEqual(downloadableAttachments(message).map((a) => a.id), ["photo"]);
  assert.deepEqual(downloadableAttachments({ attachments: [{ id: "text", filename: "notes.txt", contentType: "text/plain", disposition: "attachment" }, { id: "image", filename: "photo.jpg", contentType: "image/jpeg" }] }).map((a) => a.id), ["text", "image"]);
});

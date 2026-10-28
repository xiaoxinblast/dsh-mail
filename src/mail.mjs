import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { addresses, cleanFilename, digest, headerSafe, id, now, requireValue, validateAddresses } from "./util.mjs";
import packageInfo from "../package.json" with { type: "json" };

export const PROVIDERS = {
  "163.com": { imapHost: "imap.163.com", smtpHost: "smtp.163.com" },
  "126.com": { imapHost: "imap.126.com", smtpHost: "smtp.126.com" },
  "yeah.net": { imapHost: "imap.yeah.net", smtpHost: "smtp.yeah.net" },
  "qq.com": { imapHost: "imap.qq.com", smtpHost: "smtp.qq.com" }
};
export function normalizeAccount(input) {
  const email = validateAddresses(input.email, true)[0].address;
  const preset = PROVIDERS[email.split("@")[1]] || {};
  const result = { id: input.id || id(), name: String(input.name || email), email, username: String(input.username || email), imapHost: input.imapHost || preset.imapHost, imapPort: Number(input.imapPort || 993), imapSecure: input.imapSecure !== false, smtpHost: input.smtpHost || preset.smtpHost, smtpPort: Number(input.smtpPort || 465), smtpSecure: input.smtpSecure !== false, enabled: input.enabled !== false, folders: input.folders || {}, signatureId: input.signatureId || null };
  for (const host of [result.imapHost, result.smtpHost]) requireValue(typeof host === "string" && /^[a-z0-9.:-]+$/i.test(host), "SERVER_REQUIRED", "请填写有效的 IMAP 和 SMTP 服务器地址。");
  for (const port of [result.imapPort, result.smtpPort]) requireValue(Number.isInteger(port) && port > 0 && port <= 65535, "INVALID_PORT", "端口必须为 1–65535。");
  return result;
}
export class MailTransport {
  constructor({ getPassword, onChange = () => {} }) { this.getPassword = getPassword; this.onChange = onChange; this.clients = new Map(); this.queues = new Map(); this.closed = false; }
  async serial(account, action) {
    const previous = this.queues.get(account.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => { requireValue(!this.closed, "STOPPED", "邮箱服务已停止。"); return action(await this.client(account)); });
    this.queues.set(account.id, next); return next;
  }
  async client(account) {
    let client = this.clients.get(account.id);
    if (client?.usable) return client;
    const password = await this.getPassword(account.id);
    client = new ImapFlow({ host: account.imapHost, port: account.imapPort, secure: account.imapSecure, ...(account.imapSecure ? {} : { doSTARTTLS: true }), auth: { user: account.username, pass: password }, logger: false, connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 120000, maxIdleTime: 60000, clientInfo: { name: "DSH Mail", version: packageInfo.version, vendor: "xiaoxinblast", "support-url": "https://github.com/xiaoxinblast/dsh-mail" } });
    client.on("error", () => {});
    client.on("close", () => { if (this.clients.get(account.id) === client) this.clients.delete(account.id); });
    client.on("exists", () => this.onChange(account.id));
    this.clients.set(account.id, client);
    try { await client.connect(); return client; } catch (error) { client.close(); throw error; }
  }
  async reset(accountId) { const c = this.clients.get(accountId); this.clients.delete(accountId); c?.close(); await this.queues.get(accountId)?.catch(() => {}); }
  smtp(account, password) { return nodemailer.createTransport({ host: account.smtpHost, port: account.smtpPort, secure: account.smtpSecure, requireTLS: !account.smtpSecure, auth: { user: account.username, pass: password }, logger: false, connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000, disableFileAccess: true, disableUrlAccess: true }); }
  async test(account) {
    const imap = await this.serial(account, async (c) => ({ capabilities: [...c.capabilities.keys()], folders: (await c.list()).map((f) => ({ path: f.path, delimiter: f.delimiter, role: f.specialUse || null })) }));
    const smtp = this.smtp(account, await this.getPassword(account.id));
    try { await smtp.verify(); return { imap, smtp: true }; } finally { smtp.close(); }
  }
  async folders(account) { return this.serial(account, async (c) => (await c.list()).map((f) => ({ path: f.path, name: f.name, delimiter: f.delimiter, role: f.specialUse || null, selectable: !f.flags.has("\\Noselect"), subscribed: f.subscribed }))); }
  async scan(account, folder, known, onBatch, signal) {
    return this.serial(account, async (c) => {
      const lock = await c.getMailboxLock(folder.path);
      try {
        const validity = String(c.mailbox.uidValidity), remoteUids = await c.search({ all: true }, { uid: true });
        const uids = remoteUids || [], old = new Map(known.filter((m) => m.uidValidity === validity).map((m) => [m.uid, m]));
        const fresh = uids.filter((uid) => !old.has(uid));
        const changedSince = folder.uidValidity === validity && folder.highestModseq && c.enabled.has("CONDSTORE") ? BigInt(folder.highestModseq) : undefined;
        const metadata = new Set(fresh);
        const groups = [{ uids: fresh, full: true }, { uids: uids.filter((uid) => old.has(uid)), full: false }];
        for (const group of groups) for (let end = group.uids.length; end > 0; end -= 200) {
          signal?.throwIfAborted();
          const page = group.uids.slice(Math.max(0, end - 200), end), batch = [];
          for await (const m of c.fetch(page, { uid: true, flags: true, modseq: true, ...(group.full ? { envelope: true, internalDate: true, size: true, bodyStructure: true } : {}) }, { uid: true, ...(!group.full && changedSince ? { changedSince } : {}) })) {
            const e = m.envelope || {}, previous = old.get(m.uid);
            if (!metadata.has(m.uid) && previous) { batch.push({ ...previous, flags: [...m.flags], modseq: m.modseq ? String(m.modseq) : previous.modseq }); continue; }
            batch.push({ ...previous, accountId: account.id, folderId: folder.id, uid: m.uid, uidValidity: validity, messageId: e.messageId, inReplyTo: e.inReplyTo, subject: e.subject || "", from: addresses(e.from), to: addresses(e.to), cc: addresses(e.cc), date: new Date(e.date || m.internalDate || Date.now()).toISOString(), flags: [...m.flags], size: m.size, modseq: m.modseq ? String(m.modseq) : null, bodyStructure: m.bodyStructure, attachments: previous?.attachments || structureAttachments(m.bodyStructure).map((a) => ({ ...a, id: digest(`${account.id}/${folder.id}/${validity}/${m.uid}/${a.part}`) })), bodyLoaded: !!previous?.bodyLoaded });
          }
          await onBatch(batch);
        }
        return { uidValidity: validity, uids, highestModseq: c.mailbox.highestModseq ? String(c.mailbox.highestModseq) : null, capabilities: [...c.capabilities.keys()] };
      } finally { lock.release(); }
    });
  }
  async withMessage(account, folder, message, action) {
    return this.serial(account, async (c) => { const lock = await c.getMailboxLock(folder.path); try { requireValue(String(c.mailbox.uidValidity) === String(message.uidValidity), "UIDVALIDITY_CHANGED", "文件夹已重建，请同步后重试。"); return await action(c); } finally { lock.release(); } });
  }
  async raw(account, folder, message) {
    requireValue(message.size <= 50 * 1024 * 1024, "MESSAGE_TOO_LARGE", "此邮件超过 50 MiB，请单独下载附件或使用网页邮箱查看。");
    return this.withMessage(account, folder, message, async (c) => { const m = await c.fetchOne(message.uid, { source: true }, { uid: true }); requireValue(m?.source, "MESSAGE_GONE", "邮件已被其他客户端移动或删除。"); return m.source; });
  }
  async body(account, folder, message) {
    return this.withMessage(account, folder, message, async (client) => {
      const header = await client.fetchOne(message.uid, { headers: true }, { uid: true });
      requireValue(header?.headers, "MESSAGE_GONE", "邮件已被移动或删除。");
      const parts = [], visit = (node) => { if (!node || node.disposition === "attachment" || node.type === "message/rfc822") return; if (["text/plain", "text/html"].includes(node.type)) parts.push(node); else for (const child of node.childNodes || []) visit(child); }; visit(message.bodyStructure);
      let text = "", html = "", truncated = false;
      for (const part of parts) {
        const download = await client.download(message.uid, part.part || "1", { uid: true, maxBytes: 2 * 1024 * 1024 });
        requireValue(download.content, "BODY_UNAVAILABLE", "正文部分暂时无法读取。");
        const chunks = []; for await (const chunk of download.content) chunks.push(chunk); const bytes = Buffer.concat(chunks);
        truncated ||= bytes.length >= 2 * 1024 * 1024;
        if (part.type === "text/html") html += bytes.toString("utf8"); else text += bytes.toString("utf8");
      }
      const parsed = await simpleParser(Buffer.concat([header.headers, Buffer.from("\r\n\r\n")]), { skipHtmlToText: true });
      if (!text && html) text = (await simpleParser(Buffer.from(`Content-Type: text/html; charset=utf-8\r\n\r\n${html}`))).text || "";
      return { text, html, rawHeaders: parsed.headerLines.map((x) => x.line).join("\r\n"), references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [], replyTo: addresses(parsed.replyTo), bodyLoaded: true, bodyTruncated: truncated };
    });
  }
  async attachment(account, folder, message, part) {
    return this.withMessage(account, folder, message, async (client) => { const download = await client.download(message.uid, part, { uid: true, maxBytes: 50 * 1024 * 1024 + 1 }); requireValue(download.content, "ATTACHMENT_GONE", "附件已不存在。"); const chunks = []; let size = 0; for await (const chunk of download.content) { size += chunk.length; requireValue(size <= 50 * 1024 * 1024, "ATTACHMENT_SIZE", "附件超过 50 MiB 下载限制。"); chunks.push(chunk); } return Buffer.concat(chunks); });
  }
  async idleInbox(account, folder) { return this.serial(account, async (c) => { const lock = await c.getMailboxLock(folder.path); lock.release(); }); }
  async flags(account, folder, message, add, remove) { return this.withMessage(account, folder, message, async (c) => { if (add.length) requireValue(await c.messageFlagsAdd(message.uid, add, { uid: true }), "FLAGS_FAILED", "服务器未确认标记变更。"); if (remove.length) requireValue(await c.messageFlagsRemove(message.uid, remove, { uid: true }), "FLAGS_FAILED", "服务器未确认标记变更。"); }); }
  async copy(account, folder, message, destination) { return this.withMessage(account, folder, message, (c) => c.messageCopy(message.uid, destination.path, { uid: true })); }
  async move(account, folder, message, destination) {
    return this.withMessage(account, folder, message, (c) => { requireValue(c.capabilities.has("MOVE") || c.capabilities.has("UIDPLUS") || c.capabilities.has("IMAP4rev2"), "UNSAFE_EXPUNGE", "服务器不支持安全的单封移动；可以复制后在网页邮箱处理原件。"); return c.messageMove(message.uid, destination.path, { uid: true }); });
  }
  async purge(account, folder, message) { return this.withMessage(account, folder, message, (c) => { requireValue(c.capabilities.has("UIDPLUS") || c.capabilities.has("IMAP4rev2"), "UNSAFE_EXPUNGE", "服务器不支持安全的单封永久删除。"); return c.messageDelete(message.uid, { uid: true }); }); }
  async folderAction(account, action, path, destination) { return this.serial(account, (c) => action === "create" ? c.mailboxCreate(path) : action === "delete" ? c.mailboxDelete(path) : c.mailboxRename(path, destination)); }
  async append(account, folder, raw, flags = [], date) { return this.serial(account, (c) => c.append(folder.path, raw, flags.filter((x) => x !== "\\Recent" && x !== "\\Deleted"), date)); }
  async findSent(account, folder, messageId) { return this.serial(account, async (c) => { const lock = await c.getMailboxLock(folder.path); try { return await c.search({ header: { "message-id": messageId } }, { uid: true }); } finally { lock.release(); } }); }
  async send(account, raw, envelope) {
    const smtp = this.smtp(account, await this.getPassword(account.id));
    try { return await smtp.sendMail({ envelope, raw, disableFileAccess: true, disableUrlAccess: true }); }
    finally { smtp.close(); }
  }
  async close() { this.closed = true; for (const client of this.clients.values()) client.close(); await Promise.allSettled([...this.queues.values()]); this.clients.clear(); }
}
function structureAttachments(node, result = []) {
  if (!node) return result;
  if (node.disposition === "attachment" || node.dispositionParameters?.filename || node.parameters?.name || node.id || ["text/calendar", "message/disposition-notification", "message/delivery-status"].includes(node.type)) result.push({ part: node.part || "1", filename: cleanFilename(node.dispositionParameters?.filename || node.parameters?.name || (node.type === "text/calendar" ? "invitation.ics" : "attachment")), contentType: node.type, size: node.size || 0, cid: node.id?.replace(/^<|>$/g, "") || null, disposition: node.disposition || "attachment" });
  for (const child of node.childNodes || []) structureAttachments(child, result);
  return result;
}
export async function parseMessage(raw, directory) {
  const parsed = await simpleParser(raw, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true });
  await mkdir(directory, { recursive: true });
  const attachments = [];
  for (const a of parsed.attachments) {
    const key = digest(`${digest(raw)}:${attachments.length}`), path = join(directory, digest(a.content));
    await writeFile(path, a.content);
    attachments.push({ id: key, filename: cleanFilename(a.filename || "attachment"), contentType: a.contentType, size: a.size, cid: a.cid || null, disposition: a.contentDisposition, path });
  }
  return { subject: parsed.subject || "（无主题）", text: parsed.text || "", html: parsed.html || "", from: addresses(parsed.from), to: addresses(parsed.to), cc: addresses(parsed.cc), replyTo: addresses(parsed.replyTo), messageId: parsed.messageId || null, inReplyTo: parsed.inReplyTo || null, references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [], date: parsed.date?.toISOString(), attachments, rawHeaders: parsed.headerLines.map((x) => x.line).join("\r\n"), bodyLoaded: true };
}
export async function composeDraft(draft, account, loadAttachment) {
  const to = validateAddresses(draft.to, true), cc = validateAddresses(draft.cc), bcc = validateAddresses(draft.bcc);
  const attachments = [];
  for (const item of draft.attachments || []) { const a = await loadAttachment(item.id); attachments.push({ filename: cleanFilename(item.filename || a.filename), content: await readFile(a.path), contentType: a.contentType, ...(item.cid ? { cid: headerSafe(item.cid) } : {}) }); }
  const messageId = draft.messageId || `<${id()}@${account.email.split("@")[1]}>`;
  const cids = new Set((draft.attachments || []).map((a) => a.cid).filter(Boolean));
  const html = (draft.html || "").replace(/<img\b[^>]*>/gi, (tag) => { const cid = tag.match(/\balt="cid:([^"<>]+)"/i)?.[1]; return cid && cids.has(cid) ? tag.replace(/\bsrc="[^"]*"/i, `src="cid:${cid}"`) : tag; });
  const raw = await new MailComposer({ from: { name: headerSafe(account.name), address: account.email }, to, cc, bcc, subject: headerSafe(draft.subject), text: draft.text || "", html: html || undefined, messageId, date: new Date(), inReplyTo: headerSafe(draft.inReplyTo) || undefined, references: draft.references?.map(headerSafe) || undefined, headers: draft.requestReceipt ? { "Disposition-Notification-To": account.email } : {}, attachments, ...(draft.ical ? { icalEvent: { method: draft.icalMethod || "REQUEST", content: draft.ical } } : {}), disableFileAccess: true, disableUrlAccess: true }).compile().build();
  return { raw, messageId, envelope: { from: account.email, to: [...to, ...cc, ...bcc].map((x) => x.address) } };
}

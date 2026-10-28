import { mkdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { parse as parseCsv } from "csv-parse/sync";
import { stringify as stringifyCsv } from "csv-stringify/sync";
import ICAL from "ical.js";
import { Store } from "./store.mjs";
import { WindowsVault } from "./vault.mjs";
import { MailTransport, normalizeAccount, parseMessage, composeDraft } from "./mail.mjs";
import { normalizeEvent, exportEvents, importEvents, occurrences, applyInvitation } from "./calendar.mjs";
import { validateRule, matches } from "./rules.mjs";
import { id, now, digest, errorInfo, requireValue, cleanFilename, inside, bounded, validateAddresses } from "./util.mjs";

const SAFE_RESOURCES = new Set(["tasks", "contacts", "calendars", "signatures", "templates", "saved-searches", "labels"]);
const HUMAN_ONLY = new Set(["accounts.save", "accounts.remove", "preview.confirm", "rules.enable", "backup.restore", "attachments.upload", "files.save", "settings.save"]);
const PRIVATE_FIELDS = new Set(["ciphertext", "password", "secret", "rawPath"]);
function publicValue(value) { return JSON.parse(JSON.stringify(value, function (key, item) { return PRIVATE_FIELDS.has(key) || (key === "path" && (this.contentType || this.rawPath)) ? undefined : item; })); }
function draftView(draft) { return publicValue(draft); }
function sendIdentity(account) { const { id, email, name, username, smtpHost, smtpPort, smtpSecure, enabled } = account; return { id, email, name, username, smtpHost, smtpPort, smtpSecure, enabled }; }

export class MailService {
  constructor({ directory, vault = new WindowsVault(), transport, clock = () => Date.now(), notify = () => {} }) {
    this.store = new Store(directory); this.directory = directory; this.vault = vault; this.clock = clock; this.notify = notify;
    this.abort = new AbortController(); this.syncing = new Map(); this.work = new Map(); this.sending = false; this.stopped = false;
    this.transport = transport || new MailTransport({ getPassword: (key) => this.password(key), onChange: (key) => { const a = this.store.get("accounts", key); if (a?.enabled) this.scheduleSync(a); } });
    if (!this.store.get("calendars", "default")) this.store.put("calendars", { id: "default", name: "我的日历", color: "#155e75" });
    this.recover();
  }
  recover() {
    for (const j of this.store.list("jobs")) if (j.status === "running" || j.status === "queued") this.store.put("jobs", { ...j, items: j.items.map((item) => ({ ...item, status: item.status === "running" ? "interrupted" : item.status, copies: item.copies?.map((copy) => ({ ...copy, status: copy.status === "running" ? "unknown" : copy.status })) })), status: "interrupted", error: { code: "HOST_RESTARTED", message: "DSH 已重启。未开始的复制可继续；结果未知的项目保留供核查。" } });
    for (const d of this.store.list("drafts")) {
      if (d.status === "sending") this.store.put("drafts", { ...d, status: "uncertain", error: "上次发送时 DSH 退出，结果未知；核查已发送文件夹后再决定。" });
      else if (d.status === "queued" && Date.parse(d.sendAt) <= this.clock()) this.store.put("drafts", { ...d, status: "needs-confirmation", error: "错过发送时间，请重新预览并确认。" });
    }
  }
  start() { const run = () => { if (this.ticking || this.stopped) return; this.ticking = this.tick().catch((e) => this.store.log("background-error", errorInfo(e))).finally(() => { this.ticking = null; }); }; run(); this.timer = setInterval(run, 1000); this.timer.unref?.(); }
  async password(accountId) { const value = this.store.get("credentials", accountId); requireValue(value?.ciphertext, "CREDENTIAL_REQUIRED", "请在设置中重新输入账号授权码。"); return this.vault.open(value.ciphertext); }
  account(key) { const a = this.store.get("accounts", key); requireValue(a, "ACCOUNT_NOT_FOUND", "账号不存在。"); return a; }
  folder(key) { const f = this.store.get("folders", key); requireValue(f, "FOLDER_NOT_FOUND", "文件夹不存在，请同步后重试。"); return f; }
  message(key) { const m = this.store.message(key); requireValue(m, "MESSAGE_NOT_FOUND", "邮件不存在或已被移动，请刷新。"); return m; }
  assertHuman(context) { requireValue(context.kind === "human", "USER_ACTION_REQUIRED", "此操作需要在 DSH Mail 界面中由用户完成。"); }
  async invoke(operation, context = { kind: "agent" }) {
    requireValue(operation && typeof operation.action === "string", "ACTION_REQUIRED", "缺少 action。");
    requireValue(!this.stopped, "STOPPED", "邮箱服务已停止。");
    const { action, ...args } = operation;
    if (HUMAN_ONLY.has(action)) this.assertHuman(context);
    // Credential entry never exists on the agent tool surface, even in arbitrary nested JSON.
    if (context.kind !== "human") requireValue(!/"(?:password|ciphertext|secret)"\s*:/.test(JSON.stringify(args)), "SECRET_INPUT_FORBIDDEN", "请通过设置界面输入凭据。");
    if (action === "state") return this.state();
    if (action === "accounts.save") return this.saveAccount(args);
    if (action === "accounts.test") {
      if (args.accountId) return this.transport.test(this.account(args.accountId));
      this.assertHuman(context); const account = normalizeAccount(args.account); const temporary = new MailTransport({ getPassword: async () => args.password });
      try { return await temporary.test(account); } finally { await temporary.close(); }
    }
    if (action === "accounts.remove") { const account = this.account(args.id); await this.transport.reset(account.id); this.store.remove("credentials", account.id); return publicValue(this.store.put("accounts", { ...account, enabled: false, disconnected: true })); }
    if (action === "sync") { const accounts = args.accountId ? [this.account(args.accountId)] : this.store.list("accounts").filter((a) => a.enabled && !a.local); return accounts.map((a) => { this.scheduleSync(a, true); return { accountId: a.id, status: "queued" }; }); }
    if (action === "search") {
      if (args.inbox) args.folderIds = this.store.list("folders").filter((f) => f.role === "\\Inbox" || f.path.toUpperCase() === "INBOX").map((f) => f.id);
      if (args.inbox && !args.folderIds.length) return { items: [], total: 0, coverage: { total: 0, indexed: 0 } };
      return publicValue(this.store.search(args));
    }
    if (action === "message.read") { const m = await this.loadMessage(args.id); return publicValue(m); }
    if (action === "thread.read") { const m = this.message(args.id); return publicValue(this.store.search({ accountId: m.accountId, threadId: m.threadId, limit: args.limit || 50, includeSnoozed: true })); }
    if (action === "drafts.save") return this.saveDraft(args.draft);
    if (action === "drafts.reply") return this.replyDraft(args);
    if (action === "drafts.delete") { const d = this.store.get("drafts", args.id); requireValue(d && !["sending", "sent"].includes(d.status), "DRAFT_LOCKED", "发送中的邮件不能删除。"); return draftView(this.store.put("drafts", { ...d, status: "discarded" })); }
    if (action === "drafts.cancel") { const d = this.store.get("drafts", args.id); requireValue(d?.status === "queued", "CANNOT_UNSEND", "投递已经开始，不能撤回。"); return draftView(this.store.put("drafts", { ...d, status: "draft", sendAt: null })); }
    if (action === "send.preview") return this.preview("send", { draftId: args.id, scheduledAt: args.scheduledAt || null }, context);
    if (action === "preview.confirm") return this.confirm(args.id, context);
    if (action === "preview.reject") { this.assertHuman(context); const p = this.store.get("previews", args.id); requireValue(p, "PREVIEW_NOT_FOUND", "预览不存在。"); return this.store.put("previews", { ...p, status: "rejected" }); }
    if (action === "messages.action") {
      const ids = [...new Set(args.ids || [])]; requireValue(ids.length && ids.length <= 1000, "SELECTION_REQUIRED", "请选择 1–1000 封邮件。"); ids.forEach((key) => this.message(key));
      if (args.operation === "purge") return this.preview("purge", { ids }, context);
      return this.createJob("messages", ids, { ...args, ids: undefined });
    }
    if (action === "folders.action") return this.folderOperation(args, context);
    if (action === "rules.preview") { const rule = validateRule(args.rule); const matched = this.store.db.prepare("SELECT data FROM messages").all().map((r) => JSON.parse(r.data)).filter((m) => matches(rule, m)); return { count: matched.length, samples: publicValue(matched.slice(0, 10).map(({ id, subject, from, date }) => ({ id, subject, from, date }))) }; }
    if (action === "rules.save") { const rule = validateRule(args.rule), previous = rule.id ? this.store.get("rules", rule.id) : null; return this.store.put("rules", { ...rule, enabled: false, previouslyEnabled: previous?.enabled || false }, args.rule.revision); }
    if (action === "rules.enable") { const rule = this.store.get("rules", args.id); requireValue(rule, "RULE_NOT_FOUND", "规则不存在。"); return this.store.put("rules", { ...validateRule(rule), enabled: !!args.enabled, approvedAt: now() }); }
    if (action === "rules.apply") { const rule = this.store.get("rules", args.id); requireValue(rule, "RULE_NOT_FOUND", "规则不存在。"); return this.preview("rule-history", { ruleId: rule.id, ids: this.store.db.prepare("SELECT data FROM messages").all().map((r) => JSON.parse(r.data)).filter((m) => matches(rule, m)).map((m) => m.id) }, context); }
    if (action === "events.save") return this.saveEvent(args.event);
    if (action === "events.list") return publicValue(occurrences(this.store.list("events").filter((e) => !args.calendarId || e.calendarId === args.calendarId), args.start, args.end));
    if (action === "events.delete") { const e = this.store.get("events", args.id); requireValue(e, "EVENT_NOT_FOUND", "事件不存在。"); return this.store.put("events", { ...e, status: "CANCELLED" }); }
    if (action === "events.import") { const list = importEvents(args.ics, args.calendarId); return list.map((e) => applyInvitation(this.store, e, { sourceMessageId: args.sourceMessageId })); }
    if (action === "events.export") return this.download("calendar.ics", "text/calendar", Buffer.from(exportEvents(this.store.list("events").filter((e) => !args.ids || args.ids.includes(e.id)))));
    if (action === "events.invite" || action === "events.rsvp") return this.inviteDraft(action, args);
    if (action === "resources.save") { requireValue(SAFE_RESOURCES.has(args.kind), "RESOURCE_FORBIDDEN", "资源类型无效。"); return this.saveResource(args.kind, args.value); }
    if (action === "resources.delete") { requireValue(SAFE_RESOURCES.has(args.kind), "RESOURCE_FORBIDDEN", "资源类型无效。"); const old = this.store.get(args.kind, args.id); requireValue(old, "NOT_FOUND", "记录不存在。"); return this.store.put(args.kind, { ...old, deleted: true }); }
    if (action === "contacts.import") return this.importContacts(args);
    if (action === "contacts.export") return this.exportContacts(args.format);
    if (action === "attachments.upload") return this.upload(args);
    if (action === "attachments.read") return this.attachmentDownload(args);
    if (action === "attachments.export") { const zip = new JSZip(); let total = 0; for (const [index, key] of [...new Set(args.ids || [])].entries()) { const a = await this.ensureAttachment(key), bytes = await readFile(a.path); total += bytes.length; requireValue(total <= 200 * 1024 * 1024, "EXPORT_TOO_LARGE", "单次附件打包不超过 200 MiB，请分批保存。"); zip.file(`${index + 1}-${cleanFilename(a.filename)}`, bytes); } return this.download("attachments.zip", "application/zip", await zip.generateAsync({ type: "nodebuffer" })); }
    if (action === "mail.export") return this.exportMail(args);
    if (action === "mail.import") { this.assertHuman(context); return this.importMail(args); }
    if (action === "files.save") return this.saveFile(args);
    if (action === "backup.create") { this.assertHuman(context); return this.backup(); }
    if (action === "backup.restore") return this.restore(args);
    if (action === "jobs.cancel") { const j = this.store.get("jobs", args.id); requireValue(j, "JOB_NOT_FOUND", "任务不存在。"); this.store.put("jobs", { ...j, cancelRequested: true }); return { id: j.id, status: "cancel-requested" }; }
    if (action === "jobs.retry") return this.retryJob(args.id);
    if (action === "notifications.dismiss") { const n = this.store.get("notifications", args.id); if (n) this.store.put("notifications", { ...n, dismissed: true }); return { ok: true }; }
    if (action === "settings.save") return this.store.put("settings", { ...args.value, id: "general" });
    throw Object.assign(new Error(`不支持的操作：${action}`), { code: "UNKNOWN_ACTION" });
  }
  state() {
    const resource = (kind) => publicValue(this.store.list(kind).filter((x) => !x.deleted));
    return { version: "0.1.0", accounts: resource("accounts").map((a) => ({ ...a, credentialConfigured: !!this.store.get("credentials", a.id) })), folders: resource("folders"), drafts: resource("drafts").filter((d) => d.status !== "discarded"), rules: resource("rules"), events: resource("events"), previews: resource("previews").filter((p) => p.status === "pending"), jobs: resource("jobs").slice(0, 50), notifications: resource("notifications").filter((n) => !n.dismissed).slice(0, 30), logs: this.store.logs(100), settings: this.store.get("settings", "general") || {}, ...Object.fromEntries([...SAFE_RESOURCES].map((kind) => [kind, resource(kind)])) };
  }
  async saveAccount({ account: input, password }) {
    const previous = input.id ? this.store.get("accounts", input.id) : null, account = normalizeAccount({ ...previous, ...input });
    if (password) this.store.put("credentials", { id: account.id, ciphertext: await this.vault.seal(password) });
    requireValue(this.store.get("credentials", account.id), "CREDENTIAL_REQUIRED", "请输入客户端授权码。");
    await this.transport.reset(account.id);
    const saved = this.store.put("accounts", { ...previous, ...account, disconnected: false, authFailed: false, error: null, nextSyncAt: 0 });
    this.scheduleSync(saved, true); return publicValue(saved);
  }
  scheduleSync(account, force = false) {
    if (this.stopped || this.syncing.has(account.id) || account.local || !account.enabled || (!force && account.authFailed)) return;
    const promise = this.syncAccount(account).catch((error) => {
      const info = errorInfo(error), a = this.account(account.id), attempt = (a.failures || 0) + 1;
      this.store.put("accounts", { ...a, status: "error", error: info, failures: attempt, authFailed: info.code === "AUTHENTICATION_FAILED", nextSyncAt: this.clock() + Math.min(1800000, 10000 * 2 ** Math.min(attempt, 7)) * (0.8 + Math.random() * 0.4) });
      this.store.log("sync-error", { accountId: account.id, ...info });
    }).finally(() => this.syncing.delete(account.id));
    this.syncing.set(account.id, promise);
  }
  async syncAccount(account) {
    const wasSynced = account.initialSynced;
    this.store.put("accounts", { ...account, status: "syncing", error: null, authFailed: false });
    const remote = await this.transport.folders(account), oldFolders = this.store.list("folders").filter((f) => f.accountId === account.id);
    const mapped = remote.map((f) => this.store.put("folders", { ...oldFolders.find((x) => x.path === f.path), ...f, accountId: account.id, role: f.path.toUpperCase() === "INBOX" ? "\\Inbox" : f.role }));
    for (const old of oldFolders) if (!mapped.some((f) => f.id === old.id)) this.store.put("folders", { ...old, missing: true });
    const roles = { ...account.folders };
    for (const [role, key] of [["\\Sent", "sent"], ["\\Drafts", "drafts"], ["\\Trash", "trash"], ["\\Junk", "junk"], ["\\Archive", "archive"]]) { const matches = mapped.filter((f) => f.role === role); if (!roles[key] && matches.length === 1) roles[key] = matches[0].id; }
    this.store.put("accounts", { ...this.account(account.id), folders: roles });
    let added = 0;
    for (const folder of mapped.filter((f) => f.selectable).sort((a, b) => +(b.role === "\\Inbox") - +(a.role === "\\Inbox"))) {
      this.abort.signal.throwIfAborted();
      const known = this.store.folderMessages(folder.id);
      const result = await this.transport.scan(account, folder, known, async (batch) => {
        for (const message of batch) {
          const previous = this.store.location(account.id, folder.id, message.uidValidity, message.uid);
          if (!previous) added++;
          const saved = this.store.upsertMessage({ ...message, rulesPending: previous?.rulesPending || (!previous && wasSynced) });
          for (const attachment of saved.attachments || []) if (attachment.id && !this.store.get("attachments", attachment.id)) this.store.put("attachments", { ...attachment, messageId: saved.id });
        }
        await new Promise((r) => setImmediate(r));
      }, this.abort.signal);
      const uids = new Set(result.uids);
      for (const m of known) if (m.uidValidity !== result.uidValidity || !uids.has(m.uid)) this.store.deleteMessage(m.id);
      this.store.put("folders", { ...folder, uidValidity: result.uidValidity, highestModseq: result.highestModseq, count: result.uids.length, syncedAt: now() });
      const pending = this.store.folderMessages(folder.id).filter((m) => !m.bodyLoaded).sort((a, b) => b.uid - a.uid);
      for (const message of pending) { this.abort.signal.throwIfAborted(); try { await this.loadMessage(message.id); } catch (error) { if (this.abort.signal.aborted) throw error; this.store.log("body-sync-error", { messageId: message.id, ...errorInfo(error) }); } await new Promise((r) => setImmediate(r)); }
    }
    this.store.put("accounts", { ...this.account(account.id), status: "connected", initialSynced: true, lastSyncedAt: now(), nextSyncAt: this.clock() + 120000, failures: 0, error: null });
    const inbox = mapped.find((f) => f.role === "\\Inbox"); if (inbox && this.transport.idleInbox) await this.transport.idleInbox(account, inbox);
    if (added && wasSynced) this.addNotification("new-mail", `${account.name} 收到 ${added} 封新邮件`, { accountId: account.id });
  }
  async loadMessage(key) {
    let message = this.message(key);
    if (!message.bodyLoaded) {
      const folder = this.folder(message.folderId), account = this.account(message.accountId);
      if (this.transport.body && message.bodyStructure) message = this.store.upsertMessage({ ...message, ...await this.transport.body(account, folder, message) });
      else {
        const raw = await this.transport.raw(account, folder, message), rawPath = join(this.directory, "raw", `${digest(raw)}.eml`); await mkdir(join(this.directory, "raw"), { recursive: true }); await writeFile(rawPath, raw);
        const parsed = await parseMessage(raw, join(this.directory, "blobs"));
        message = this.store.upsertMessage({ ...message, ...parsed, date: parsed.date || message.date, rawPath });
        for (const a of parsed.attachments) this.store.put("attachments", { ...a, messageId: message.id });
      }
      await this.inspectReceipts(message);
    }
    if (message.rulesPending) { await this.applyRules(message); message = this.store.message(key) || message; if (this.store.message(key)) message = this.store.upsertMessage({ ...message, rulesPending: false }); }
    return message;
  }
  async inspectReceipts(message) {
    if (message.inReplyTo) for (const d of this.store.list("drafts")) if (d.messageId === message.inReplyTo && d.status === "sent") this.store.put("drafts", { ...d, replyReceivedAt: message.date, replyMessageId: message.id });
    for (let attachment of message.attachments || []) {
      if (!["text/calendar", "message/disposition-notification", "message/delivery-status"].includes(attachment.contentType) || attachment.size > 1024 * 1024) continue;
      attachment = await this.ensureAttachment(attachment.id);
      if (attachment.contentType === "text/calendar") {
        try { const events = importEvents(await readFile(attachment.path, "utf8")); this.store.put("invitations", { id: `${message.id}:${attachment.id}`, messageId: message.id, events }); } catch (e) { this.store.log("invalid-invitation", { messageId: message.id, ...errorInfo(e) }); }
      }
      if (!["message/disposition-notification", "message/delivery-status"].includes(attachment.contentType)) continue;
      const content = await readFile(attachment.path, "utf8"), mid = content.match(/^Original-Message-ID:\s*(.+)$/im)?.[1]?.trim();
      if (!mid) continue;
      for (const draft of this.store.list("drafts")) if (draft.messageId === mid && draft.accountId === message.accountId) this.store.put("drafts", { ...draft, receipt: { kind: attachment.contentType === "message/disposition-notification" ? "reported" : "delivery-status", receivedAt: now(), disposition: content.match(/^(Disposition|Action):\s*(.+)$/im)?.[2] || "unknown", messageId: message.id, verification: "recipient-reported" } });
    }
  }
  saveDraft(input) {
    requireValue(input && typeof input === "object", "INVALID_DRAFT", "草稿无效。");
    const previous = input.id ? this.store.get("drafts", input.id) : null;
    requireValue(!previous || ["draft", "failed", "needs-confirmation", "discarded"].includes(previous.status), "DRAFT_LOCKED", "请先取消排队；已发送或状态未知的邮件不能直接编辑重发。");
    this.account(input.accountId || previous?.accountId);
    const allowed = ["accountId", "to", "cc", "bcc", "subject", "text", "html", "attachments", "inReplyTo", "references", "sourceMessageId", "requestReceipt", "ical", "icalMethod", "followUpAt"];
    const next = { ...previous, id: input.id || id(), status: "draft" };
    for (const key of allowed) if (input[key] !== undefined) next[key] = input[key];
    next.attachments = (next.attachments || []).map((a) => { const stored = this.store.get("attachments", a.id); requireValue(stored, "ATTACHMENT_NOT_FOUND", "附件不存在，请重新选择。"); return { id: stored.id, filename: cleanFilename(a.filename || stored.filename), size: stored.size, contentType: stored.contentType, cid: a.cid || null }; });
    return draftView(this.store.put("drafts", next, input.revision));
  }
  async replyDraft({ id: messageId, mode = "reply", accountId }) {
    const m = await this.loadMessage(messageId), account = this.account(accountId || m.accountId), allMine = new Set(this.store.list("accounts").map((a) => a.email));
    const to = mode === "forward" ? [] : m.replyTo?.length ? m.replyTo : m.from;
    const cc = mode === "replyAll" ? [...m.to, ...m.cc].filter((a) => !allMine.has(a.address) && !to.some((t) => t.address === a.address)) : [];
    return this.saveDraft({ accountId: account.id, to, cc, subject: `${mode === "forward" ? "Fwd" : "Re"}: ${m.subject}`, text: `\n\n—— ${m.date} ${m.from.map((a) => a.address).join(", ")} ——\n${m.text}`, inReplyTo: mode === "forward" ? undefined : m.messageId, references: [...(m.references || []), ...(m.messageId ? [m.messageId] : [])], sourceMessageId: m.id, attachments: mode === "forward" ? m.attachments.map(({ id, filename, cid }) => ({ id, filename, cid })) : [] });
  }
  previewFingerprint(kind, payload) {
    if (kind === "send") { const d = this.store.get("drafts", payload.draftId); requireValue(d, "DRAFT_NOT_FOUND", "草稿不存在。"); return digest({ draft: d, account: sendIdentity(this.account(d.accountId)), scheduledAt: payload.scheduledAt }); }
    if (kind === "folder-delete") return digest({ folder: this.folder(payload.folderId), messages: this.store.folderMessages(payload.folderId).map((m) => [m.id, m.uid, m.uidValidity]) });
    if (kind === "rule-history") return digest({ rule: this.store.get("rules", payload.ruleId), ids: payload.ids.map((key) => { const m = this.message(key); return [m.id, m.revision]; }) });
    return digest(payload.ids.map((key) => { const m = this.message(key); return [m.id, m.revision, m.folderId, m.uidValidity]; }));
  }
  preview(kind, payload, context) {
    let details;
    if (kind === "send") {
      const d = this.store.get("drafts", payload.draftId); requireValue(d && ["draft", "failed", "needs-confirmation"].includes(d.status), "DRAFT_NOT_SENDABLE", "此草稿当前不能发送。");
      validateAddresses(d.to, true); validateAddresses(d.cc); validateAddresses(d.bcc);
      if (payload.scheduledAt) requireValue(Date.parse(payload.scheduledAt) > this.clock(), "INVALID_SEND_TIME", "定时发送时间必须在未来。");
      details = { ...draftView(d), from: this.account(d.accountId).email, calendarEvents: d.ical ? importEvents(d.ical).map(({ title, start, end, timeZone, organizer, attendees, method }) => ({ title, start, end, timeZone, organizer, attendees, method })) : [], scheduledAt: payload.scheduledAt, warning: "确认后进入发件箱；立即发送保留 10 秒取消时间。" };
    } else if (kind === "folder-delete") details = { folder: this.folder(payload.folderId).path, count: this.store.folderMessages(payload.folderId).length, warning: "删除服务器文件夹及其中邮件，无法撤销。" };
    else details = { count: payload.ids.length, samples: payload.ids.slice(0, 20).map((key) => { const m = this.message(key); return { id: key, subject: m.subject, accountId: m.accountId }; }), rule: kind === "rule-history" ? this.store.get("rules", payload.ruleId) : undefined };
    return publicValue(this.store.put("previews", { kind, payload, fingerprint: this.previewFingerprint(kind, payload), details, status: "pending", sessionId: context.sessionId || null, expiresAt: new Date(this.clock() + 30 * 60000).toISOString() }));
  }
  async confirm(key, context) {
    this.assertHuman(context); const p = this.store.get("previews", key);
    requireValue(p?.status === "pending" && Date.parse(p.expiresAt) > this.clock(), "PREVIEW_EXPIRED", "预览已失效，请重新生成。");
    requireValue(p.fingerprint === this.previewFingerprint(p.kind, p.payload), "PREVIEW_CHANGED", "预览后内容或目标已改变，请重新核对。");
    this.store.put("previews", { ...p, status: "confirmed", confirmedAt: now() });
    this.store.log("user-confirmed", { previewId: p.id, kind: p.kind, fingerprint: p.fingerprint });
    if (p.kind === "send") { const d = this.store.get("drafts", p.payload.draftId); return draftView(this.store.put("drafts", { ...d, status: "queued", sendAt: p.payload.scheduledAt || new Date(this.clock() + 10000).toISOString(), approvedRevision: d.revision, approvedAccount: digest(sendIdentity(this.account(d.accountId))), approvalId: p.id })); }
    if (p.kind === "folder-delete") return this.createJob("folder-delete", [p.payload.folderId], {});
    return this.createJob(p.kind === "purge" ? "messages" : "rule-history", p.payload.ids, p.kind === "purge" ? { operation: "purge", approvalId: p.id } : { rule: this.store.get("rules", p.payload.ruleId), approvalId: p.id });
  }
  createJob(kind, ids, args) {
    const job = this.store.put("jobs", { kind, args, status: "queued", items: ids.map((key) => ({ id: key, status: "pending" })), createdAt: now(), completed: 0 });
    const run = this.runJob(job.id).catch((error) => { const current = this.store.get("jobs", job.id); this.store.put("jobs", { ...current, status: "failed", error: errorInfo(error) }); }).finally(() => this.work.delete(job.id)); this.work.set(job.id, run); return publicValue(job);
  }
  async runJob(key) {
    let job = this.store.get("jobs", key); this.store.put("jobs", { ...job, status: "running" });
    for (let i = 0; i < job.items.length; i++) {
      job = this.store.get("jobs", key);
      if (this.stopped || job.cancelRequested) { this.store.put("jobs", { ...job, status: "cancelled" }); return; }
      if (job.items[i].status !== "pending") continue;
      job.items[i].status = "running"; this.store.put("jobs", job);
      try {
        let result;
        if (job.kind === "messages") result = await this.messageAction(job.items[i].id, job.args);
        else if (job.kind === "rule-history") result = await this.runRule(job.args.rule, this.message(job.items[i].id));
        else if (job.kind === "folder-delete") { const f = this.folder(job.items[i].id); requireValue(!this.store.list("folders").some((x) => x.accountId === f.accountId && x.path.startsWith(f.path + f.delimiter)), "HAS_SUBFOLDERS", "请先处理子文件夹。"); if (!this.account(f.accountId).local) requireValue(await this.transport.folderAction(this.account(f.accountId), "delete", f.path), "FOLDER_DELETE_FAILED", "服务器未确认删除文件夹。"); for (const m of this.store.folderMessages(f.id)) this.store.deleteMessage(m.id); this.store.remove("folders", f.id); result = { deleted: true }; }
        else if (job.kind === "folder-copy") result = await this.copyFolderItem(job.items[i].id, job.args, key);
        job = this.store.get("jobs", key); job.items[i] = { ...job.items[i], status: result?.unknown ? "verify-required" : "done", result };
      } catch (e) { job = this.store.get("jobs", key); job.items[i] = { ...job.items[i], status: "failed", error: errorInfo(e) }; }
      job.completed = job.items.filter((x) => x.status === "done").length; this.store.put("jobs", job);
      await new Promise((r) => setImmediate(r));
    }
    job = this.store.get("jobs", key); this.store.put("jobs", { ...job, status: job.items.some((x) => x.status !== "done") ? "partial" : "completed" });
  }
  retryJob(key) {
    const job = this.store.get("jobs", key); requireValue(job && !this.work.has(key), "JOB_RUNNING", "任务仍在运行。");
    if (job.kind === "folder-copy") {
      this.store.put("jobs", { ...job, cancelRequested: false, status: "queued", items: job.items.map((item) => ({ ...item, status: item.status === "done" ? "done" : "pending" })) });
      const run = this.runJob(key).catch((error) => this.store.put("jobs", { ...this.store.get("jobs", key), status: "failed", error: errorInfo(error) })).finally(() => this.work.delete(key)); this.work.set(key, run); return publicValue(this.store.get("jobs", key));
    }
    requireValue(!["purge", "move", "copy"].includes(job.args?.operation) && !["folder-delete", "folder-copy"].includes(job.kind), "VERIFY_BEFORE_RETRY", "此操作可能已在服务器完成，请同步核查后重新选择未完成目标，避免重复复制或删除。");
    return this.createJob(job.kind, job.items.filter((x) => ["pending", "failed"].includes(x.status)).map((x) => x.id), job.args);
  }
  async messageAction(key, { operation, value, destinationId }) {
    let m = this.message(key); const account = this.account(m.accountId), folder = this.folder(m.folderId);
    if (operation === "label" || operation === "snooze") return publicValue(this.store.upsertMessage({ ...m, ...(operation === "label" ? { labels: [...new Set(value || [])] } : { snoozedUntil: value || null }) }));
    if (["star", "read"].includes(operation)) { const flag = operation === "star" ? "\\Flagged" : "\\Seen"; if (!account.local) await this.transport.flags(account, folder, m, value ? [flag] : [], value ? [] : [flag]); return publicValue(this.store.upsertMessage({ ...m, flags: value ? [...new Set([...m.flags, flag])] : m.flags.filter((f) => f !== flag) })); }
    if (operation === "purge") { if (!account.local) requireValue(await this.transport.purge(account, folder, m), "PURGE_FAILED", "服务器未确认永久删除。"); this.store.deleteMessage(m.id); return { deleted: true }; }
    requireValue(["copy", "move", "archive", "trash", "junk", "restore"].includes(operation), "INVALID_MAIL_ACTION", "邮件操作无效。");
    const role = { archive: "archive", trash: "trash", junk: "junk" }[operation];
    const targetId = destinationId || (operation === "restore" ? m.previousFolderId : account.folders?.[role]);
    requireValue(targetId, "FOLDER_MAPPING_REQUIRED", "请先在账号设置中选择目标文件夹；恢复邮件需要原文件夹记录，也可手动选择目标。");
    const target = this.folder(targetId);
    requireValue(target.id !== folder.id, "SAME_FOLDER", "目标与来源文件夹相同。");
    const targetAccount = this.account(target.accountId), move = operation !== "copy";
    if (move) for (const a of m.attachments || []) await this.ensureAttachment(a.id);
    let destination;
    const saveDestination = (uid, uidValidity) => {
      const key = move ? m.id : id(), attachments = (m.attachments || []).map((a) => ({ ...a, ...this.store.get("attachments", a.id), id: move ? a.id : id(), messageId: key }));
      return this.store.transaction(() => { for (const a of attachments) this.store.put("attachments", a); return this.store.upsertMessage({ ...m, id: key, accountId: targetAccount.id, folderId: target.id, uid, uidValidity: String(uidValidity), attachments, previousFolderId: move ? folder.id : undefined }); });
    };
    if (!account.local && !targetAccount.local && target.accountId === account.id) {
      // Retain attachment bytes before a destructive transfer even when a server omits COPYUID.
      const transferred = await (move ? this.transport.move(account, folder, m, target) : this.transport.copy(account, folder, m, target));
      requireValue(transferred, "TRANSFER_FAILED", "服务器未确认操作完成。");
      const targetUid = transferred.uidMap?.get(m.uid);
      if (!targetUid || !transferred.uidValidity) { this.scheduleSync(account, true); return { status: "verify-required", unknown: 1, operation, destinationId: target.id, message: "服务器已接受操作但未返回目标 UID，请同步并核查目标，不要直接重试。" }; }
      destination = saveDestination(targetUid, transferred.uidValidity);
    } else {
      m = await this.loadMessage(m.id); const raw = await this.ensureRaw(m.id);
      const parsed = await parseMessage(raw, join(this.directory, "blobs")); m = { ...this.message(m.id), ...parsed };
      if (targetAccount.local) { if (move && !account.local) requireValue(await this.transport.purge(account, folder, m), "SOURCE_RETAINED", "原邮件未确认删除；本地原始副本已保留，请核查后再处理。"); destination = saveDestination(this.nextLocalUid(target.id), "1"); }
      else {
        const appended = await this.transport.append(targetAccount, target, raw, m.flags, m.date);
        requireValue(appended?.uid && appended.uidValidity, "COPY_VERIFICATION_REQUIRED", "目标服务器未返回完整 APPENDUID；原邮件保留，请同步目标文件夹确认后再处理。");
        // A returned APPENDUID is the server's durable acknowledgement of the copied instance.
        // Keep source identity until its removal is acknowledged.
        if (move && !account.local) requireValue(await this.transport.purge(account, folder, m), "SOURCE_RETAINED", "复制已完成，原邮件尚未删除，请核查目标；不要重试复制。");
        destination = saveDestination(appended.uid, appended.uidValidity);
      }
    }
    if (!account.local) this.scheduleSync(account, true);
    if (!targetAccount.local && targetAccount.id !== account.id) this.scheduleSync(targetAccount, true);
    return { status: "completed", operation, destinationId: target.id, messageId: destination.id };
  }
  async folderOperation(args, context) {
    const { operation } = args;
    if (operation === "delete") return this.preview("folder-delete", { folderId: args.id }, context);
    if (operation === "create") {
      const account = this.account(args.accountId); requireValue(args.path && !/[\r\n\x00]/.test(args.path), "INVALID_FOLDER", "请填写有效文件夹名。");
      requireValue(!this.store.list("folders").some((f) => f.accountId === account.id && f.path === args.path), "FOLDER_EXISTS", "同名文件夹已存在。");
      if (!account.local) requireValue(await this.transport.folderAction(account, "create", args.path), "FOLDER_CREATE_FAILED", "服务器未确认新建文件夹。");
      const folder = this.store.put("folders", { accountId: account.id, path: args.path, name: args.path, delimiter: args.delimiter || "/", selectable: true, uidValidity: account.local ? "1" : null });
      if (!account.local) this.scheduleSync(account, true); return folder;
    }
    const source = this.folder(args.id);
    if (operation === "rename" || operation === "move") {
      requireValue(args.path && args.path !== source.path && !args.path.startsWith(source.path + source.delimiter), "INVALID_FOLDER_DESTINATION", "不能将文件夹移到自身或其子目录。");
      requireValue(!this.store.list("folders").some((f) => f.accountId === source.accountId && f.path === args.path), "FOLDER_EXISTS", "目标文件夹已存在。");
      const account = this.account(source.accountId); if (!account.local) requireValue(await this.transport.folderAction(account, "rename", source.path, args.path), "FOLDER_RENAME_FAILED", "服务器未确认重命名。");
      for (const folder of this.store.list("folders").filter((f) => f.accountId === source.accountId && (f.path === source.path || f.path.startsWith(source.path + source.delimiter)))) this.store.put("folders", { ...folder, path: args.path + folder.path.slice(source.path.length), name: (args.path + folder.path.slice(source.path.length)).split(source.delimiter).at(-1) });
      return this.folder(source.id);
    }
    requireValue(operation === "copy", "INVALID_FOLDER_ACTION", "文件夹操作无效。");
    const targetAccount = this.account(args.accountId || source.accountId), path = String(args.path || "").trim();
    requireValue(path && !(targetAccount.id === source.accountId && (path === source.path || path.startsWith(source.path + source.delimiter))), "INVALID_FOLDER_DESTINATION", "请选择来源之外的新目标文件夹。");
    const tree = this.store.list("folders").filter((f) => f.accountId === source.accountId && (f.id === source.id || f.path.startsWith(source.path + source.delimiter))).sort((a, b) => a.path.length - b.path.length);
    const delimiter = this.store.list("folders").find((f) => f.accountId === targetAccount.id)?.delimiter || "/";
    const entries = tree.map((f) => ({ sourceId: f.id, path: path + f.path.slice(source.path.length).split(source.delimiter || "/").join(delimiter), delimiter, messageIds: args.structureOnly ? [] : this.store.folderMessages(f.id).map((m) => m.id) }));
    requireValue(!entries.some((e) => this.store.list("folders").some((f) => f.accountId === targetAccount.id && f.path === e.path)), "FOLDER_EXISTS", "目标中存在同名文件夹，请指定新的名称。");
    return this.createJob("folder-copy", entries.map((e) => e.sourceId), { targetAccountId: targetAccount.id, entries });
  }
  async copyFolderItem(key, args, jobId) {
    const entry = args.entries.find((e) => e.sourceId === key);
    const read = () => this.store.get("jobs", jobId).items.find((item) => item.id === key);
    const checkpoint = (patch) => { const job = this.store.get("jobs", jobId); job.items = job.items.map((item) => item.id === key ? { ...item, ...patch } : item); this.store.put("jobs", job); };
    let folder = read().targetFolderId ? this.folder(read().targetFolderId) : null;
    if (!folder) {
      requireValue(!read().creatingFolder, "FOLDER_CREATE_UNKNOWN", "创建目标文件夹时中断，请同步并核查后重新选择目标，避免重复或合并。");
      checkpoint({ creatingFolder: true });
      folder = await this.folderOperation({ operation: "create", accountId: args.targetAccountId, path: entry.path, delimiter: entry.delimiter }, { kind: "background" });
      checkpoint({ targetFolderId: folder.id, creatingFolder: false, copies: entry.messageIds.map((id) => ({ id, status: "pending" })) });
    }
    for (let index = 0; index < read().copies.length; index++) {
      this.abort.signal.throwIfAborted(); requireValue(!this.store.get("jobs", jobId).cancelRequested, "CANCELLED", "复制已停止，可继续未开始项目。");
      let copies = read().copies; if (copies[index].status !== "pending") continue;
      copies[index].status = "running"; checkpoint({ copies });
      try { const result = await this.messageAction(copies[index].id, { operation: "copy", destinationId: folder.id }); copies = read().copies; copies[index] = { ...copies[index], status: result.unknown ? "unknown" : "done", result }; }
      catch (error) { copies = read().copies; copies[index] = { ...copies[index], status: "unknown", error: errorInfo(error) }; }
      checkpoint({ copies }); await new Promise((r) => setImmediate(r));
    }
    const copies = read().copies; return { folderId: folder.id, copied: copies.filter((c) => c.status === "done").length, unknown: copies.filter((c) => c.status !== "done").length };
  }
  async applyRules(message) { for (const rule of this.store.list("rules").filter((r) => r.enabled).sort((a, b) => a.priority - b.priority)) { if (!this.store.message(message.id)) break; if (!matches(rule, message)) continue; const key = `${rule.id}:${rule.revision}:${message.id}`; if (this.store.get("rule-runs", key)) continue; await this.runRule(rule, message); this.store.put("rule-runs", { id: key, ruleId: rule.id, messageId: message.id }); if (rule.stop) break; } }
  async runRule(rule, message) { const results = []; for (const action of rule.actions) { if (action.action === "task") results.push(this.saveResource("tasks", { title: action.title || message.subject, sourceMessageId: message.id, evidence: message.text?.slice(0, 300), priority: "normal" })); else results.push(await this.messageAction(message.id, { operation: action.action, value: action.value ?? true, destinationId: action.destinationId })); if (["move", "archive"].includes(action.action)) break; } this.store.log("rule-applied", { ruleId: rule.id, messageId: message.id }); return { actions: results.length }; }
  saveResource(kind, value) {
    requireValue(value && typeof value === "object", "INVALID_VALUE", "记录无效。");
    if (kind === "tasks") { requireValue(value.title?.trim(), "TITLE_REQUIRED", "请填写待办名称。"); if (value.due) requireValue(Number.isFinite(Date.parse(value.due)), "INVALID_DATE", "截止日期无效。"); }
    if (kind === "contacts") validateAddresses(value.email, true);
    if (value.sourceMessageId) this.message(value.sourceMessageId);
    return this.store.put(kind, value, value.revision);
  }
  saveEvent(input) { const previous = input.id ? this.store.get("events", input.id) : null; const event = normalizeEvent({ ...previous, ...input, uid: previous?.uid || input.uid, sequence: previous ? previous.sequence + 1 : 0 }); return this.store.put("events", event, input.revision); }
  inviteDraft(action, args) {
    const event = this.store.get("events", args.id); requireValue(event, "EVENT_NOT_FOUND", "事件不存在。"); const account = this.account(args.accountId);
    let content = { ...event }, method = "REQUEST", to;
    if (action === "events.rsvp") { requireValue(["ACCEPTED", "TENTATIVE", "DECLINED"].includes(args.response), "INVALID_RESPONSE", "请选择接受、暂定或拒绝。"); requireValue(event.organizer, "ORGANIZER_REQUIRED", "邀请缺少组织者。"); method = "REPLY"; to = event.organizer; content.attendees = [{ address: account.email, partstat: args.response }]; }
    else { content.organizer = account.email; content.attendees = args.attendees || event.attendees; to = content.attendees; }
    return this.saveDraft({ accountId: account.id, to, subject: `${method === "REPLY" ? "会议回复" : "会议邀请"}：${event.title}`, text: `${event.title}\n${event.start} — ${event.end}\n${event.location || ""}\n${event.description || ""}`, ical: exportEvents([content], method), icalMethod: method });
  }
  async tick() {
    if (this.stopped) return;
    for (const account of this.store.list("accounts")) if (!account.local && account.enabled && !account.authFailed && (account.nextSyncAt || 0) <= this.clock()) this.scheduleSync(account);
    if (!this.sending) { this.sending = true; try { for (const draft of this.store.list("drafts")) if (!this.stopped && draft.status === "queued" && Date.parse(draft.sendAt) <= this.clock()) await this.deliver(draft); } finally { this.sending = false; } }
    if (this.stopped) return;
    if ((this.lastReminderCheck || 0) + 30000 <= this.clock()) { this.lastReminderCheck = this.clock(); this.reminders(); }
  }
  async deliver(draft) {
    const account = this.account(draft.accountId); if (!account.enabled) { this.store.put("drafts", { ...draft, status: "needs-confirmation", error: "账号已暂停，请启用后重新确认发送。" }); return; }
    if (this.clock() - Date.parse(draft.sendAt) > 60000 || draft.approvedAccount !== digest(sendIdentity(account))) { this.store.put("drafts", { ...draft, status: "needs-confirmation", error: "发送时间已错过或发件配置已改变，请重新预览确认。" }); return; }
    let compiled;
    try { compiled = await composeDraft(draft, account, (key) => this.ensureAttachment(key)); }
    catch (e) { this.store.put("drafts", { ...draft, status: "failed", error: errorInfo(e) }); return; }
    const rawPath = join(this.directory, "raw", `${digest(compiled.raw)}.eml`); await mkdir(join(this.directory, "raw"), { recursive: true }); await writeFile(rawPath, compiled.raw);
    const sending = this.store.put("drafts", { ...draft, status: "sending", messageId: compiled.messageId, rawPath });
    try {
      const result = await this.transport.send(account, compiled.raw, compiled.envelope);
      const accepted = (result.accepted || []).map((x) => typeof x === "string" ? x : x.address);
      requireValue(accepted.length > 0, "ALL_RECIPIENTS_REJECTED", "服务器拒绝所有收件人。");
      const sent = this.store.put("drafts", { ...sending, status: "sent", sentAt: now(), accepted, rejected: publicValue(result.rejected || []), sentCopyStatus: "pending" });
      this.store.log("sent", { draftId: sent.id, messageId: sent.messageId, accepted, rejected: sent.rejected });
      await this.saveSentCopy(sent, account, compiled.raw);
    } catch (error) {
      // SMTP acceptance may have happened before a disconnect. Never retry an ambiguous send.
      const current = this.store.get("drafts", draft.id); if (current.status === "sent") return;
      const definite = error.code === "EAUTH" || error.code === "ALL_RECIPIENTS_REJECTED" || (error.responseCode >= 400 && error.responseCode <= 599);
      this.store.put("drafts", { ...current, status: definite ? "failed" : "uncertain", error: errorInfo(error) });
    }
  }
  async saveSentCopy(sent, account, raw) {
    try {
      const folder = account.folders?.sent ? this.folder(account.folders.sent) : null;
      requireValue(folder, "SENT_FOLDER_REQUIRED", "邮件已发送，请在设置中映射已发送文件夹；本地副本已保留。");
      const found = await this.transport.findSent(account, folder, sent.messageId);
      if (!found?.length) requireValue(await this.transport.append(account, folder, raw, ["\\Seen"], sent.sentAt), "SENT_COPY_FAILED", "邮件已发送，但服务器未确认保存副本。");
      this.store.put("drafts", { ...this.store.get("drafts", sent.id), sentCopyStatus: "saved" });
    } catch (error) { this.store.put("drafts", { ...this.store.get("drafts", sent.id), sentCopyStatus: "failed", sentCopyError: errorInfo(error) }); }
  }
  addNotification(kind, title, data) { const n = this.store.put("notifications", { kind, title, data, createdAt: now() }); this.notify(publicValue(n)); return n; }
  reminders() {
    const start = new Date(this.clock() - 7 * 86400000).toISOString(), end = new Date(this.clock() + 86400000).toISOString();
    for (const event of occurrences(this.store.list("events"), start, end)) { const when = Date.parse(event.start) - event.reminderMinutes * 60000; const key = `event:${event.id}`; if (when <= this.clock() && !this.store.get("reminder-deliveries", key)) { this.addNotification("event", event.title, { eventId: event.eventId, start: event.start }); this.store.put("reminder-deliveries", { id: key }); } }
    for (const task of this.store.list("tasks").filter((t) => !t.done && !t.deleted && t.due)) { const key = `task:${task.id}:${task.due}`; if (Date.parse(task.due) <= this.clock() && !this.store.get("reminder-deliveries", key)) { this.addNotification("task", task.title, { taskId: task.id }); this.store.put("reminder-deliveries", { id: key }); } }
    for (const draft of this.store.list("drafts")) if (draft.status === "sent" && draft.followUpAt && !draft.replyReceivedAt && Date.parse(draft.followUpAt) <= this.clock() && !draft.followUpNotified) { this.addNotification("follow-up", `尚未收到回复：${draft.subject}`, { draftId: draft.id }); this.store.put("drafts", { ...draft, followUpNotified: true }); }
  }
  async upload({ filename, contentType, base64 }) { const bytes = Buffer.from(base64 || "", "base64"); requireValue(bytes.length && bytes.length <= 50 * 1024 * 1024, "ATTACHMENT_SIZE", "附件必须为 1 字节至 50 MiB。"); const key = digest(bytes), path = join(this.directory, "blobs", key); await mkdir(join(this.directory, "blobs"), { recursive: true }); await writeFile(path, bytes); return publicValue(this.store.put("attachments", { id: key, filename: cleanFilename(filename), contentType: contentType || "application/octet-stream", size: bytes.length, path })); }
  async ensureAttachment(key) { let a = this.store.get("attachments", key); requireValue(a, "ATTACHMENT_NOT_FOUND", "附件不存在，请先同步或打开邮件。"); if (!a.path) { const m = this.message(a.messageId), bytes = await this.transport.attachment(this.account(m.accountId), this.folder(m.folderId), m, a.part), path = join(this.directory, "blobs", digest(bytes)); await mkdir(join(this.directory, "blobs"), { recursive: true }); await writeFile(path, bytes); a = this.store.put("attachments", { ...a, path, size: bytes.length }); } return a; }
  async ensureRaw(key) { const m = this.message(key); if (m.rawPath) return readFile(m.rawPath); const bytes = await this.transport.raw(this.account(m.accountId), this.folder(m.folderId), m), rawPath = join(this.directory, "raw", `${digest(bytes)}.eml`); await mkdir(join(this.directory, "raw"), { recursive: true }); await writeFile(rawPath, bytes); this.store.upsertMessage({ ...m, rawPath }); return bytes; }
  async attachmentDownload({ id: key }) { const a = await this.ensureAttachment(key); const bytes = await readFile(a.path); return { filename: a.filename, contentType: a.contentType, size: bytes.length, base64: bytes.toString("base64") }; }
  async download(filename, contentType, bytes) { const fileId = id(), dir = join(this.directory, "exports"); await mkdir(dir, { recursive: true }); const path = inside(dir, `${fileId}-${cleanFilename(filename)}`); await writeFile(path, bytes); this.store.put("exports", { id: fileId, filename: cleanFilename(filename), contentType, path, size: bytes.length }); return { id: fileId, filename: cleanFilename(filename), contentType, size: bytes.length, base64: bytes.length <= 60 * 1024 * 1024 ? bytes.toString("base64") : undefined, localPath: path }; }
  async saveFile({ id: key, directory, attachment }) { requireValue(typeof directory === "string" && resolve(directory) === directory, "ABSOLUTE_PATH_REQUIRED", "请选择绝对目录路径。"); const file = this.store.get(attachment ? "attachments" : "exports", key); requireValue(file, "FILE_NOT_FOUND", "文件不存在。"); await mkdir(directory, { recursive: true }); const target = inside(directory, cleanFilename(file.filename)); await copyFile(file.path, target, 1); const metadata = await stat(target); return { path: target, size: metadata.size }; }
  async exportMail({ ids, folderId, format = "eml" }) {
    const keys = ids || this.store.folderMessages(folderId).map((m) => m.id); requireValue(keys.length, "NO_MESSAGES", "没有可导出的邮件。"); const entries = [];
    for (const key of keys) { const m = await this.loadMessage(key); entries.push({ message: m, raw: await this.ensureRaw(m.id) }); }
    if (format === "mbox") return this.download("mail.mbox", "application/mbox", Buffer.concat(entries.map(({ message, raw }) => Buffer.from(`From ${message.from[0]?.address || "unknown"} ${new Date(message.date).toUTCString()}\n${raw.toString("latin1").replace(/\r\n/g, "\n").replace(/^(>*From )/gm, ">$1")}\n\n`, "latin1"))));
    if (entries.length === 1) return this.download(cleanFilename(entries[0].message.subject) + ".eml", "message/rfc822", entries[0].raw);
    const zip = new JSZip(); entries.forEach(({ message, raw }, i) => zip.file(`${i + 1}-${cleanFilename(message.subject)}.eml`, raw)); return this.download("mail.zip", "application/zip", await zip.generateAsync({ type: "nodebuffer" }));
  }
  nextLocalUid(folderId) { return Number(this.store.db.prepare("SELECT coalesce(max(uid),0)+1 AS n FROM messages WHERE folder_id=?").get(folderId).n); }
  async importMail({ base64, format = "eml", folderName = "导入邮件" }) {
    if (!this.store.get("accounts", "local")) this.store.put("accounts", { id: "local", email: "local@localhost.invalid", name: "本地归档", local: true, enabled: true });
    let folder = this.store.list("folders").find((f) => f.accountId === "local" && f.path === folderName); if (!folder) folder = await this.folderOperation({ operation: "create", accountId: "local", path: folderName }, { kind: "human" });
    const bytes = Buffer.from(base64, "base64"); requireValue(bytes.length <= 100 * 1024 * 1024, "IMPORT_TOO_LARGE", "单次导入不超过 100 MiB。");
    const raws = format === "mbox" ? bytes.toString("latin1").split(/^From [^\n]*\n/gm).filter((x) => x.trim()).map((x) => Buffer.from(x.replace(/^>(>*From )/gm, "$1"), "latin1")) : [bytes];
    const imported = [];
    for (const raw of raws) { const parsed = await parseMessage(raw, join(this.directory, "blobs")), rawPath = join(this.directory, "raw", `${digest(raw)}.eml`); await mkdir(join(this.directory, "raw"), { recursive: true }); await writeFile(rawPath, raw); const m = this.store.upsertMessage({ ...parsed, accountId: "local", folderId: folder.id, uid: this.nextLocalUid(folder.id), uidValidity: "1", flags: [], size: raw.length, rawPath }); for (const a of m.attachments) this.store.put("attachments", { ...a, messageId: m.id }); imported.push(m.id); }
    return { folderId: folder.id, imported: imported.length, ids: imported };
  }
  importContacts({ text, format }) {
    const parsed = format === "vcard" ? ICAL.parse(text) : null;
    const records = parsed ? (typeof parsed[0] === "string" ? [parsed] : parsed).map((c) => new ICAL.Component(c)).map((c) => ({ name: c.getFirstPropertyValue("fn"), email: c.getFirstPropertyValue("email"), group: c.getFirstPropertyValue("categories") || "" })) : parseCsv(text, { columns: true, bom: true, skip_empty_lines: true });
    const outcomes = [];
    for (const record of records) { try { const email = validateAddresses(record.email || record.Email || record["邮箱"], true)[0].address, old = this.store.list("contacts").find((c) => c.email === email); outcomes.push({ status: "saved", contact: this.store.put("contacts", { ...old, name: record.name || record.Name || record["姓名"] || "", email, group: record.group || "" }) }); } catch (error) { outcomes.push({ status: "failed", error: errorInfo(error) }); } }
    return outcomes;
  }
  exportContacts(format = "csv") { const contacts = this.store.list("contacts").filter((c) => !c.deleted); if (format === "vcard") { const text = contacts.map((contact) => { const c = new ICAL.Component("vcard"); c.addPropertyWithValue("version", "4.0"); c.addPropertyWithValue("fn", contact.name || contact.email); c.addPropertyWithValue("email", contact.email); return c.toString(); }).join("\r\n"); return this.download("contacts.vcf", "text/vcard", Buffer.from(text)); } return this.download("contacts.csv", "text/csv", Buffer.from("\ufeff" + stringifyCsv(contacts.map(({ name, email, group }) => ({ name, email, group })), { header: true }))); }
  async backup() {
    const zip = new JSZip(), entities = this.store.db.prepare("SELECT kind,data FROM entities WHERE kind NOT IN ('credentials','previews','exports','jobs')").all().map((r) => ({ kind: r.kind, data: JSON.parse(r.data) }));
    const messages = this.store.db.prepare("SELECT data FROM messages").all().map((r) => JSON.parse(r.data));
    const paths = new Set([...messages.flatMap((m) => [m.rawPath, ...(m.attachments || []).map((a) => a.path)]), ...entities.filter((e) => e.kind === "attachments").map((e) => e.data.path), ...entities.filter((e) => e.kind === "drafts").map((e) => e.data.rawPath)].filter(Boolean));
    const mapping = new Map(); for (const path of paths) { const name = `files/${digest(path)}`; zip.file(name, await readFile(path)); mapping.set(path, name); }
    const snapshot = JSON.stringify({ version: 1, createdAt: now(), entities, messages }, function (key, value) { return (key === "rawPath" || (key === "path" && this.contentType)) && mapping.has(value) ? mapping.get(value) : value; });
    zip.file("snapshot.json", snapshot); return this.download("dsh-mail-backup.zip", "application/zip", await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  }
  async restore({ base64 }) {
    requireValue(this.store.db.prepare("SELECT count(*) AS n FROM messages").get().n === 0 && this.store.list("accounts").length === 0, "RESTORE_REQUIRES_EMPTY", "为防止覆盖现有邮箱，请在空数据配置中恢复备份。");
    const zip = await JSZip.loadAsync(Buffer.from(base64, "base64")); requireValue(zip.file("snapshot.json"), "INVALID_BACKUP", "缺少备份清单。");
    const snapshot = JSON.parse(await zip.file("snapshot.json").async("string")); requireValue(snapshot.version === 1 && Array.isArray(snapshot.entities) && Array.isArray(snapshot.messages), "INVALID_BACKUP", "备份版本或结构无效。");
    const allowedKinds = new Set([...SAFE_RESOURCES, "accounts", "folders", "attachments", "drafts", "rules", "events", "invitations", "settings", "notifications", "rule-runs", "reminder-deliveries"]);
    for (const entry of snapshot.entities) requireValue(allowedKinds.has(entry.kind) && typeof entry.data?.id === "string", "BACKUP_FORBIDDEN", "备份包含凭据或未知资源。");
    const validPath = (path) => requireValue(typeof path === "string" && /^files\/[a-f0-9]{64}$/.test(path) && zip.file(path), "INVALID_BACKUP_PATH", "备份文件引用必须来自备份包内部。");
    for (const entry of snapshot.entities) { if (entry.kind === "attachments" && entry.data.path) validPath(entry.data.path); if (entry.kind === "drafts" && entry.data.rawPath) validPath(entry.data.rawPath); }
    for (const message of snapshot.messages) { if (message.rawPath) validPath(message.rawPath); for (const a of message.attachments || []) if (a.path) validPath(a.path); }
    const dir = join(this.directory, "restored", id()); await mkdir(dir, { recursive: true }); let size = 0; const mapping = new Map();
    for (const file of Object.values(zip.files).filter((f) => !f.dir && f.name !== "snapshot.json")) { requireValue(/^files\/[a-f0-9]{64}$/.test(file.name), "INVALID_BACKUP_PATH", "备份包含非法路径。"); const bytes = await file.async("nodebuffer"); size += bytes.length; requireValue(size <= 1024 * 1024 * 1024, "BACKUP_TOO_LARGE", "恢复数据超过 1 GiB 限制。"); const path = inside(dir, file.name.slice(6)); await writeFile(path, bytes); mapping.set(file.name, path); }
    const restored = JSON.parse(JSON.stringify(snapshot), function (key, value) { return PRIVATE_FIELDS.has(key) && key !== "rawPath" ? undefined : (key === "rawPath" || (key === "path" && this.contentType)) ? mapping.get(value) : value; });
    for (const entry of restored.entities) if (entry.kind === "attachments") entry.data.path = mapping.get(snapshot.entities.find((e) => e.kind === "attachments" && e.data.id === entry.data.id).data.path);
    this.store.transaction(() => {
      for (const entry of restored.entities) { const value = entry.kind === "accounts" ? { ...entry.data, enabled: !!entry.data.local, disconnected: !entry.data.local, status: "disconnected" } : entry.kind === "drafts" ? { ...entry.data, status: entry.data.status === "sent" ? "sent" : "draft" } : entry.kind === "rules" ? { ...entry.data, enabled: false } : entry.data; this.store.put(entry.kind, value); }
      for (const m of restored.messages) this.store.upsertMessage(m);
    });
    return { restored: restored.messages.length, reconnectRequired: true };
  }
  async close() { this.stopped = true; clearInterval(this.timer); this.abort.abort(); await this.transport.close(); await Promise.allSettled([...this.syncing.values(), ...this.work.values(), this.ticking]); this.store.close(); }
}

import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { id, now, requireValue, bounded, queryTokens, searchTokens } from "./util.mjs";
import { buildConversations, conversationHeaders } from "./conversations.mjs";

export class Store {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, "mail.sqlite");
    this.db = new DatabaseSync(this.path);
    this.messageVersion = 0;
    this.conversationVersion = 0;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    requireValue(version <= 2, "DATABASE_NEWER", "数据库由更新版本创建，请恢复匹配版本备份。");
    if (version > 0 && version < 2) this.db.exec(`VACUUM INTO '${join(directory, `migration-v${version}-${Date.now()}.sqlite`).replaceAll("'", "''")}'`);
    this.db.exec(`BEGIN;
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,folder_id TEXT NOT NULL,uid_validity TEXT NOT NULL,uid INTEGER NOT NULL,message_id TEXT,thread_id TEXT,date TEXT NOT NULL,subject TEXT NOT NULL,seen INTEGER NOT NULL DEFAULT 0,starred INTEGER NOT NULL DEFAULT 0,has_attachment INTEGER NOT NULL DEFAULT 0,body_loaded INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,UNIQUE(account_id,folder_id,uid_validity,uid));
      CREATE INDEX IF NOT EXISTS messages_folder ON messages(account_id,folder_id,date DESC,id);
      CREATE INDEX IF NOT EXISTS messages_date ON messages(date DESC,id);
      CREATE INDEX IF NOT EXISTS messages_thread ON messages(account_id,thread_id,date);
      CREATE INDEX IF NOT EXISTS messages_mid ON messages(account_id,message_id);
      CREATE INDEX IF NOT EXISTS messages_coverage ON messages(body_loaded);
      CREATE TABLE IF NOT EXISTS message_attributes(id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,snoozed_until TEXT,from_text TEXT,to_text TEXT,cc_text TEXT);
      CREATE INDEX IF NOT EXISTS attributes_snoozed ON message_attributes(snoozed_until,id);
      CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(message_id UNINDEXED,content,tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
      INSERT OR IGNORE INTO message_attributes SELECT id,json_extract(data,'$.snoozedUntil'),coalesce((SELECT group_concat(coalesce(json_extract(value,'$.address'),'')||' '||coalesce(json_extract(value,'$.name'),''),' ') FROM json_each(data,'$.from')),''),coalesce((SELECT group_concat(coalesce(json_extract(value,'$.address'),'')||' '||coalesce(json_extract(value,'$.name'),''),' ') FROM json_each(data,'$.to')),''),coalesce((SELECT group_concat(coalesce(json_extract(value,'$.address'),'')||' '||coalesce(json_extract(value,'$.name'),''),' ') FROM json_each(data,'$.cc')),'') FROM messages;
      PRAGMA user_version=2; COMMIT;`);
  }
  transaction(fn) { if (this.inTransaction) return fn(); this.db.exec("BEGIN IMMEDIATE"); this.inTransaction = true; try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); this.conversationCache?.clear(); throw error; } finally { this.inTransaction = false; } }
  get(kind, key) { const row = this.db.prepare("SELECT data,revision FROM entities WHERE kind=? AND id=?").get(kind, key); return row ? { ...JSON.parse(row.data), revision: row.revision } : null; }
  put(kind, value, expectedRevision) {
    const key = value.id || id(), old = this.get(kind, key);
    if (expectedRevision !== undefined) requireValue((old?.revision || 0) === expectedRevision, "CONFLICT", "内容已更新，请刷新后重试。");
    const revision = (old?.revision || 0) + 1, next = { ...value, id: key, revision, updatedAt: now() };
    this.db.prepare("INSERT INTO entities VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated=excluded.updated").run(kind, key, revision, JSON.stringify(next), next.updatedAt);
    return next;
  }
  list(kind) { return this.db.prepare("SELECT data FROM entities WHERE kind=? ORDER BY updated DESC").all(kind).map((row) => JSON.parse(row.data)); }
  remove(kind, key) { this.db.prepare("DELETE FROM entities WHERE kind=? AND id=?").run(kind, key); }
  log(kind, data) { this.db.prepare("INSERT INTO logs(time,kind,data) VALUES(?,?,?)").run(now(), kind, JSON.stringify(data)); }
  logs(limit = 100) { return this.db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?").all(bounded(limit)).map((r) => ({ ...r, data: JSON.parse(r.data) })); }
  message(key) { const row = this.db.prepare("SELECT data FROM messages WHERE id=?").get(key); return row ? JSON.parse(row.data) : null; }
  conversations(accountId) {
    const version = `${this.conversationVersion}:${this.db.prepare("PRAGMA data_version").get().data_version}`;
    this.conversationCache ||= new Map();
    if (this.conversationCache.get(accountId)?.version !== version) {
      const messages = this.db.prepare("SELECT id,account_id AS accountId,message_id AS messageId,subject,json_extract(data,'$.references') AS refs,json_extract(data,'$.inReplyTo') AS inReplyTo FROM messages" + (accountId ? " WHERE account_id=?" : "") + " ORDER BY id").all(...(accountId ? [accountId] : [])).map(({ refs, ...message }) => ({ ...message, references: JSON.parse(refs || "[]") }));
      this.conversationCache.set(accountId, { version, ...buildConversations(messages) });
    }
    return this.conversationCache.get(accountId);
  }
  conversationId(message) { return this.conversations(message.accountId).byMessage.get(message.id); }
  mailVersion(at = now()) { const next = this.db.prepare("SELECT snoozed_until FROM message_attributes WHERE snoozed_until>? ORDER BY snoozed_until LIMIT 1").get(at)?.snoozed_until || ""; return `${this.messageVersion || 0}:${this.db.prepare("PRAGMA data_version").get().data_version}:${next}`; }
  messageLocations(message) {
    return this.messageLocationMap([message.id]).get(message.id) || [];
  }
  messageLocationMap(ids) {
    const result = new Map(ids.map((key) => [key, []])); if (!ids.length) return result;
    const rows = this.db.prepare(`SELECT source.id AS source_id,coalesce(related.id,source.id) AS id,coalesce(related.folder_id,source.folder_id) AS folder_id
      FROM messages source LEFT JOIN messages related ON source.message_id<>'' AND related.account_id=source.account_id AND related.message_id=source.message_id
      JOIN entities folder ON folder.kind='folders' AND folder.id=coalesce(related.folder_id,source.folder_id)
      WHERE source.id IN (${ids.map(() => "?").join(",")}) AND coalesce(json_extract(folder.data,'$.missing'),0)=0 AND coalesce(json_extract(folder.data,'$.deleted'),0)=0
      ORDER BY source.id,related.id=source.id DESC,related.folder_id,related.id`).all(...ids);
    for (const row of rows) result.get(row.source_id).push({ id: row.id, folderId: row.folder_id });
    return result;
  }
  location(account, folder, validity, uid) { const r = this.db.prepare("SELECT data FROM messages WHERE account_id=? AND folder_id=? AND uid_validity=? AND uid=?").get(account, folder, String(validity), Number(uid)); return r ? JSON.parse(r.data) : null; }
  upsertMessage(value) {
    const old = this.location(value.accountId, value.folderId, value.uidValidity, value.uid) || (value.id ? this.message(value.id) : null);
    const next = { ...old, ...value, id: old?.id || value.id || id(), uidValidity: String(value.uidValidity), revision: (old?.revision || 0) + 1 };
    const flags = next.flags || [];
    next.seen = flags.includes("\\Seen"); next.starred = flags.includes("\\Flagged");
    next.threadId = next.references?.[0] || next.threadId || next.inReplyTo || next.messageId || next.id;
    next.date ||= now(); next.subject ||= "（无主题）";
    const comparable = ({ revision, ...rest }) => JSON.stringify(rest);
    if (old && comparable(old) === comparable(next)) return old;
    const indexText = (m) => [m.subject, m.text, ...(m.from || []).map((x) => `${x.name || ""} ${x.address}`), ...(m.to || []).map((x) => `${x.name || ""} ${x.address}`), ...(m.attachments || []).map((x) => x.filename)].join(" ");
    const content = indexText(next), indexChanged = !old || indexText(old) !== content;
    this.transaction(() => {
      this.db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,folder_id=excluded.folder_id,uid_validity=excluded.uid_validity,uid=excluded.uid,message_id=excluded.message_id,thread_id=excluded.thread_id,date=excluded.date,subject=excluded.subject,seen=excluded.seen,starred=excluded.starred,has_attachment=excluded.has_attachment,body_loaded=excluded.body_loaded,data=excluded.data`).run(next.id, next.accountId, next.folderId, next.uidValidity, Number(next.uid), next.messageId || null, next.threadId, next.date, next.subject, +next.seen, +next.starred, +(next.attachments?.length > 0), +!!next.bodyLoaded, JSON.stringify(next));
      if (indexChanged) {
        const rowid = this.db.prepare("SELECT rowid FROM messages WHERE id=?").get(next.id).rowid;
        if (old) this.db.prepare("DELETE FROM message_search WHERE rowid=?").run(rowid);
        this.db.prepare("INSERT INTO message_search(rowid,message_id,content) VALUES(?,?,?)").run(rowid, next.id, searchTokens(content));
      }
      const addressText = (items) => (items || []).map((a) => `${a.address || ""} ${a.name || ""}`).join(" ").toLowerCase();
      this.db.prepare("INSERT INTO message_attributes VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET snoozed_until=excluded.snoozed_until,from_text=excluded.from_text,to_text=excluded.to_text,cc_text=excluded.cc_text").run(next.id, next.snoozedUntil || null, addressText(next.from), addressText(next.to), addressText(next.cc));
    });
    this.messageVersion++;
    if (!old || conversationHeaders(old) !== conversationHeaders(next)) this.conversationVersion++;
    return next;
  }
  deleteMessage(key) { this.transaction(() => { this.db.prepare("DELETE FROM message_search WHERE rowid=(SELECT rowid FROM messages WHERE id=?)").run(key); if (this.db.prepare("DELETE FROM messages WHERE id=?").run(key).changes) { this.messageVersion++; this.conversationVersion++; } }); }
  search(query = {}) {
    const clauses = [], params = [];
    const add = (sql, value) => { clauses.push(sql); params.push(value); };
    if (query.accountId) add("m.account_id=?", query.accountId);
    if (query.folderId) add("m.folder_id=?", query.folderId);
    const threadAccount = query.accountId || (query.threadId?.startsWith("conversation:") ? this.message(query.threadId.slice(13))?.accountId : undefined);
    const conversation = query.threadId?.startsWith("conversation:") && this.conversations(threadAccount).groups.get(query.threadId);
    if (conversation) { add("m.id IN (SELECT value FROM json_each(?))", JSON.stringify(conversation)); clauses.push("m.folder_id IN (SELECT id FROM entities WHERE kind='folders' AND coalesce(json_extract(data,'$.missing'),0)=0 AND coalesce(json_extract(data,'$.deleted'),0)=0)"); }
    else if (query.threadId) add("m.thread_id=?", query.threadId);
    if (query.after) add("m.date>=?", query.after);
    if (query.before) add("m.date<?", query.before);
    if (query.seen !== undefined) add("m.seen=?", +!!query.seen);
    if (query.starred !== undefined) add("m.starred=?", +!!query.starred);
    if (query.hasAttachment !== undefined) add("m.has_attachment=?", +!!query.hasAttachment);
    if (query.folderIds?.length) { clauses.push(`m.folder_id IN (${query.folderIds.map(() => "?").join(",")})`); params.push(...query.folderIds); }
    if (query.q) { const q = queryTokens(query.q); if (q) add("m.rowid IN (SELECT rowid FROM message_search WHERE message_search MATCH ?)", q); }
    for (const field of ["from", "to", "cc"]) if (query[field]) add(`m.id IN (SELECT id FROM message_attributes WHERE ${field}_text LIKE ? ESCAPE '\\')`, `%${String(query[field]).toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
    if (query.subject) add("lower(m.subject) LIKE ? ESCAPE '\\'", `%${query.subject.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
    if (query.label) add("EXISTS(SELECT 1 FROM json_each(m.data,'$.labels') l WHERE l.value=?)", query.label);
    if (!query.includeSnoozed) { clauses.push("m.id NOT IN (SELECT id FROM message_attributes WHERE snoozed_until>?)"); params.push(now()); }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    let total = this.db.prepare("SELECT count(*) AS n FROM messages m" + where).get(...params).n;
    const limit = bounded(query.limit), offset = Math.max(0, Math.trunc(Number(query.offset) || 0));
    let rows, current;
    if (conversation) {
      const unique = new Map();
      for (const row of this.db.prepare("SELECT m.data FROM messages m" + where + " ORDER BY m.date DESC,m.id").all(...params)) { const message = JSON.parse(row.data), key = message.messageId || message.id; if (!unique.has(key) || message.id === query.preferredId) unique.set(key, message); }
      const messages = [...unique.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.id.localeCompare(b.id));
      total = messages.length; current = messages.find((message) => message.id === query.preferredId);
      rows = messages.slice(offset, offset + limit).map((message) => ({ data: JSON.stringify(message) }));
    } else rows = this.db.prepare("SELECT m.data FROM messages m" + where + " ORDER BY m.date DESC,m.id LIMIT ? OFFSET ?").all(...params, limit, offset);
    const version = this.mailVersion();
    if (this.coverageCache?.version !== version) this.coverageCache = { version, value: { ...this.db.prepare("SELECT count(*) AS total,coalesce(sum(body_loaded),0) AS indexed FROM messages").get() } };
    const coverage = this.coverageCache.value;
    const threads = (rows.length || current) && (conversation || query.groupThreads) ? this.conversations(threadAccount).byMessage : null;
    const summary = ({ html, text, rawHeaders, ...m }) => ({ ...m, threadId: threads?.get(m.id) || m.threadId, snippet: (text || "").slice(0, 180) });
    const items = rows.map((r) => summary(JSON.parse(r.data))), locations = this.messageLocationMap([...new Set([...items.map((m) => m.id), ...(current ? [current.id] : [])])]);
    return { items: items.map((m) => ({ ...m, locations: locations.get(m.id) })), total, offset, limit, nextOffset: offset + limit < total ? offset + limit : null, coverage, ...(conversation ? { threadId: query.threadId, current: current ? { ...summary(current), locations: locations.get(current.id) } : undefined } : {}) };
  }
  folderMessages(folderId) { return this.db.prepare("SELECT data FROM messages WHERE folder_id=? ORDER BY uid").all(folderId).map((r) => JSON.parse(r.data)); }
  async backup(path) { await backup(this.db, path); return path; }
  close() { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); this.db.close(); }
}

import { requireValue } from "./util.mjs";

const RESOURCES = new Set(["accounts", "folders", "settings", "drafts", "previews", "notifications", "tasks", "contacts", "calendars", "events", "rules", "labels", "saved-searches", "signatures", "templates", "jobs", "logs"]);
export function uiState(service, args, context, publicValue) {
  const { store } = service, versions = store.resourceVersions(), changes = {}, known = args.epoch === service.viewEpoch ? args.versions || {} : {};
  requireValue(Array.isArray(args.resources) && args.resources.every((key) => RESOURCES.has(key)), "INVALID_RESOURCES", "界面资源请求无效。");
  for (const key of new Set(args.resources)) {
    const version = key === "accounts" ? `${versions.accounts || 0}:${versions.credentials || 0}` : versions[key] || 0;
    versions[key] = version;
    if (known[key] === version) continue;
    if (key === "settings") changes[key] = service.settings();
    else if (key === "logs") changes[key] = store.logs(30);
    else if (key === "drafts") changes[key] = store.db.prepare("SELECT json_remove(data,'$.text','$.html','$.quotedText','$.rawPath','$.attachments') AS data FROM entities WHERE kind='drafts' AND json_extract(data,'$.status') NOT IN ('discarded') ORDER BY updated DESC").all().map((row) => JSON.parse(row.data));
    else if (key === "events") changes[key] = store.db.prepare("SELECT id,revision FROM entities WHERE kind='events' AND coalesce(json_extract(data,'$.deleted'),0)=0").all();
    else {
      let items = store.list(key).filter((item) => !item.deleted);
      if (key === "accounts") items = items.map((a) => ({ ...a, credentialConfigured: !!store.get("credentials", a.id) }));
      if (key === "notifications") items = items.filter((n) => !n.dismissed).slice(0, 30).map((n) => { const { messageIds, ...data } = n.data || {}; return { ...n, data: { ...data, ...(Array.isArray(messageIds) ? { messageId: messageIds[0], count: messageIds.length } : {}) } }; });
      if (key === "previews") items = items.filter((p) => p.status === "pending");
      if (key === "jobs") items = items.slice(0, 50);
      changes[key] = items;
    }
  }
  const summaryKey = JSON.stringify([versions.messages, versions.tasks, versions.folders]);
  if (service.uiSummary?.key !== summaryKey) service.uiSummary = { key: summaryKey, value: {
    ...store.db.prepare("SELECT count(*) AS total,coalesce(sum(body_loaded),0) AS indexed,coalesce(sum(starred),0) AS starred,coalesce(sum(seen=0),0) AS unread FROM messages").get(),
    tasks: store.db.prepare("SELECT count(*) AS n FROM entities WHERE kind='tasks' AND coalesce(json_extract(data,'$.deleted'),0)=0 AND coalesce(json_extract(data,'$.done'),0)=0").get().n
  } };
  return publicValue({ epoch: service.viewEpoch, versions: Object.fromEntries(args.resources.map((key) => [key, versions[key] || 0])), changes, summary: service.uiSummary.value, mailVersion: store.mailVersion(), contactVersion: versions.contacts || 0, workbench: service.workbenchView(context.sessionId) });
}

export function resourcePage(store, { kind, q = "", offset = 0, limit = 50, targetId }) {
  requireValue(kind === "contacts", "INVALID_RESOURCE", "不支持的分页资源。");
  requireValue(typeof q === "string" && q.length <= 500 && Number.isInteger(offset) && offset >= 0 && [25, 50, 100].includes(limit), "INVALID_QUERY", "分页条件无效。");
  const query = `%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`, where = "kind=? AND coalesce(json_extract(data,'$.deleted'),0)=0 AND lower(coalesce(json_extract(data,'$.name'),'')||' '||coalesce(json_extract(data,'$.email'),'')||' '||coalesce(json_extract(data,'$.group'),'')) LIKE ? ESCAPE '\\'";
  if (targetId !== undefined) {
    requireValue(typeof targetId === "string" && targetId.length <= 200, "INVALID_QUERY", "联系人标识无效。");
    const target = store.get(kind, targetId);
    requireValue(target && !target.deleted, "NOT_FOUND", "联系人不存在。");
    const rank = store.db.prepare(`SELECT count(*) AS n FROM entities WHERE ${where} AND (updated>? OR (updated=? AND id<?))`).get(kind, query, target.updatedAt, target.updatedAt, targetId).n;
    offset = Math.floor(rank / limit) * limit;
  }
  const total = store.db.prepare(`SELECT count(*) AS n FROM entities WHERE ${where}`).get(kind, query).n;
  return { items: store.db.prepare(`SELECT data FROM entities WHERE ${where} ORDER BY updated DESC,id LIMIT ? OFFSET ?`).all(kind, query, limit, offset).map((row) => JSON.parse(row.data)), total, offset, nextOffset: offset + limit < total ? offset + limit : null };
}

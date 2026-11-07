import { readdir, stat, lstat, realpath, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { id, requireValue } from "./util.mjs";

async function directoryBytes(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") return 0; throw e; }
  let bytes = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size;
  }
  return bytes;
}
async function temporaryFile(service, file) {
  requireValue(file?.exportKind === "temporary", "PROTECTED_FILE", "此文件未登记为临时导出，不能清理。");
  const root = await realpath(join(service.directory, "exports")), path = await realpath(file.path), info = await lstat(file.path);
  requireValue(!info.isSymbolicLink() && info.isFile() && path.startsWith(root + sep), "PROTECTED_FILE", "文件不在临时导出目录内。");
  return { path, size: info.size, modified: info.mtimeMs };
}
export async function storageInfo(service) {
  const sizes = {};
  for (const key of ["raw", "blobs", "exports", "restored"]) sizes[key] = await directoryBytes(join(service.directory, key));
  sizes.database = 0;
  for (const suffix of ["", "-wal", "-shm"]) try { sizes.database += (await stat(service.store.path + suffix)).size; } catch (e) { if (e.code !== "ENOENT") throw e; }
  const temporary = [];
  for (const file of service.store.list("exports")) if (file.exportKind === "temporary") {
    try { const info = await temporaryFile(service, file); temporary.push({ id: file.id, filename: file.filename, size: info.size }); }
    catch (e) { if (!["ENOENT", "PROTECTED_FILE"].includes(e.code)) throw e; }
  }
  return { sizes, total: Object.values(sizes).reduce((a, b) => a + b, 0), temporary };
}
export async function cleanupPreview(service, ids) {
  requireValue(Array.isArray(ids) && ids.length > 0 && ids.length <= 1000 && ids.every((key) => typeof key === "string"), "SELECTION_REQUIRED", "请选择需要清理的临时导出。");
  const files = [];
  for (const key of new Set(ids)) { const file = service.store.get("exports", key), info = await temporaryFile(service, file); files.push({ id: key, filename: file.filename, ...info }); }
  service.cleanupPreviews ||= new Map();
  for (const [key, item] of service.cleanupPreviews) if (item.expiresAt <= service.clock()) service.cleanupPreviews.delete(key);
  const token = id(), expiresAt = service.clock() + 600000;
  service.cleanupPreviews.set(token, { files, expiresAt });
  return { id: token, expiresAt, files: files.map(({ path, modified, ...file }) => file), bytes: files.reduce((n, file) => n + file.size, 0) };
}
export async function cleanupConfirm(service, token) {
  const preview = service.cleanupPreviews?.get(token);
  requireValue(preview && preview.expiresAt > service.clock(), "PREVIEW_EXPIRED", "清理预览已过期，请重新预览。");
  service.cleanupPreviews.delete(token);
  for (const file of preview.files) {
    const current = await temporaryFile(service, service.store.get("exports", file.id));
    requireValue(current.path === file.path && current.size === file.size && current.modified === file.modified, "PREVIEW_CHANGED", "文件已变化，请重新预览。");
  }
  let removed = 0, bytes = 0;
  for (const file of preview.files) { await unlink(file.path); service.store.remove("exports", file.id); removed++; bytes += file.size; }
  return { removed, bytes };
}
export function diagnosticInfo(service, version) {
  const errorCodes = new Set(["EAUTH", "ECONNECTION", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "AUTH_FAILED", "AUTHENTICATION_FAILED", "SYNC_FAILED", "BODY_TRUNCATED"]);
  const operations = new Set(["search", "message.read", "thread.read", "drafts.save", "drafts.read", "drafts.reply", "drafts.delete", "drafts.cancel", "accounts.test", "accounts.save", "accounts.sync-settings", "sync", "messages.action", "folders.action", "events.list", "events.save", "resources.list", "resources.save", "resources.delete", "settings.save", "send.preview", "preview.confirm", "ai.generate", "assistant.quick.start", "assistant.quick.read", "assistant.quick.cancel", "assistant.quick.result", "contacts.lookup", "storage.read", "storage.preview", "storage.clean", "diagnostics.read", "diagnostics.export", "backup.create", "backup.restore"]);
  const safeCode = (value) => errorCodes.has(value) ? value : "UNSPECIFIED";
  const versions = service.store.resourceVersions();
  return { version, platform: process.platform, node: process.version,
    coverage: service.store.db.prepare("SELECT count(*) AS total,coalesce(sum(body_loaded),0) AS indexed FROM messages").get(),
    accounts: service.store.list("accounts").filter((a) => !a.local && !a.deleted).map((a, index) => ({ account: index + 1, status: ["connected", "syncing", "error", "disconnected"].includes(a.status) ? a.status : "unknown", enabled: !!a.enabled, autoSync: !a.syncPaused, lastSyncedAt: a.lastSyncedAt || null, error: a.error ? safeCode(a.error.code) : null })),
    timings: (service.operationTimings || []).filter(({ action }) => operations.has(action)).map(({ action, ms, ok }) => ({ action, ms, ok })),
    resources: Object.keys(versions).filter((key) => ["tasks", "contacts", "drafts", "events"].includes(key)).map((kind) => ({ kind, count: service.store.db.prepare("SELECT count(*) AS n FROM entities WHERE kind=? AND coalesce(json_extract(data,'$.deleted'),0)=0").get(kind).n }))
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailService } from "../src/service.mjs";
import { normalizeAccount } from "../src/mail.mjs";
import { visibleFolders, sentFolders, isInboxFolder } from "../src/folders.mjs";

const HUMAN = { kind: "human" };
test("inbox identity uses its role or exact case-insensitive path, preserving nested and similarly named folders", () => {
  for (const folder of [{ role: "\\Inbox", path: "收件箱" }, { path: "INBOX" }, { path: "Inbox" }, { path: "inbox" }]) assert.equal(isInboxFolder(folder), true);
  for (const folder of [undefined, {}, { name: "INBOX", path: "项目" }, { path: "INBOX/项目" }, { path: "项目/INBOX" }, { path: "INBOX Archive" }, { role: "\\Sent", path: "Sent" }]) assert.equal(isInboxFolder(folder), false);
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-mail-folders-")), calls = [];
  const transport = { close: async () => {}, folders: async () => [], folderAction: async (...args) => { calls.push(args); return true; } };
  const service = new MailService({ directory, transport });
  service.store.put("accounts", { ...normalizeAccount({ id: "a", email: "a@example.invalid", imapHost: "127.0.0.1", smtpHost: "127.0.0.1" }), local: true });
  t.after(() => service.stopped ? undefined : service.close());
  return { service, directory, transport, calls };
}

test("folder sorting is natural, stable, non-mutating and handles CJK, counts and paths", () => {
  const folders = [{ id: "10", name: "客户10", path: "项目/客户10", count: 0 }, { id: "2", name: "客户2", path: "项目/客户2", count: 12 }, { id: "b", name: "alpha", path: "工作/alpha" }, { id: "a", name: "Alpha", path: "个人/Alpha", count: 12 }, { id: "missing", name: "消失", missing: true }];
  const before = JSON.stringify(folders), names = visibleFolders(folders).map((f) => f.name);
  assert.ok(names.indexOf("Alpha") < names.indexOf("客户2"));
  assert.ok(names.indexOf("客户2") < names.indexOf("客户10"));
  assert.deepEqual(visibleFolders(folders.slice().reverse()).map((f) => f.id), visibleFolders(folders).map((f) => f.id));
  assert.deepEqual(visibleFolders(folders, "name-desc").map((f) => f.id), visibleFolders(folders).map((f) => f.id).reverse());
  assert.deepEqual(visibleFolders(folders, "count-desc").map((f) => f.count ?? 0), [12, 12, 0, 0]);
  assert.equal(visibleFolders(folders, "name-asc", "  ALPHA ").length, 2);
  assert.deepEqual(visibleFolders(folders, "name-asc", "工作/").map((f) => f.id), ["b"]);
  assert.deepEqual(visibleFolders(folders, "name-asc", "不存在"), []);
  assert.equal(JSON.stringify(folders), before);
});

test("sent scope respects explicit per-account mappings and never treats a named Sent folder as a role", async (t) => {
  const { service } = await fixture(t);
  const accounts = [{ id: "a", folders: { sent: "mapped" } }, { id: "b" }, { id: "c", folders: { sent: "gone" } }];
  const folders = [{ id: "mapped", accountId: "a", path: "发信" }, { id: "wrong", accountId: "a", path: "Sent", role: "\\Sent" }, { id: "role", accountId: "b", path: "Sent Items", role: "\\Sent" }, { id: "name", accountId: "b", path: "Sent" }, { id: "gone", accountId: "c", path: "已发送", missing: true }];
  assert.deepEqual(sentFolders(accounts, folders).map((f) => f.id), ["mapped", "role"]);
  for (const a of accounts) service.store.put("accounts", a);
  for (const f of folders) {
    service.store.put("folders", f);
    service.store.upsertMessage({ accountId: f.accountId, folderId: f.id, uidValidity: "1", uid: 1, subject: f.id, bodyLoaded: true, text: "验收正文", flags: [] });
  }
  assert.deepEqual((await service.invoke({ action: "search", sent: true })).items.map((m) => m.subject).sort(), ["mapped", "role"]);
  assert.equal((await service.invoke({ action: "search", sent: true, accountId: "b" })).total, 1);
  assert.equal((await service.invoke({ action: "search", sent: true, accountId: "c" })).total, 0);
  assert.equal((await service.invoke({ action: "search", sent: true, q: "不存在" })).total, 0);
  for (const f of folders) service.store.remove("folders", f.id);
  assert.equal((await service.invoke({ action: "search", sent: true })).total, 0);
});

test("folder appearance validates, is human-only, persists and does not invoke IMAP", async (t) => {
  const { service, directory, calls } = await fixture(t);
  service.store.put("folders", { id: "f", accountId: "a", path: "项目", name: "项目", delimiter: "/" });
  await assert.rejects(service.invoke({ action: "folders.color", id: "f", color: "#123456" }), { code: "USER_ACTION_REQUIRED" });
  for (const color of ["red", "#123", "url(x)", null, 123]) await assert.rejects(service.invoke({ action: "folders.color", id: "f", color }, HUMAN), { code: "INVALID_FOLDER_COLOR" });
  await assert.rejects(service.invoke({ action: "settings.save", value: { folderSort: "updated" } }, HUMAN), { code: "INVALID_FOLDER_SORT" });
  await service.invoke({ action: "settings.save", value: { folderSort: "count-desc" } }, HUMAN);
  await service.invoke({ action: "folders.color", id: "f", color: "#7C3AED" }, HUMAN);
  assert.equal(calls.length, 0);
  await service.invoke({ action: "folders.action", id: "f", operation: "rename", path: "新项目" }, HUMAN);
  assert.equal(service.folder("f").color, "#7c3aed");
  const job = await service.invoke({ action: "folders.action", id: "f", operation: "copy", path: "副本", accountId: "a", structureOnly: true }, HUMAN);
  await Promise.all([...service.work.values()]);
  assert.equal(service.store.get("jobs", job.id).status, "completed");
  assert.ok(!service.store.list("folders").find((f) => f.path === "副本").color);
  const backup = await service.backup();
  await service.close();
  const reopened = new MailService({ directory }); t.after(() => reopened.close());
  assert.equal(reopened.folder("f").color, "#7c3aed"); assert.equal(reopened.settings().folderSort, "count-desc");
  const restored = new MailService({ directory: await mkdtemp(join(tmpdir(), "dsh-mail-folders-restore-")) }); t.after(() => restored.close());
  await restored.invoke({ action: "backup.restore", base64: backup.base64 }, HUMAN);
  assert.equal(restored.folder("f").color, "#7c3aed"); assert.equal(restored.settings().folderSort, "count-desc");
  await reopened.invoke({ action: "folders.color", id: "f", color: "" }, HUMAN); assert.equal(reopened.folder("f").color, "");
});

test("a folder color changed during an asynchronous scan survives the scan result", async (t) => {
  const { service, transport } = await fixture(t);
  service.store.put("folders", { id: "f", accountId: "a", path: "INBOX", color: "#2563eb" });
  transport.folders = async () => [{ path: "INBOX", selectable: true }];
  transport.scan = async () => { await service.invoke({ action: "folders.color", id: "f", color: "#15803d" }, HUMAN); return { uids: [], uidValidity: "1" }; };
  await service.syncAccount(service.account("a"));
  assert.equal(service.folder("f").color, "#15803d");
});

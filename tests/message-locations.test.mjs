import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailService } from "../src/service.mjs";
import { Store } from "../src/store.mjs";
import { reconcileState } from "../ui/state.mjs";
import { messageFolderLocations, FOLDER_COLORS, senderAppearance } from "../ui/folder-appearance.mjs";

const HUMAN = { kind: "human" };
const raw = Buffer.from("From: Client <client@example.invalid>\r\nTo: me@example.invalid\r\nMessage-ID: <locations@example.invalid>\r\nSubject: Location test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic folder membership fixture.\r\n");
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-mail-locations-"));
  const service = new MailService({ directory, transport: { close: async () => {} } });
  t.after(() => service.stopped ? undefined : service.close());
  const imported = await service.importMail({ base64: raw.toString("base64"), folderName: "收件箱" });
  const source = service.message(imported.ids[0]);
  return { service, directory, source };
}

test("locations follow actual same-message copies and moves, excluding other messages in a thread and other accounts", async (t) => {
  const { service, source } = await fixture(t);
  const create = (path, accountId = "local") => service.folderOperation({ operation: "create", accountId, path }, HUMAN);
  const a = await create("项目 A"), b = await create("项目 B");
  service.store.upsertMessage({ ...source, id: "different-message", uid: 99, messageId: "<different@example.invalid>", threadId: source.threadId, folderId: b.id });
  assert.deepEqual((await service.invoke({ action: "message.read", id: source.id })).locations, [{ id: source.id, folderId: source.folderId }]);
  const copied = await service.messageAction(source.id, { operation: "copy", destinationId: a.id });
  const locations = () => service.invoke({ action: "message.read", id: source.id }).then((m) => m.locations);
  assert.deepEqual(new Set((await locations()).map((l) => l.folderId)), new Set([source.folderId, a.id]));
  await service.messageAction(copied.messageId, { operation: "move", destinationId: b.id });
  assert.deepEqual(new Set((await locations()).map((l) => l.folderId)), new Set([source.folderId, b.id]));
  service.store.put("accounts", { id: "other", local: true, enabled: true });
  const other = await create("跨账号", "other"); await service.messageAction(source.id, { operation: "copy", destinationId: other.id });
  assert.equal((await locations()).length, 2);
  service.store.deleteMessage(copied.messageId);
  assert.deepEqual(await locations(), [{ id: source.id, folderId: source.folderId }]);
});

test("missing Message-ID never groups by subject or thread; missing folders are not shown as current locations", async (t) => {
  const { service, source } = await fixture(t);
  const current = service.store.upsertMessage({ ...source, messageId: null });
  service.store.upsertMessage({ ...current, id: "no-mid-copy", uid: 44 });
  assert.deepEqual((await service.invoke({ action: "message.read", id: current.id })).locations, [{ id: current.id, folderId: current.folderId }]);
  service.store.put("folders", { ...service.folder(source.folderId), missing: true });
  assert.deepEqual((await service.invoke({ action: "message.read", id: current.id })).locations, []);
});

test("inbox search rows include all actual same-account locations before opening, and update after transfers", async (t) => {
  const { service, source } = await fixture(t);
  service.store.put("folders", { ...service.folder(source.folderId), role: "\\Inbox" });
  const a = await service.folderOperation({ operation: "create", accountId: "local", path: "项目 A" }, HUMAN), b = await service.folderOperation({ operation: "create", accountId: "local", path: "项目 B" }, HUMAN);
  const first = await service.messageAction(source.id, { operation: "copy", destinationId: a.id });
  await service.messageAction(source.id, { operation: "copy", destinationId: b.id });
  service.store.put("folders", { id: "other-account-folder", accountId: "other", path: "Other" });
  service.store.upsertMessage({ ...source, id: "other-account-copy", accountId: "other", folderId: "other-account-folder", uid: 81 });
  service.store.upsertMessage({ ...source, id: "different-mid", messageId: "<different@example.invalid>", folderId: a.id, uid: 82 });
  const row = async () => { const result = await service.invoke({ action: "search", inbox: true }); assert.equal(result.total, 1); assert.equal(result.items[0].html, undefined); return result.items[0]; };
  assert.deepEqual((await row()).locations, (await service.invoke({ action: "message.read", id: source.id })).locations);
  assert.deepEqual(messageFolderLocations(await row(), service.state().folders).map(({ folder }) => folder.id), [a.id, b.id]);
  const filtered = await service.invoke({ action: "search", inbox: true, q: "Synthetic", limit: 1 }); assert.deepEqual(filtered.items[0].locations, (await row()).locations); assert.equal(filtered.total, 1);
  service.store.put("folders", { ...a, missing: true }); assert.deepEqual(messageFolderLocations(await row(), service.state().folders).map(({ folder }) => folder.id), [b.id]);
  service.store.deleteMessage(first.messageId); service.store.put("folders", { ...b, deleted: true }); assert.deepEqual(messageFolderLocations(await row(), service.state().folders), []);
  service.store.upsertMessage({ ...source, messageId: null }); assert.deepEqual((await row()).locations, [{ id: source.id, folderId: source.folderId }]);
});

test("folder indicators exclude inbox, deduplicate positions and keep a stable order; expanded colors preserve sender colors", () => {
  const folders = [{ id: "i", path: "INBOX" }, { id: "b", path: "项目 B", color: "#d97706" }, { id: "a", path: "项目 A", color: "#15803d" }, { id: "gone", path: "已移除", missing: true }];
  const message = { id: "inbox-instance", folderId: "i", locations: [{ id: "inbox-instance", folderId: "i" }, { id: "b-copy", folderId: "b" }, { id: "a-copy", folderId: "a" }, { id: "a-copy-2", folderId: "a" }, { id: "gone-copy", folderId: "gone" }] };
  const positions = messageFolderLocations(message, folders); assert.deepEqual(positions.map(({ id, folder }) => [id, folder.id]), [["a-copy", "a"], ["b-copy", "b"]]);
  assert.deepEqual(messageFolderLocations({ id: "i", folderId: "i" }, folders), []);
  assert.equal(messageFolderLocations({ id: "b-copy", folderId: "b" }, folders)[0].folder.id, "b");
  assert.equal(FOLDER_COLORS.length, 24); assert.equal(new Set(FOLDER_COLORS.map(([, color]) => color)).size, 24); assert.ok(FOLDER_COLORS.every(([, color]) => /^#[0-9a-f]{6}$/i.test(color)));
  for (const name of ["Yeung Sin Hang", "项目团队", "佐藤 美咲"]) { const hash = [...name].reduce((n, c) => (n * 31 + c.codePointAt(0)) >>> 0, 0); assert.equal(senderAppearance({ from: [{ name }] }).color, FOLDER_COLORS[hash % 8][1]); }
});

test("remote-image preference validates and persists across restart and backup", async (t) => {
  const { service, directory } = await fixture(t);
  assert.equal(service.settings().loadRemoteImages, false);
  await assert.rejects(service.invoke({ action: "settings.save", value: { loadRemoteImages: "true" } }, HUMAN), { code: "INVALID_IMAGE_PREFERENCE" });
  await service.invoke({ action: "settings.save", value: { loadRemoteImages: true } }, HUMAN);
  const backup = await service.backup(); await service.close();
  const reopened = new MailService({ directory }); t.after(() => reopened.close()); assert.equal(reopened.settings().loadRemoteImages, true);
  const restored = new MailService({ directory: await mkdtemp(join(tmpdir(), "dsh-mail-images-restore-")) }); t.after(() => restored.close());
  await restored.invoke({ action: "backup.restore", base64: backup.base64 }, HUMAN); assert.equal(restored.settings().loadRemoteImages, true);
});

test("unchanged polls preserve references, while changed rows and collections still propagate", () => {
  const previous = { mailVersion: "1:1", folders: [{ id: "f", color: "#123456" }], events: [{ id: "e", title: "事件" }], settings: { loadRemoteImages: false } };
  assert.equal(reconcileState(previous, structuredClone(previous)), previous);
  const next = reconcileState(previous, { ...structuredClone(previous), folders: [{ id: "f", color: "#7c3aed" }] });
  assert.notEqual(next.folders, previous.folders); assert.equal(next.events, previous.events); assert.equal(next.settings, previous.settings);
  const added = reconcileState(next, { ...structuredClone(next), events: [...next.events, { id: "new", title: "新增" }] });
  assert.equal(added.events[0], next.events[0]); assert.notEqual(added.events, next.events);
});

test("mail version and coverage invalidate on real mutations, while no-op writes stay stable", async (t) => {
  const { service, source, directory } = await fixture(t), store = service.store, version = service.state().mailVersion;
  store.upsertMessage(source); assert.equal(service.state().mailVersion, version);
  store.search({}); const cached = store.coverageCache;
  store.search({ q: "Synthetic" }); assert.equal(store.coverageCache, cached);
  const pending = store.upsertMessage({ ...source, id: "pending", uid: 22, bodyLoaded: false, text: "" });
  assert.notEqual(service.state().mailVersion, version); assert.deepEqual(store.search({}).coverage, { total: 2, indexed: 1 });
  store.upsertMessage({ ...pending, text: "正文", bodyLoaded: true }); assert.deepEqual(store.search({}).coverage, { total: 2, indexed: 2 });
  store.deleteMessage(pending.id); assert.deepEqual(store.search({}).coverage, { total: 1, indexed: 1 });
  const external = new Store(directory); t.after(() => external.close());
  const beforeExternal = service.state().mailVersion;
  external.upsertMessage({ ...source, id: "external", uid: 23 });
  assert.notEqual(service.state().mailVersion, beforeExternal); assert.deepEqual(store.search({}).coverage, { total: 2, indexed: 2 });
  store.upsertMessage({ ...source, snoozedUntil: "2099-01-01T00:00:00.000Z" });
  assert.equal(store.mailVersion("2098-12-31T23:59:59.000Z"), store.mailVersion("2098-12-31T23:59:59.500Z"));
  assert.notEqual(store.mailVersion("2098-12-31T23:59:59.000Z"), store.mailVersion("2099-01-01T00:00:00.000Z"), "A snoozed mail becoming due invalidates the list without unconditional searches.");
});

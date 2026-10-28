import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailService } from "../src/service.mjs";

async function fixture(t) {
  let clock = Date.now();
  const service = new MailService({ directory: await mkdtemp(join(tmpdir(), "dsh-mail-view-")), clock: () => clock, transport: { close: async () => {} } }); t.after(() => service.close());
  service.store.put("accounts", { id: "local", local: true, enabled: true, email: "me@example.invalid" });
  service.store.put("folders", { id: "inbox", accountId: "local", path: "INBOX", role: "\\Inbox" });
  for (let i = 1; i <= 3; i++) service.store.upsertMessage({ id: `m${i}`, accountId: "local", folderId: "inbox", uidValidity: "1", uid: i, subject: `项目报价 ${i}`, text: "测试正文", bodyLoaded: true, from: [{ address: "client@example.invalid" }], to: [], cc: [], attachments: [], flags: i === 3 ? ["\\Seen"] : [] });
  return { service, advance: (ms) => clock += ms };
}
const agent = { kind: "agent", sessionId: "session-a" }, human = { kind: "human", sessionId: "session-a" };

test("agent searches queue the exact filter for their own workbench, including empty results", async (t) => {
  const { service } = await fixture(t);
  const result = await service.invoke({ action: "search", inbox: true, q: "报价", seen: false, limit: 1, offset: 1 }, agent);
  assert.equal(result.total, 2); assert.equal(result.items.length, 1); assert.equal(result.workbench.status, "queued");
  const command = await service.invoke({ action: "workbench.state" }, human);
  assert.deepEqual(command.query, { q: "报价", inbox: true, seen: false, offset: 1, limit: 1 }); assert.equal(command.sessionId, agent.sessionId); assert.equal(command.id, result.workbench.id);
  assert.equal((await service.invoke({ action: "state" }, human)).workbench.id, command.id);
  assert.equal((await service.invoke({ action: "state" }, { kind: "human", sessionId: "other" })).workbench, null);
  assert.equal((await service.invoke({ action: "state" }, { kind: "human" })).workbench, null);
  await service.invoke({ action: "search", q: "不存在的邮件" }, agent);
  const empty = await service.invoke({ action: "workbench.state" }, human); assert.ok(empty.sequence > command.sequence); assert.equal(empty.epoch, command.epoch); assert.equal(empty.query.q, "不存在的邮件");
});

test("internal searches and UI refreshes do not move the workbench; acknowledgements cannot discard newer commands", async (t) => {
  const { service, advance } = await fixture(t);
  await service.invoke({ action: "search", q: "报价" }, agent); const first = await service.invoke({ action: "workbench.state" }, human);
  await service.invoke({ action: "search", q: "测试正文", display: false }, agent); await service.invoke({ action: "search", q: "别的条件" }, human);
  assert.equal((await service.invoke({ action: "workbench.state" }, human)).id, first.id);
  await service.invoke({ action: "search", seen: true }, agent); const second = await service.invoke({ action: "workbench.state" }, human);
  assert.equal((await service.invoke({ action: "workbench.ack", id: first.id }, human)).acknowledged, false); assert.equal((await service.invoke({ action: "workbench.state" }, human)).id, second.id);
  assert.equal((await service.invoke({ action: "workbench.ack", id: second.id }, human)).acknowledged, true); assert.equal(await service.invoke({ action: "workbench.state" }, human), null);
  await service.invoke({ action: "search", q: "报价" }, agent); advance(6 * 60000); assert.equal(await service.invoke({ action: "workbench.state" }, human), null);
});

test("opening a mail targets the correct folder without fetching or marking it read, and UI acknowledgements are human-only", async (t) => {
  const { service } = await fixture(t);
  const result = await service.invoke({ action: "workbench.show", id: "m1" }, agent); assert.equal(result.status, "queued");
  const command = await service.invoke({ action: "workbench.state" }, human); assert.equal(command.messageId, "m1"); assert.deepEqual(command.query, { accountId: "local", folderId: "inbox" }); assert.equal(service.message("m1").seen, false);
  await assert.rejects(service.invoke({ action: "workbench.show", id: "missing" }, agent), { code: "MESSAGE_NOT_FOUND" });
  await assert.rejects(service.invoke({ action: "workbench.show", id: "m1" }), { code: "WORKBENCH_SESSION_REQUIRED" });
  for (const action of ["workbench.state", "workbench.ack"]) await assert.rejects(service.invoke({ action, id: command.id, kind: "human" }, agent), { code: "USER_ACTION_REQUIRED" });
});

test("invalid UI filter values cannot queue commands, and auxiliary reads never open a mail", async (t) => {
  const { service } = await fixture(t);
  for (const query of [{ q: {} }, { seen: "false" }, { offset: -1 }, { limit: Infinity }]) await assert.rejects(service.invoke({ action: "search", ...query }, agent), { code: "INVALID_WORKBENCH_QUERY" });
  assert.equal(await service.invoke({ action: "workbench.state" }, human), null);
  await service.invoke({ action: "message.read", id: "m1", display: false }, agent); await service.invoke({ action: "thread.read", id: "m1", display: false }, agent);
  assert.equal(await service.invoke({ action: "workbench.state" }, human), null);
  const result = await service.invoke({ action: "search", q: "报价" }); assert.equal(result.workbench, undefined);
});


test("reads, drafts and send previews open their exact content while Agent confirmation stays forbidden", async (t) => {
  const { service } = await fixture(t);
  const view = () => service.invoke({ action: "workbench.state" }, human);
  await service.invoke({ action: "message.read", id: "m1" }, agent); assert.equal((await view()).messageId, "m1");
  const draft = await service.invoke({ action: "drafts.save", draft: { accountId: "local", to: "client@example.invalid", subject: "报价回复", text: "周五交付" } }, agent);
  assert.equal((await view()).draftId, draft.id);
  const changed = await service.invoke({ action: "drafts.save", draft: { id: draft.id, revision: draft.revision, text: "周六交付" } }, agent); assert.equal((await view()).draftId, changed.id);
  const preview = await service.invoke({ action: "send.preview", id: draft.id }, agent); assert.equal((await view()).previewId, preview.id); assert.equal(service.store.get("drafts", draft.id).status, "draft");
  await assert.rejects(service.invoke({ action: "preview.confirm", id: preview.id, confirmed: true }, agent), { code: "USER_ACTION_REQUIRED" });
  const reply = await service.invoke({ action: "drafts.reply", id: "m1", mode: "replyAll" }, agent); assert.equal((await view()).draftId, reply.id);
  await service.invoke({ action: "drafts.delete", id: reply.id }, agent); assert.equal((await view()).section, "drafts");
});

test("tasks, contacts, calendars, rules, invitations and exports present on their corresponding pages", async (t) => {
  const { service } = await fixture(t), view = () => service.invoke({ action: "workbench.state" }, human);
  for (const [kind, value] of [["tasks", { title: "核对报价", sourceMessageId: "m1" }], ["contacts", { name: "客户", email: "client@example.invalid" }], ["signatures", { name: "签名", text: "谢谢" }]]) {
    const result = await service.invoke({ action: "resources.save", kind, value }, agent); assert.equal((await view()).page, kind === "signatures" ? "settings" : kind); assert.equal((await view()).entityId, result.id);
    await service.invoke({ action: "resources.save", kind, value: result }, agent); assert.equal(service.store.get(kind, result.id).workbench, undefined);
    await service.invoke({ action: "workbench.show", page: kind === "signatures" ? "settings" : kind, ...(kind === "signatures" ? {} : { id: result.id }) }, agent);
  }
  const event = await service.invoke({ action: "events.save", event: { title: "报价会议", start: "2027-02-11", end: "2027-02-12", allDay: true } }, agent); assert.equal((await view()).page, "calendar"); assert.equal((await view()).date, event.start);
  const list = await service.invoke({ action: "events.list", start: "2027-02-01", end: "2027-03-01" }, agent); assert.ok(Array.isArray(list)); assert.equal((await view()).date, "2027-02-01");
  const invite = await service.invoke({ action: "events.invite", id: event.id, accountId: "local", attendees: ["client@example.invalid"] }, agent); assert.equal((await view()).draftId, invite.id); assert.equal(invite.status, "draft");
  const rule = { name: "报价加星", match: "all", conditions: [{ field: "subject", operator: "contains", value: "报价" }], actions: [{ action: "star", value: true }] };
  const preview = await service.invoke({ action: "rules.preview", rule }, agent); assert.equal((await view()).rulePreview.count, preview.count);
  const saved = await service.invoke({ action: "rules.save", rule }, agent); assert.equal((await view()).entityId, saved.id); assert.equal(saved.enabled, false);
  const pending = await service.invoke({ action: "rules.apply", id: saved.id }, agent); assert.equal((await view()).previewId, pending.id);
  const exported = await service.invoke({ action: "events.export" }, agent); assert.equal((await view()).exportId, exported.id);
  const file = await service.invoke({ action: "exports.read", id: exported.id }, human); assert.match(Buffer.from(file.base64, "base64").toString(), /BEGIN:VCALENDAR/);
  await assert.rejects(service.invoke({ action: "exports.read", id: exported.id }, agent), { code: "USER_ACTION_REQUIRED" });
  const attachment = await service.upload({ filename: "proof.txt", contentType: "text/plain", base64: Buffer.from("proof").toString("base64") });
  await service.invoke({ action: "attachments.read", id: attachment.id }, agent); assert.equal((await view()).attachmentId, attachment.id);
});

test("failed operations keep the last presentation and presentation failure never duplicates a successful save", async (t) => {
  const { service } = await fixture(t); await service.invoke({ action: "search", inbox: true }, agent); const old = service.workbenchView(agent.sessionId);
  await assert.rejects(service.invoke({ action: "resources.save", kind: "tasks", value: {} }, agent), { code: "TITLE_REQUIRED" }); assert.equal(service.workbenchView(agent.sessionId).id, old.id);
  service.queueWorkbenchView = () => { throw new Error("presentation test failure"); };
  const result = await service.invoke({ action: "resources.save", kind: "tasks", value: { title: "只保存一次" } }, agent); assert.equal(result.workbench.status, "unavailable"); assert.equal(service.store.list("tasks").length, 1);
});

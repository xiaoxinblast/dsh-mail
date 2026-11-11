import test from "node:test";
import assert from "node:assert/strict";
import { initialSendFeedback, sendFeedback } from "../ui/send-feedback.mjs";

const draft = (status, extra = {}) => ({ id: "one", subject: "回复：项目交付", status, approvalId: "approval-1", ...extra });
const sync = (state, drafts, now = 1000) => sendFeedback(state, { type: "sync", drafts, now });

test("initial load only surfaces active sends, without replaying historical results", () => {
  const state = sync(initialSendFeedback, [draft("sent"), draft("failed", { id: "old" }), draft("queued", { id: "scheduled" }), draft("sending", { id: "active" })]);
  assert.deepEqual(state.toasts.map((item) => [item.id, item.status]), [["scheduled", "queued"], ["active", "sending"]]);
});

test("send feedback follows queue, SMTP progress and success even when the composer is closed", () => {
  let state = sync(initialSendFeedback, [draft("draft")]);
  for (const status of ["queued", "sending", "sent"]) {
    state = sync(state, [draft(status)]);
    assert.equal(state.toasts.length, 1); assert.equal(state.toasts[0].status, status);
  }
  assert.equal(state.toasts[0].expiresAt, 5500);
  state = sync(state, [draft("sent", { sentCopyStatus: "saved" })], 3000);
  assert.equal(state.toasts[0].expiresAt, 5500, "polling and sent-copy completion must not restart the success timeout");
  state = sendFeedback(state, { type: "expire", now: 5500 });
  assert.equal(sync(state, [draft("sent", { sentCopyStatus: "saved" })]).toasts.length, 0);
});

test("fast sends still produce results when polling skips the sending state", () => {
  for (const status of ["sent", "failed", "uncertain", "needs-confirmation"]) {
    const state = sync(sync(initialSendFeedback, [draft("queued")]), [draft(status)]);
    assert.equal(state.toasts[0].status, status);
    if (status !== "sent") assert.equal(state.toasts[0].expiresAt, null);
  }
});

test("dismissed pending feedback stays dismissed until a real state change", () => {
  let state = sync(initialSendFeedback, [draft("queued")]);
  state = sendFeedback(state, { type: "dismiss", id: "one" });
  assert.equal(sync(state, [draft("queued")]).toasts.length, 0);
  state = sync(state, [draft("sending")]);
  assert.equal(state.toasts[0].status, "sending");
});

test("cancellation keeps a brief confirmation and a later attempt starts fresh", () => {
  let state = sync(sync(initialSendFeedback, [draft("queued")]), [draft("draft")]);
  assert.equal(state.toasts[0].status, "cancelled");
  state = sync(state, [draft("draft", { subject: "继续编辑" })]);
  assert.equal(state.toasts[0].status, "cancelled");
  state = sync(state, [draft("queued", { approvalId: "approval-2" })]);
  assert.equal(state.toasts[0].status, "queued"); assert.equal(state.toasts[0].expiresAt, null);
});

test("multiple sends retain independent results, expiry and dismissal", () => {
  let state = sync(initialSendFeedback, [draft("queued"), draft("sending", { id: "two" })]);
  state = sync(state, [draft("sent"), draft("uncertain", { id: "two", error: { message: "连接中断" } })]);
  state = sendFeedback(state, { type: "expire", now: 6000 });
  assert.deepEqual(state.toasts.map((item) => item.id), ["two"]);
  assert.equal(state.toasts[0].draft.error.message, "连接中断");
  assert.equal(sync(state, []).toasts.length, 0);
});

test("partial acceptance and late sent-copy failures remain visible for review", () => {
  let state = sync(sync(initialSendFeedback, [draft("queued")]), [draft("sent", { rejected: ["rejected@example.invalid"] })]);
  assert.equal(state.toasts[0].expiresAt, null);
  state = sync(sync(initialSendFeedback, [draft("queued")]), [draft("sent", { sentCopyStatus: "pending" })]);
  state = sendFeedback(state, { type: "expire", now: 6000 });
  state = sync(state, [draft("sent", { sentCopyStatus: "failed" })]);
  assert.equal(state.toasts[0].expiresAt, null);
});

test("editing a failed draft removes its stale error feedback", () => {
  const state = sync(sync(initialSendFeedback, [draft("sending")]), [draft("failed")]);
  assert.equal(sync(state, [draft("draft")]).toasts.length, 0);
});

const pending = (status) => status === "queued" || status === "sending";
const terminal = (status) => ["sent", "failed", "uncertain", "needs-confirmation"].includes(status);
const stamp = (draft) => JSON.stringify([draft.status, draft.approvalId, draft.sentCopyStatus, draft.rejected]);

export const initialSendFeedback = { previous: null, toasts: [] };

export function sendFeedback(state, action) {
  if (action.type === "dismiss") return { ...state, toasts: state.toasts.filter((item) => item.id !== action.id) };
  if (action.type === "expire") return { ...state, toasts: state.toasts.filter((item) => !item.expiresAt || item.expiresAt > action.now) };
  const previous = state.previous, drafts = action.drafts, now = action.now;
  const toasts = new Map(state.toasts.filter((item) => drafts.some((draft) => draft.id === item.id)).map((item) => [item.id, item]));
  for (const draft of drafts) {
    const old = previous?.get(draft.id), changed = !old || stamp(old) !== stamp(draft);
    const cancelled = old?.status === "queued" && draft.status === "draft";
    if (cancelled) toasts.set(draft.id, { id: draft.id, draft, status: "cancelled", expiresAt: now + 4500 });
    else if (changed && (pending(draft.status) || (previous && terminal(draft.status) && (!old || old.status !== "sent" || draft.sentCopyStatus === "failed")))) {
      const warning = draft.rejected?.length > 0 || draft.sentCopyStatus === "failed";
      toasts.set(draft.id, { id: draft.id, draft, status: draft.status, expiresAt: draft.status === "sent" && !warning ? now + 4500 : null });
    } else if (toasts.has(draft.id)) {
      if (!pending(draft.status) && !terminal(draft.status) && toasts.get(draft.id).status !== "cancelled") toasts.delete(draft.id);
      else toasts.set(draft.id, { ...toasts.get(draft.id), draft });
    }
  }
  return { previous: new Map(drafts.map((draft) => [draft.id, draft])), toasts: [...toasts.values()] };
}

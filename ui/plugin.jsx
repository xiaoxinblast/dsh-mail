import React, { useEffect } from "react";
import { MailSurface, MailFullscreenLayer, createMailPresentationHost } from "./presentation.jsx";
import { Icon } from "./icons.jsx";
import { MailConversation, createMailAssistant } from "./assistant.jsx";

function Opener({ sessionId, open }) { return <button type="button" title="打开 DSH Mail" aria-label="打开 DSH Mail" onClick={() => open(sessionId)} style={{ border: 0, background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", padding: 6 }}><Icon name="mail" /></button>; }
function Presence({ useMailMounted, useSessions, open, call }) {
  const sessionId = useMailMounted((x) => x), preset = useSessions((s) => s.byId[sessionId]?.projectionValues?.agentPreset);
  useEffect(() => {
    if (preset !== "dsh-mail" || !sessionId) return; open(sessionId);
    let cancelled = false, running = false, lastId;
    const poll = async () => { if (running || document.visibilityState === "hidden") return; running = true; try { const view = await call(sessionId, { action: "workbench.state" }); if (!cancelled && view && view.id !== lastId) { lastId = view.id; open(sessionId); window.dispatchEvent(new CustomEvent("dsh-mail:workbench", { detail: { sessionId } })); } } catch {} finally { running = false; } };
    poll(); const timer = setInterval(poll, 1000), visible = () => { if (document.visibilityState !== "hidden") poll(); }; document.addEventListener("visibilitychange", visible); return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [sessionId, preset, open, call]);
  return null;
}
function Tab(props) { const { tab } = props.useTabInfo(); return <MailSurface {...props} origin="sidebar" visible={tab.visible} />; }
function Title({ useTabInfo }) { const { tab } = useTabInfo(); return <span><Icon name="mail" size={16} /> {tab.title}</span>; }
function MailIcon({ size = 18 }) { return <Icon name="mail" size={size} />; }
export default {
  inject: ["slots", "locale", "remote", "remote.session", "sessions", "workspaces", "uiWorkspace", "sidebarRight", "sidebarRightTabs"],
  async apply(ctx) {
    ctx.effect(() => ctx.locale.register("dsh-mail", { zh: { "DSH Mail": "DSH Mail", "打开 DSH Mail": "打开 DSH Mail" }, en: { "DSH Mail": "DSH Mail", "打开 DSH Mail": "Open DSH Mail" } }));
    const json = { mode: "strict", typeSymbol: "dsh-mail#Json", jsonSchema: {}, create: () => ({ parse: (v) => JSON.parse(JSON.stringify(v)) }) };
    const session = { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", jsonSchema: { type: "string" }, create: () => ({ parse(v) { if (typeof v !== "string" || !v) throw new Error("Session required"); return v; } }) };
    const dispose = await ctx.remote.$mount({ package: "dsh-mail", descriptors: [{ id: "dsh-mail#mailUi/invoke", service: "mailUi", namespace: "mailUi", method: "invoke", invocation: { kind: "direct" }, parameters: [{ name: "agent", wire: "agentId", source: "lookup", lookup: "agent", codec: session }, { name: "operation", wire: "operation", source: "json", codec: json }], cancellation: { parameter: "signal" }, result: json }, { id: "dsh-mail#mailUi/invokeGlobal", service: "mailUi", namespace: "mailUi", method: "invokeGlobal", invocation: { kind: "direct" }, parameters: [{ name: "operation", wire: "operation", source: "json", codec: json }], cancellation: { parameter: "signal" }, result: json }] });
    ctx.effect(() => dispose);
    await ctx.inject(["remote.mailUi"], (ctx) => {
      const call = async (sessionId, operation, signal) => { const r = await ctx.remote.mailUi.invoke(sessionId, operation, signal); if (!r.ok) throw new Error(r.error.message); return r.value; };
      const globalCall = async (_sessionId, operation, signal) => { if (_sessionId) return call(_sessionId, operation, signal); const r = await ctx.remote.mailUi.invokeGlobal(operation, signal); if (!r.ok) throw new Error(r.error.message); return r.value; };

      const assistantHost = createMailAssistant(ctx, globalCall);
      const presentationHost = createMailPresentationHost();
      ctx.effect(() => () => presentationHost.dispose());
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "dsh-mail-fullscreen", inject: () => ({ presentationHost }) }, MailFullscreenLayer));
      const children = (name) => ({ [name]: { kind: "single", scope: "session" } });
      for (const name of ["dsh-mail.main.conversation", "dsh-mail.sidebar.conversation"]) ctx.slots.inject(name, () => ctx.slots.register({ name }, MailConversation));
      const open = (sessionId) => { if (!sessionId || ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return; const existing = ctx.sidebarRight.openTabs.getSnapshot().find((t) => t.sessionId === sessionId && t.kind === "dsh-mail"); if (existing) { ctx.sidebarRight.focus(existing.tabId); if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded(); } else ctx.sidebarRight.openTab("dsh-mail"); };
      ctx.effect(() => ctx.sidebarRightTabs.register({ id: "dsh-mail", kind: "dsh-mail", title: () => "DSH Mail", keepMounted: true }));
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "dsh-mail", locale: "dsh-mail", children: children("dsh-mail.main.conversation"), inject: () => ({ call: globalCall, assistantHost, presentationHost, conversationSlot: "dsh-mail.main.conversation" }) }, MailSurface));
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: "dsh-mail", order: 20, label: "DSH Mail", locale: "dsh-mail" }, MailIcon));
      ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: "dsh-mail", locale: "dsh-mail", children: children("dsh-mail.sidebar.conversation"), inject: () => ({ call, assistantHost, presentationHost, conversationSlot: "dsh-mail.sidebar.conversation" }) }, Tab));
      ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: "dsh-mail", locale: "dsh-mail" }, Title));
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "dsh-mail-auto-open", inject: () => ({ hooks: { mailMounted: ctx.sidebarRight.mounted }, open, call }) }, Presence));
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({ name: "conversation.session.header.utilities", id: "dsh-mail-open", locale: "dsh-mail", inject: () => ({ open }) }, Opener));
    });
  }
};

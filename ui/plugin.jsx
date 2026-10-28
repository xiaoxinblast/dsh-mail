import React, { useEffect } from "react";
import { App } from "./workbench.jsx";

function Opener({ sessionId, open }) { return <button type="button" title="打开 DSH Mail" aria-label="打开 DSH Mail" onClick={() => open(sessionId)} style={{ border: 0, background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", padding: 6 }}>✉</button>; }
function Presence({ useMailMounted, useSessions, open }) { const sessionId = useMailMounted((x) => x), preset = useSessions((s) => s.byId[sessionId]?.projectionValues?.agentPreset); useEffect(() => { if (preset === "dsh-mail") open(sessionId); }, [sessionId, preset, open]); return null; }
function Tab(props) { const { tab } = props.useTabInfo(); return <App {...props} visible={tab.visible} />; }
function Title({ useTabInfo }) { const { tab } = useTabInfo(); return <span>✉ {tab.title}</span>; }
export default {
  inject: ["slots", "locale", "remote", "remote.session", "sessions", "sidebarRight", "sidebarRightTabs"],
  async apply(ctx) {
    ctx.effect(() => ctx.locale.register("dsh-mail", { zh: { "DSH Mail": "DSH Mail", "打开 DSH Mail": "打开 DSH Mail" }, en: { "DSH Mail": "DSH Mail", "打开 DSH Mail": "Open DSH Mail" } }));
    const json = { mode: "strict", typeSymbol: "dsh-mail#Json", jsonSchema: {}, create: () => ({ parse: (v) => JSON.parse(JSON.stringify(v)) }) };
    const session = { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", jsonSchema: { type: "string" }, create: () => ({ parse(v) { if (typeof v !== "string" || !v) throw new Error("Session required"); return v; } }) };
    const dispose = await ctx.remote.$mount({ package: "dsh-mail", descriptors: [{ id: "dsh-mail#mailUi/invoke", service: "mailUi", namespace: "mailUi", method: "invoke", invocation: { kind: "direct" }, parameters: [{ name: "agent", wire: "agentId", source: "lookup", lookup: "agent", codec: session }, { name: "operation", wire: "operation", source: "json", codec: json }], cancellation: { parameter: "signal" }, result: json }] });
    ctx.effect(() => dispose);
    await ctx.inject(["remote.mailUi"], (ctx) => {
      const call = async (sessionId, operation) => { const r = await ctx.remote.mailUi.invoke(sessionId, operation); if (!r.ok) throw new Error(r.error.message); return r.value; };
      const prompt = async (sessionId, text) => { const preset = ctx.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset; if (preset !== "dsh-mail") throw new Error("请先新建使用 DSH Mail 邮箱助手的会话。"); const r = await ctx.remote.session.prompt({ requestId: crypto.randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text }] }); if (!r.ok) throw new Error(r.error.message); return r.value; };
      const open = (sessionId) => { if (!sessionId || ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return; const existing = ctx.sidebarRight.openTabs.getSnapshot().find((t) => t.sessionId === sessionId && t.kind === "dsh-mail"); if (existing) { ctx.sidebarRight.focus(existing.tabId); if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded(); } else ctx.sidebarRight.openTab("dsh-mail"); };
      ctx.effect(() => ctx.sidebarRightTabs.register({ id: "dsh-mail", kind: "dsh-mail", title: () => "DSH Mail", keepMounted: true }));
      ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: "dsh-mail", locale: "dsh-mail", inject: () => ({ call, prompt }) }, Tab));
      ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: "dsh-mail", locale: "dsh-mail" }, Title));
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "dsh-mail-auto-open", inject: () => ({ hooks: { mailMounted: ctx.sidebarRight.mounted }, open }) }, Presence));
      for (const name of ["conversation.hero.options", "conversation.session.header.utilities"]) ctx.slots.inject(name, () => ctx.slots.register({ name, id: "dsh-mail-open", locale: "dsh-mail", inject: () => ({ open }) }, Opener));
    });
  }
};

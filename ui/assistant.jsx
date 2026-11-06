import React from "react";

function ChatView({ renderSlot }) {
  return renderSlot("conversation.session", { view: "chat" });
}

export function MailConversation({ useSession, useConversation, renderFactorySlot }) {
  const session = useSession((value) => value);
  const conversation = useConversation((value) => value);
  const active = conversation.activeTargets.size > 0 || !session.blank && !session.awaitingFirstTurn || session.running;
  return renderFactorySlot("conversation.content", { variant: "embedded", phase: !active && session.openState === "loading" ? "settling" : "active", hero: false }, { slots: { views: ChatView } });
}

export function createMailAssistant(ctx, globalCall) {
  const opening = new Map();
  return {
    async connect(ownerSessionId) {
      const key = ownerSessionId || "main";
      if (!opening.has(key)) {
        const work = (async () => {
          const saved = await globalCall(null, { action: "assistant.session", key });
          let sessionId = saved?.sessionId;
          if (!sessionId || ctx.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset !== "dsh-mail") {
            const workspaces = ctx.workspaces.list.getSnapshot();
            const workspace = workspaces.items?.[0];
            if (!workspace) throw new Error("请先在 DSH 添加工作区，再打开邮箱助手。");
            sessionId = await ctx.sessions.create({ cwd: workspace.path, agentPreset: "dsh-mail" });
            await globalCall(null, { action: "assistant.session", key, sessionId });
          }
          return sessionId;
        })().finally(() => opening.delete(key));
        opening.set(key, work);
      }
      const sessionId = await opening.get(key);
      const reference = ctx.sessions.retain(sessionId, { source: "dsh-mail-assistant" });
      try { await reference.ready; return { sessionId, reference }; }
      catch (error) { reference.release(); throw error; }
    }
  };
}

import { requireValue } from "../src/util.mjs";

const TASKS = {
  compose: "按用户要求撰写邮件，可使用当前草稿作为素材。",
  polish: "润色当前草稿，保留事实、承诺、签名及引用，不添加未提供的信息。",
  translateDraft: "完整翻译草稿主题及正文，保留段落、数字、网址、占位符。",
  translateMessage: "完整翻译本邮件主题及正文，不省略引用，不总结替代翻译。",
  summary: "总结本邮件要点、待处理事项和原文明示日期，未提供的信息不要补写。",
  reply: "根据本邮件及用户要求拟写回复，只输出新回复内容，不重复原信、签名或引用。"
};

export function aiModelSelection(ctx, context) {
  const agent = context.agent;
  const current = agent?.model?.current?.();
  if (current?.provider && current?.model) return current;
  const session = agent?.session;
  const pending = session && ctx.get("sessionProjections")?.stateOf(session, "modelSelection")?.pending;
  if (pending) return pending;
  const header = session?.requestHeader();
  if (header) return { provider: header.config.provider, model: header.config.model, ...(header.adapterDefaults?.reasoningEffort || !header.config.reasoningEffort ? {} : { reasoningEffort: header.config.reasoningEffort }) };
  return ctx.get("agentDefaultModel")?.currentSelection();
}

export function createAiRunner(ctx) {
  const runner = async ({ task, language, instruction, style, context, signal }) => {
    const service = ctx.get("mailWorkbench")?.service, controller = ctx.get("sessionController"), agent = context.agent;
    requireValue(controller && agent && context.sessionId && context.quickRunId, "AI_UNAVAILABLE", "请通过邮箱快捷入口连接同一邮箱助手会话后重试。");
    requireValue(ctx.get("sessionProjections")?.stateOf(agent.session, "agentPreset") === "dsh-mail", "AI_UNAVAILABLE", "快捷任务只能使用邮箱助手会话，请重新连接邮箱助手。");
    const run = service.quickAi.read(context.quickRunId, context.sessionId);
    requireValue(agent.status !== "running", "AI_BUSY", "邮箱助手正在处理任务。");
    const selection = aiModelSelection(ctx, context);
    const prompt = `邮件快捷任务：${TASKS[task]}\n输出语言：${({ preserve: "保留原文语言", original: "跟随原信语言" })[language] || language}；默认风格：${({ professional: "自然专业", concise: "简洁直接", friendly: "友好亲切", formal: "正式礼貌" })[style] || style}。\n${instruction ? "补充要求：" + instruction : "请将结果显示在当前邮件中，供我编辑。"}`;
    let admitted = false, settled = false, resolveTurn, rejectTurn;
    const completion = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    completion.catch(() => {});
    const finish = () => {
      if (settled || !admitted || agent.status === "running") return;
      settled = true;
      if (run.output) resolveTurn({ ...run.output, model: selection ? `${selection.provider}/${selection.model}` : "邮箱助手" });
      else rejectTurn(Object.assign(new Error("助手未提交可编辑结果，请在侧栏查看过程后重试。"), { code: "AI_INVALID_RESULT" }));
    };
    const dispose = ctx.on("agent/status", ({ agent: current }) => { if (current === agent) queueMicrotask(finish); });
    const abort = () => { if (!settled) { settled = true; agent.cancel({ kind: "user" }, { keepInbox: true }); rejectTurn(signal.reason || new Error("已取消")); } };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await controller.prompt({ requestId: run.id, sessionId: context.sessionId, mode: "queue", content: [{ type: "text", text: prompt }], clientTimeZone: service.settings().calendarTimeZone }, signal);
      admitted = true; queueMicrotask(finish);
      return await completion;
    } finally { dispose(); signal.removeEventListener("abort", abort); }
  };
  return Object.assign(runner, { nativeAgent: true });
}

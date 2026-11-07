import { id, requireValue } from "./util.mjs";

export class QuickAi {
  constructor(service) { this.service = service; this.runs = new Map(); this.active = new Map(); }
  read(key, sessionId) { const run = this.runs.get(key); requireValue(run && run.sessionId === sessionId, "AI_RUN_NOT_FOUND", "快捷任务不存在或不属于当前会话。"); return run; }
  view(run) { return { id: run.id, task: run.args.task, status: run.status, result: run.result, error: run.error, progress: run.progress, sessionId: run.sessionId }; }
  async start(args, context) {
    requireValue(context.sessionId, "WORKBENCH_SESSION_REQUIRED", "请先连接邮箱助手。");
    requireValue(!this.active.has(context.sessionId) && context.agent?.status !== "running", "AI_BUSY", "邮箱助手正在处理任务，请完成或停止后再试。");
    const run = { id: id(), sessionId: context.sessionId, args, status: "preparing", progress: [], abort: new AbortController(), createdAt: this.service.clock() };
    this.runs.set(run.id, run); this.active.set(run.sessionId, run);
    for (const [key, previous] of this.runs) if (previous !== run && !this.active.has(previous.sessionId) && previous.createdAt < this.service.clock() - 86400000) this.runs.delete(key);
    try { run.snapshot = await this.service.contextSource({ messageId: args.messageId, draftId: args.draftId }); if (args.draftId && args.revision !== undefined) requireValue(run.snapshot.draft?.revision === args.revision, "CONFLICT", "草稿已经改变，请重新生成。"); }
    catch (error) { this.active.delete(run.sessionId); run.status = "failed"; run.error = error.message; throw error; }
    const signal = AbortSignal.any([run.abort.signal, this.service.abort.signal]);
    run.status = "running";
    run.work = this.service.generateAi(args, { ...context, quickRunId: run.id, signal }).then((result) => { if (!signal.aborted) { run.result = result; run.status = "completed"; } }, (error) => { run.status = signal.aborted ? "cancelled" : "failed"; run.errorCode = error.code; run.error = signal.aborted ? "已停止；已经完成的工具操作保留在助手记录中。" : error.message; }).finally(() => { if (this.active.get(run.sessionId) === run) this.active.delete(run.sessionId); });
    this.service.aiWork.add(run.work); run.work.finally(() => this.service.aiWork.delete(run.work));
    return this.view(run);
  }
  cancel(key, context) { const run = this.read(key, context.sessionId); if (["preparing", "running"].includes(run.status)) { run.status = "cancelled"; run.abort.abort(new Error("已取消快捷任务")); } return this.view(run); }
  publish(args, context) {
    requireValue(context.kind === "agent", "AGENT_ACTION_REQUIRED", "结果只能由当前邮箱助手提交。");
    const run = this.read(args.id, context.sessionId);
    requireValue(run.status === "running" && !run.abort.signal.aborted, "AI_RUN_FINISHED", "快捷任务已结束。");
    requireValue(typeof args.text === "string" && args.text.trim() && args.text.length <= 200000 && (args.subject === undefined || typeof args.subject === "string" && args.subject.length <= 2000), "AI_INVALID_RESULT", "快捷结果格式无效。");
    requireValue(!run.output, "AI_RESULT_EXISTS", "快捷结果已经提交。");
    run.output = { text: args.text, ...(args.subject !== undefined ? { subject: args.subject } : {}) };
    return { submitted: true, id: run.id };
  }
  progress(sessionId, action, status) {
    const run = this.active.get(sessionId); if (!run || run.status !== "running" || action === "assistant.quick.result") return;
    const pending = status !== "running" && run.progress.findLast((item) => item.action === action && item.status === "running");
    if (pending) { pending.status = status; return; }
    if (run.progress.length >= 30) run.progress.shift(); run.progress.push({ action, status });
  }
}

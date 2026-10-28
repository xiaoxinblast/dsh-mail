import { TypertRemoteService, isRemoteJsonValue } from "@deepseek-ai/dsh-typert-protocol";
const json = { mode: "strict", typeSymbol: "dsh-mail#Json", jsonSchema: {}, create: () => ({ parse(value) { if (!isRemoteJsonValue(value)) throw new TypeError("Expected JSON operation"); return value; } }) };
const sessionId = { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", jsonSchema: { type: "string" }, create: () => ({ parse(value) { if (typeof value !== "string" || !value) throw new TypeError("Expected session id"); return value; } }) };
export const descriptor = { id: "dsh-mail#mailUi/invoke", service: "mailUi", namespace: "mailUi", method: "invoke", invocation: { kind: "direct" }, parameters: [{ name: "agent", wire: "agentId", source: "lookup", lookup: "agent", codec: sessionId }, { name: "operation", wire: "operation", source: "json", codec: json }], cancellation: { parameter: "signal" }, result: json };
export const TYPERT = { package: "dsh-mail", face: "host", schemas: [], invocations: [descriptor], model: { services: [], events: [], objects: [] } };
export class MailUiService extends TypertRemoteService {
  static inject = ["mailWorkbench"];
  constructor(ctx) { super(ctx, "mailUi"); }
  async invoke(agent, operation, signal) { signal?.throwIfAborted(); return this.ctx.mailWorkbench.service.invoke(operation, { kind: "human", sessionId: agent.session.header.id }); }
}

import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { MailService } from "../src/service.mjs";
import { MailUiService, TYPERT } from "./bridge.mjs";

export const inject = ["typert", "tools", "agentPresets"];
export async function apply(ctx) {
  const profile = ctx.get("profileContext")?.name || process.env.DSH_PROFILE || "desktop";
  const service = new MailService({ directory: join(resolveDshHome(), "dsh-mail", profile) });
  ctx.effect(() => ctx.reflect.provide("mailWorkbench", { service }));
  ctx.plugin(MailUiService);
  ctx.typert.register(TYPERT);
  service.start();
  ctx.effect(() => () => service.close());
}

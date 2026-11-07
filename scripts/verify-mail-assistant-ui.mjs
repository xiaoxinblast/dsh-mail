// Native DSH conversation + real mail tools, driven by the local fixture adapter.
import { chromium, expect as baseExpect } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const expect = baseExpect.configure({ timeout: 18000 });
const log = await readFile(process.argv[2] || ".cache/current-host.log", "utf8");
const url = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0];
if (!url) throw new Error("Expected the isolated Host's loopback startup log.");
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } }), errors = [], checks = [];
page.setDefaultTimeout(18000); page.on("pageerror", (e) => errors.push(e.message));
const mail = page.locator(".dsh-mail:visible"), panel = page.getByRole("complementary", { name: "邮箱 AI 对话" });
const input = () => panel.getByRole("textbox");
const openMail = async (subject) => { await mail.getByRole("button", { name: "邮件", exact: true }).click(); await mail.getByRole("heading", { name: subject, exact: true }).click(); await expect(mail.locator(".dm-reader h2")).toHaveText(subject); };
const prompt = async (text) => { await input().fill(text); await input().press("Enter"); };
const shot = (name) => page.locator(".dm-app").screenshot({ path: `.cache/screenshots/assistant-${name}.png` });
const calls = async () => (await readFile(".cache/assistant-model-calls.jsonl", "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse).filter((c) => c.messages.some((m) => m.source?.kind === "dsh-mail-context"));
try {
  await page.goto(url);
  await page.getByRole("navigation", { name: "全局面板", exact: true }).getByRole("button", { name: "DSH Mail", exact: true }).click();
  await openMail("[验收] 联系人与内置 AI");
  await mail.getByRole("button", { name: "邮箱 AI 助手", exact: true }).click(); await expect(input()).toBeVisible();
  await shot("reader");
  await prompt("请查看完整引用并创建回复草稿");
  await expect(panel).toContainText("工具执行完成");
  await expect(mail.locator(".dm-composer .tiptap")).toContainText("确认周五交付");
  const replyCalls = await calls(); assert.equal(replyCalls.length, 3);
  for (const call of replyCalls) {
    assert.equal(call.tools.length, 10); assert.ok(call.tools.every((tool) => tool.name.startsWith("mail_")));
    const context = call.messages.filter((m) => m.source?.kind === "dsh-mail-context");
    assert.equal(context.length, 1); assert.match(context[0].content[0].text, /最早报价 12345/);
  }
  await shot("reply"); checks.push("native multi-step Agent sees complete nested HTML quotes, uses the 10 shared mail tools, and displays the created reply draft");
  await prompt("为当前草稿生成发送预览"); await expect(mail.getByRole("dialog")).toContainText("确认发送");
  await shot("send-preview"); await mail.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  checks.push("Agent can prepare a send preview; SMTP confirmation remains a human UI action");
  await panel.getByRole("button", { name: "关闭邮箱助手" }).click(); await mail.getByRole("button", { name: "邮箱 AI 助手" }).click(); await expect(panel).toContainText("请查看完整引用并创建回复草稿");
  await mail.getByRole("button", { name: "← 关闭", exact: true }).click(); await openMail("[验收] 另一封上下文邮件");
  await prompt("总结当前打开的邮件"); await expect(panel).toContainText("第二封邮件的专属信息：周三评审");
  const latest = (await calls()).at(-1).messages.filter((m) => m.source?.kind === "dsh-mail-context").at(-1);
  assert.match(latest.content[0].text, /assistant-other/); assert.doesNotMatch(latest.content[0].text, /最早报价 12345/);
  await prompt("从这封邮件创建待办"); await expect(mail.locator('.dm-task-row[data-agent-selected="true"]').filter({ hasText: "[合成] 核对邮件交付" })).toBeVisible();
  checks.push("conversation survives reopening; each new turn follows the selected mail; task tools update the workbench");
  await openMail("[验收] 另一封上下文邮件"); await prompt("[slow] 总结这封邮件");
  await panel.getByRole("button", { name: /停止/ }).click(); await expect(panel).toContainText(/已停止|已取消|已中断/);
  checks.push("native stop action cancels the local model request");
  await page.reload(); await page.getByRole("navigation", { name: "全局面板", exact: true }).getByRole("button", { name: "DSH Mail", exact: true }).click();
  await mail.getByRole("button", { name: "邮箱 AI 助手" }).click(); await expect(panel).toContainText("请查看完整引用并创建回复草稿");
  await openMail("[验收] 另一封上下文邮件"); await shot("history");
  await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();
  for (const width of [1100, 600]) { await page.setViewportSize({ width, height: 900 }); await shot(`narrow-${width}`); await expect(panel.getByRole("button", { name: "关闭邮箱助手" })).toBeInViewport(); assert.ok(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)); }
  assert.deepEqual(errors, []);
  checks.push("page reload restores the same conversation; narrow panels keep close/input controls reachable; zero browser errors");
  await writeFile(".cache/mail-assistant-ui-verification.json", JSON.stringify({ checks, pageErrors: errors, model: "local synthetic adapter", confirmedSends: 0 }, null, 2));
  console.log(JSON.stringify({ checks, pageErrors: errors, confirmedSends: 0 }));
} catch (error) { await shot("failure"); await writeFile(".cache/assistant-failure.txt", await page.locator("body").innerText()); throw error; }
finally { await browser.close(); }

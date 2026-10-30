// Real isolated DSH Host, synthetic links intercepted locally; no external site is contacted.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const url = process.argv[2];
if (!url || new URL(url).hostname !== "127.0.0.1") throw new Error("Pass the isolated Host's complete loopback URL.");
const browser = await chromium.launch({ channel: "msedge", headless: true }), errors = [], checks = [], destinations = [];
await mkdir(".cache/screenshots", { recursive: true });
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1050 } });
  await context.route(/^https?:\/\/mail-links\.example\.invalid\//, async (route) => { destinations.push(route.request().url()); await route.fulfill({ contentType: "text/html; charset=utf-8", body: '<!doctype html><meta charset="utf-8"><h1>本机验收目标页</h1><script>window.destinationScriptRan=true</script>' }); });
  page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url); await page.getByText("开始使用", { exact: true }).waitFor(); await page.keyboard.press("Escape");
  await page.getByRole("navigation", { name: "全局面板", exact: true }).getByRole("button", { name: "DSH Mail", exact: true }).click();
  const root = page.locator(".dsh-mail:visible"), frame = () => root.frameLocator('iframe[title="邮件正文"]'), conversation = root.locator(".dm-conversation");
  const resize = async (width) => { await root.evaluate((el, width) => { el.style.width = `${width}px`; el.style.height = "900px"; el.style.flex = "none"; }, width); };
  const open = async (subject) => { await resize(1440); await root.locator(".dm-folders>button").filter({ hasText: "统一收件箱" }).click(); await root.locator(".dm-message-row").filter({ has: page.getByRole("heading", { name: subject, exact: true }) }).locator("button.dm-message").first().click(); await expect(root.locator(".dm-reader h2")).toHaveText(subject); await expect(frame().getByRole("heading", { name: "确认交付安排" })).toBeVisible(); };
  const shot = (name) => root.screenshot({ path: `.cache/screenshots/conversation-${name}.png` });
  const openLink = async (link, expected) => { const popupPromise = page.waitForEvent("popup"); await link.click(); const popup = await popupPromise; await expect(popup).toHaveURL(expected); await expect(popup.getByRole("heading")).toHaveText("本机验收目标页"); assert.equal(await popup.evaluate(() => window.opener === null && window.destinationScriptRan === true), true); await popup.close(); await expect(root.locator(".dm-reader")).toBeVisible(); };
  await open("[验收] 交付计划与报价确认");
  await expect(conversation.locator("summary")).toContainText("共 3 封"); await expect(conversation.locator(".dm-conversation-items>button")).toHaveCount(3); await expect(conversation.locator('[aria-current="true"]')).toContainText("当前邮件");
  await expect(root.getByText(/邮件中的链接|相关会话/)).toHaveCount(0);
  await expect(frame().getByRole("link", { name: "项目资料", exact: true })).toHaveAttribute("target", "_blank");
  await expect(frame().getByRole("link", { name: "项目资料", exact: true })).toHaveAttribute("rel", "noopener noreferrer");
  assert.equal(destinations.length, 0, "Reading mail never opens a destination");
  for (const name of ["脚本链接", "数据链接", "本地文件链接", "无效网页链接"]) await expect(frame().locator("a").filter({ hasText: name })).not.toHaveAttribute("href", /.+/);
  await expect(frame().locator("script,form,input,button")).toHaveCount(0);
  assert.equal(await root.locator('iframe[title="邮件正文"]').evaluate((el) => { try { return !!el.contentWindow.document; } catch { return false; } }), false);
  await openLink(frame().getByRole("link", { name: "项目资料", exact: true }), "https://mail-links.example.invalid/project?a=1&b=2");
  await openLink(frame().getByRole("link", { name: "帮助页面", exact: true }), "http://mail-links.example.invalid/help");
  await expect(root.locator(".dm-reader h2")).toHaveText("[验收] 交付计划与报价确认");
  await root.getByLabel("更多邮件操作", { exact: true }).click(); await root.getByRole("button", { name: "显示纯文本", exact: true }).click();
  await openLink(root.locator(".dm-mail-body pre").getByRole("link"), "https://mail-links.example.invalid/plain");
  await root.getByLabel("更多邮件操作", { exact: true }).click(); await root.getByRole("button", { name: "显示 HTML", exact: true }).click();
  checks.push("direct HTTP/HTTPS and plain-text link clicks, decoded query parameters, separate destination with no opener, reader retained; unsafe URLs/scripts/forms stay blocked");
  const reply = conversation.locator(".dm-conversation-items>button").filter({ hasText: "我的回复" }); await reply.click();
  await expect(root.locator(".dm-reader h2")).toHaveText("Re: [验收] 交付计划与报价确认"); await expect(conversation.locator('[aria-current="true"]')).toContainText("我的回复");
  const times = await conversation.locator("time").evaluateAll((elements) => elements.map((el) => el.dateTime)); assert.deepEqual(times, [...times].sort().reverse());
  for (const width of [1440, 1024, 768, 390]) { await resize(width); await expect(conversation).toBeVisible(); assert.ok(await root.evaluate((el) => el.scrollWidth <= el.clientWidth && [...el.querySelectorAll(".dm-conversation,.dm-conversation-items")].every((item) => item.scrollWidth <= item.clientWidth))); await shot(`light-${width}`); }
  await page.getByText("更多", { exact: true }).last().click(); await page.getByText("设置", { exact: true }).last().click(); await page.getByRole("button", { name: "深色", exact: true }).click(); await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  for (const width of [1440, 390]) { await resize(width); await shot(`dark-${width}`); }
  await page.getByText("更多", { exact: true }).last().click(); await page.getByText("设置", { exact: true }).last().click(); await page.getByRole("button", { name: "浅色", exact: true }).click(); await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await open("[验收] 仅有文件夹副本"); await expect(conversation).toHaveCount(0); await shot("copies-not-a-conversation");
  await open("[验收] 改为另一个项目"); await expect(conversation).toHaveCount(0);
  await open("[验收] 长邮件往来"); await expect(conversation.locator("summary")).toContainText("共 61 封"); await expect(conversation.locator(".dm-conversation-items>button")).toHaveCount(51); await expect(conversation.locator('[aria-current="true"]')).toContainText("当前邮件");
  await conversation.getByRole("button", { name: "加载更早的邮件", exact: true }).click(); await expect(conversation.locator(".dm-conversation-items>button")).toHaveCount(61); await expect(conversation.getByRole("button", { name: "加载更早的邮件", exact: true })).toHaveCount(0);
  checks.push("three unique mails across inbox/sent/project copies, newest-first with current marker, copy-only and changed-subject groups hidden, 61-mail pagination");
  assert.deepEqual(errors, []);
  await writeFile(".cache/conversation-ui-verification.json", JSON.stringify({ checks, pageErrors: errors, interceptedDestinations: destinations }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, pageErrors: errors }));
} catch (error) { if (page) { await page.screenshot({ path: ".cache/screenshots/conversation-failure.png" }); await writeFile(".cache/conversation-failure.txt", (await page.locator("body").innerText()).slice(0, 16000)); } throw error; }
finally { await browser.close(); }

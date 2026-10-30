// Real isolated DSH Host only. Pass --notify once to submit a Windows test toast.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const url = process.argv[2];
if (!url || new URL(url).hostname !== "127.0.0.1") throw new Error("Pass the isolated Host's 127.0.0.1 URL.");
const browser = await chromium.launch({ channel: "msedge", headless: true }), errors = [], checks = [];
await mkdir(".cache/screenshots", { recursive: true });
const settings = () => { const db = new DatabaseSync(".cache/dsh-home/dsh-mail/web/mail.sqlite", { readOnly: true }); try { return JSON.parse(db.prepare("SELECT data FROM entities WHERE kind='settings' AND id='general'").get().data); } finally { db.close(); } };
let page;
try {
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const root = page.locator(".dsh-mail:visible");
  const open = async () => { await page.goto(url); const welcome = page.getByText("开始使用", { exact: true }); await page.getByRole("navigation", { name: "全局面板", exact: true }).waitFor(); await welcome.waitFor({ state: "visible", timeout: 3000 }).catch((error) => { if (error.name !== "TimeoutError") throw error; }); if (await welcome.isVisible()) { await page.keyboard.press("Escape"); await expect(welcome).toBeHidden(); } await page.getByRole("navigation", { name: "全局面板", exact: true }).getByRole("button", { name: "DSH Mail", exact: true }).click(); await expect(root.locator(".dm-message-row").first()).toBeVisible(); };
  const resize = async (width) => { await root.evaluate((el, width) => { el.style.width = `${width}px`; el.style.height = "900px"; el.style.flex = "none"; }, width); await expect.poll(() => root.evaluate((el) => el.clientWidth)).toBe(width); };
  const shot = async (name) => { await root.screenshot({ path: `.cache/screenshots/layout-${name}.png` }); };
  const width = (selector) => root.locator(selector).evaluate((el) => el.getBoundingClientRect().width);
  const divider = (name) => root.getByRole("separator", { name, exact: true });
  const drag = async (name, dx) => { const target = divider(name), box = await target.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 10 }); await page.mouse.up(); };
  const noOverflow = async () => assert.ok(await root.evaluate((el) => el.scrollWidth <= el.clientWidth && [...el.querySelectorAll(".dm-mail-layout,.dm-list-pane,.dm-detail-pane,.dm-settings-main")].filter((x) => x.getClientRects().length).every((x) => x.scrollWidth <= x.clientWidth)), "No horizontal overflow");
  await open(); await resize(1440);
  await root.locator(".dm-message-row").filter({ hasText: "十月项目交付计划与报价确认" }).locator("button.dm-message").click();
  await expect(root.locator(".dm-reader h2")).toHaveText("十月项目交付计划与报价确认");
  for (const name of ["调整文件夹栏宽度", "调整邮件列表宽度"]) await divider(name).dblclick();
  await expect.poll(() => settings().mailFolderWidth).toBe(240); await expect.poll(() => settings().mailListWidth).toBe(340);
  await drag("调整文件夹栏宽度", 70); await expect.poll(() => settings().mailFolderWidth).toBe(310);
  await drag("调整邮件列表宽度", 85); await expect.poll(() => settings().mailListWidth).toBe(425);
  assert.equal(await width(".dm-folders"), 310); assert.equal(await width(".dm-list-pane"), 425);
  await noOverflow(); await shot("dragged-light-1440");
  await divider("调整邮件列表宽度").focus(); await page.keyboard.press("ArrowRight"); await expect.poll(() => settings().mailListWidth).toBe(435);
  await page.keyboard.press("Home"); await expect.poll(() => settings().mailListWidth).toBe(260);
  await page.keyboard.press("End"); await expect.poll(() => width(".dm-detail-pane")).toBeGreaterThanOrEqual(300);
  await divider("调整邮件列表宽度").dblclick(); await expect.poll(() => settings().mailListWidth).toBe(340);
  await drag("调整邮件列表宽度", 85); await expect.poll(() => settings().mailListWidth).toBe(425);
  await open(); await resize(1440); assert.equal(await width(".dm-folders"), 310); assert.equal(await width(".dm-list-pane"), 425);
  checks.push("mouse drag, keyboard arrows/Home/End, double-click reset and reload persistence");
  await root.locator(".dm-message-row").first().locator("button.dm-message").click();
  for (const size of [1440, 1100, 1024, 768, 390]) { await resize(size); await noOverflow(); await expect(root.getByRole("separator")).toHaveCount(size >= 1100 ? 2 : size >= 760 ? 1 : 0); await shot(`reader-light-${size}`); }
  await resize(1440); await drag("调整文件夹栏宽度", 1000); await noOverflow(); await drag("调整邮件列表宽度", 1000); await noOverflow(); assert.ok(await width(".dm-detail-pane") >= 300);
  await drag("调整文件夹栏宽度", -1000); await expect.poll(() => settings().mailFolderWidth).toBe(180);
  await drag("调整邮件列表宽度", -1000); await expect.poll(() => settings().mailListWidth).toBe(260);
  await noOverflow(); checks.push("drag limits, narrow layout, no overflow at 1440/1100/1024/768/390");
  const interrupted = await divider("调整邮件列表宽度").boundingBox();
  await page.mouse.move(interrupted.x + 3, interrupted.y + 50); await page.mouse.down(); await expect(root.locator(".dm-mail-layout")).toHaveClass(/dm-resizing/);
  await resize(390); await page.mouse.up(); await expect(root.locator(".dm-mail-layout")).not.toHaveClass(/dm-resizing/); await resize(1440);
  checks.push("shrinking to single-column during a drag releases resizing state");
  for (const name of ["调整文件夹栏宽度", "调整邮件列表宽度"]) await divider(name).dblclick();
  await expect.poll(() => settings().mailFolderWidth).toBe(240); await expect.poll(() => settings().mailListWidth).toBe(340);
  const rail = root.getByRole("navigation", { name: "功能导航" });
  await rail.getByRole("button", { name: "设置", exact: true }).click();
  await root.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: "邮件与日历偏好", exact: true }).click();
  const toggle = root.getByRole("checkbox", { name: "新邮件、日历与待办使用系统通知", exact: true }), save = root.getByRole("button", { name: "保存偏好", exact: true });
  await toggle.uncheck(); if (await save.isEnabled()) await save.click(); await expect.poll(() => settings().desktopNotifications).toBe(false);
  await toggle.check(); await save.click(); await expect.poll(() => settings().desktopNotifications).toBe(true);
  await shot("notification-settings-light");
  if (process.argv.includes("--notify")) { await root.getByRole("button", { name: "测试系统通知", exact: true }).click(); await expect(root.getByRole("status").filter({ hasText: "测试通知已提交给 Windows" })).toBeVisible({ timeout: 20000 }); checks.push("test notification submitted through actual Host native Windows adapter"); }
  await resize(390); await root.getByRole("button", { name: "测试系统通知", exact: true }).scrollIntoViewIfNeeded(); await noOverflow(); await shot("notification-settings-light-390");
  await page.getByText("更多", { exact: true }).last().click(); await page.getByText("设置", { exact: true }).last().click(); await page.getByRole("button", { name: "深色", exact: true }).click(); await expect(page.locator("body")).toHaveAttribute("data-ds-dark-theme", ""); await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await rail.getByRole("button", { name: "邮件", exact: true }).click();
  for (const size of [1440, 1024, 390]) { await resize(size); await noOverflow(); await shot(`reader-dark-${size}`); }
  await resize(1440); await divider("调整邮件列表宽度").focus(); await shot("divider-focus-dark");
  await page.emulateMedia({ reducedMotion: "reduce" }); await divider("调整邮件列表宽度").hover(); await expect(divider("调整邮件列表宽度")).toHaveCSS("cursor", "col-resize"); await shot("divider-hover-reduced-motion");
  await page.getByText("更多", { exact: true }).last().click(); await page.getByText("设置", { exact: true }).last().click(); await page.getByRole("button", { name: "浅色", exact: true }).click(); await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await drag("调整文件夹栏宽度", 70); await expect.poll(() => settings().mailFolderWidth).toBe(310);
  await drag("调整邮件列表宽度", 85); await expect.poll(() => settings().mailListWidth).toBe(425);
  assert.deepEqual(errors, []); checks.push("notification preference persisted, light/dark and reduced-motion screenshots, no page errors");
  await writeFile(".cache/layout-ui-verification.json", JSON.stringify({ checks, pageErrors: errors, settings: settings() }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, pageErrors: errors }));
} catch (error) { if (page) { await page.screenshot({ path: ".cache/screenshots/layout-failure.png" }); await writeFile(".cache/layout-failure.txt", (await page.locator("body").innerText()).slice(0, 15000)); } throw error; }
finally { await browser.close(); }

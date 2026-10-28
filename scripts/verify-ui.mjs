// Run against the repository-local isolated Host after seed-navigation-fixtures.mjs.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import packageInfo from "../package.json" with { type: "json" };

const url = process.argv[2];
if (!url || new URL(url).hostname !== "127.0.0.1") throw new Error("Pass the isolated Host's 127.0.0.1 URL, including its temporary token.");
const browser = await chromium.launch({ channel: "msedge", headless: true }), errors = [], checks = [];
let page;
await mkdir(".cache/screenshots", { recursive: true });
try {
  page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByRole("navigation", { name: "全局面板", exact: true }).getByRole("button", { name: "DSH Mail", exact: true }).waitFor();
  await page.getByText("开始使用", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await expect(page.getByText("开始使用", { exact: true })).toBeHidden();
  await expect(page.locator("[class*=heroOptions]").getByRole("button", { name: "打开 DSH Mail", exact: true })).toHaveCount(0);
  await page.screenshot({ path: ".cache/screenshots/navigation-conversation-no-entry.png" });
  await page.getByRole("navigation", { name: "全局面板", exact: true }).getByRole("button", { name: "DSH Mail", exact: true }).click();
  const root = page.locator(".dsh-mail:visible"), rail = root.getByRole("navigation", { name: "功能导航" });
  await expect(root.locator(".dm-message-row").first()).toBeVisible();
  const inboxCount = await root.locator(".dm-message-row").count();
  await expect(root.locator(".dm-account-folders").filter({ hasText: "工作邮箱 · 界面验收" })).toBeVisible();
  const resize = async (width) => { await root.evaluate((el, width) => { el.style.width = `${width}px`; el.style.height = "900px"; el.style.flex = "none"; }, width); assert.equal(await root.evaluate((el) => el.clientWidth), width); };
  const shot = async (name) => { await page.waitForTimeout(180); await root.screenshot({ path: `.cache/screenshots/navigation-${name}.png` }); };
  const noOverflow = async () => assert.ok(await root.evaluate((el) => el.scrollWidth <= el.clientWidth && [...el.querySelectorAll(".dm-workspace,.dm-list-pane,.dm-settings-main")].filter((x) => x.getClientRects().length).every((x) => x.scrollWidth <= x.clientWidth)), "No horizontal overflow");
  await resize(1440);
  await root.getByRole("combobox", { name: "文件夹排序" }).selectOption("name-asc");
  await expect(root.getByRole("combobox", { name: "文件夹排序" })).toBeEnabled();
  const account = root.locator(".dm-account-folders").filter({ hasText: "工作邮箱 · 界面验收" });
  const names = await account.locator(".dm-folder-row>button>span").allTextContents();
  assert.ok(names.indexOf("Altagram") < names.indexOf("Lionbridge"));
  assert.ok(names.indexOf("客户2") < names.indexOf("客户10"));
  const beforeQuery = await root.locator(".dm-list-heading h2").innerText();
  await root.getByRole("textbox", { name: "查找文件夹" }).fill("项目/");
  await expect(root.getByRole("status").filter({ hasText: "找到 2 个文件夹" })).toBeVisible();
  assert.equal(await root.locator(".dm-list-heading h2").innerText(), beforeQuery);
  await root.getByRole("textbox", { name: "查找文件夹" }).fill("不存在的文件夹");
  await expect(root.getByText("没有匹配的文件夹", { exact: true })).toBeVisible();
  await root.getByRole("button", { name: "清空文件夹查找" }).click();
  await root.getByRole("combobox", { name: "文件夹排序" }).selectOption("count-desc");
  await expect(root.getByRole("combobox", { name: "文件夹排序" })).toBeEnabled();
  assert.equal(await account.locator(".dm-folder-row>button>span").first().innerText(), "Lionbridge");
  await root.getByRole("combobox", { name: "文件夹排序" }).selectOption("name-asc");
  await expect(root.getByRole("combobox", { name: "文件夹排序" })).toBeEnabled();
  checks.push("name/count sorting, full-path search, empty search, no mail-query change");

  await account.getByLabel("管理文件夹 Altagram", { exact: true }).click();
  const colors = account.locator(".dm-folder-actions[open]");
  await colors.getByRole("button", { name: "文件夹颜色：紫色", exact: true }).click();
  await expect(colors.getByRole("button", { name: "文件夹颜色：紫色", exact: true })).toHaveAttribute("aria-pressed", "true");
  await shot("folder-colors-light");
  await colors.getByLabel("自定义文件夹颜色 Altagram", { exact: true }).fill("#0891b2");
  await colors.getByRole("button", { name: "应用颜色", exact: true }).click();
  await expect(colors.getByRole("button", { name: "文件夹颜色：青色", exact: true })).toHaveAttribute("aria-pressed", "true");
  await colors.getByRole("button", { name: "恢复默认", exact: true }).click();
  await expect(colors.getByRole("button", { name: "恢复默认", exact: true })).toBeDisabled();
  await colors.getByRole("button", { name: "文件夹颜色：紫色", exact: true }).click();
  await expect(colors.getByRole("button", { name: "文件夹颜色：紫色", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  checks.push("preset/custom/reset folder color via real UI");

  await root.locator(".dm-folders>button").filter({ hasText: "已发送" }).click();
  await expect(root.locator(".dm-message-row")).toHaveCount(2);
  await expect(root.locator(".dm-sent-warning")).toBeVisible();
  assert.ok((await root.locator(".dm-message h3").allTextContents()).every((text) => text.startsWith("已发送 ·")));
  await shot("sent-light");
  await root.locator(".dm-folders>button").filter({ hasText: "统一收件箱" }).click();
  await expect(root.locator(".dm-message-row")).toHaveCount(inboxCount);
  const row = root.locator(".dm-message-row").filter({ hasText: "十月项目交付计划与报价确认" });
  await row.hover();
  await expect(row.locator(".dm-row-quick")).toHaveCSS("opacity", "1");
  await shot("row-hover-light");
  const flagRow = root.locator(".dm-message-row").filter({ hasText: "[测试] 离线缓存与邮件导出" });
  await flagRow.hover();
  const initiallyUnread = (await flagRow.getAttribute("class")).includes("unread");
  await flagRow.locator(".dm-row-quick button").first().click();
  if (initiallyUnread) await expect(flagRow).not.toHaveClass(/unread/); else await expect(flagRow).toHaveClass(/unread/);
  await flagRow.locator(".dm-row-quick button").first().click();
  if (initiallyUnread) await expect(flagRow).toHaveClass(/unread/); else await expect(flagRow).not.toHaveClass(/unread/);
  await expect(root.locator(".dm-reader")).toHaveCount(0);
  await row.locator("button.dm-message").click();
  await expect(root.locator(".dm-reader h2")).toHaveText("十月项目交付计划与报价确认");
  await root.getByLabel("更多邮件操作", { exact: true }).click();
  await expect(root.getByRole("button", { name: "显示邮件头", exact: true })).toBeVisible();
  await shot("reader-more-light");
  await page.keyboard.press("Escape");
  checks.push("sent mapping, missing-mapping notice, row hover, read/unread without opening, reader menu");

  for (const width of [1440, 1024, 768, 390]) {
    await resize(width);
    await noOverflow();
    await shot(`reader-light-${width}`);
    if (width < 1100) {
      if (width < 760) await root.getByRole("button", { name: "返回邮件列表", exact: true }).click();
      await root.getByRole("button", { name: "打开文件夹列表", exact: true }).click();
      await expect(root.getByRole("textbox", { name: "查找文件夹" })).toBeFocused();
      await shot(`drawer-light-${width}`);
      await page.keyboard.press("Escape");
      await expect(root.getByRole("button", { name: "打开文件夹列表", exact: true })).toBeFocused();
      await root.getByRole("button", { name: "打开文件夹列表", exact: true }).click();
      const backdrop = root.getByRole("button", { name: "关闭文件夹列表", exact: true });
      const box = await backdrop.boundingBox();
      await backdrop.click({ position: { x: box.width - 3, y: box.height - 3 } });
      await expect(root.locator(".dm-mail-layout")).not.toHaveClass(/show-folders/);
      if (width < 760) await row.locator("button.dm-message").click();
    }
  }
  checks.push("1440/1024/768/390 container layouts, drawer search focus, Escape/backdrop/focus restoration");
  await resize(1440);
  await root.getByRole("button", { name: "回复", exact: true }).click();
  await expect(root.locator(".dm-composer")).toBeVisible();
  await root.locator(".dm-composer").getByRole("textbox", { name: "主题", exact: true }).fill("[验收] 界面回复预览");
  await root.getByRole("button", { name: "保存草稿", exact: true }).click();
  await shot("reply-light");
  await root.getByRole("button", { name: "预览并发送 →", exact: true }).click();
  await expect(root.getByRole("dialog")).toBeVisible();
  await expect(root.getByRole("dialog")).toContainText("[验收] 界面回复预览");
  await shot("reply-preview-light");
  await root.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await root.getByRole("button", { name: "← 关闭", exact: true }).click();
  await root.getByRole("checkbox", { name: "选择 十月项目交付计划与报价确认", exact: true }).check();
  await expect(root.getByRole("button", { name: "移动", exact: true })).toBeVisible();
  await shot("bulk-light");
  await root.getByRole("checkbox", { name: "选择 十月项目交付计划与报价确认", exact: true }).uncheck();
  for (const name of ["日历", "待办", "联系人", "规则", "设置"]) {
    await rail.getByRole("button", { name, exact: true }).click();
    await shot(`page-${name}-light`);
    await noOverflow();
  }
  for (const name of ["邮箱账号", "邮件与日历偏好", "签名与模板", "数据管理", "关于"]) {
    await root.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name, exact: true }).click();
    await expect(root.locator(".dm-settings-main>.dm-page-heading h2")).toHaveText(name);
    if (name === "关于") { await expect(root.locator(".dm-settings-card p").filter({ hasText: `DSH Mail ${packageInfo.version} ·` })).toBeVisible(); await shot(`about-version-${packageInfo.version}`); }
  }
  await root.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: "邮件与日历偏好", exact: true }).click();
  await resize(390); await noOverflow(); await shot("settings-light-390");
  await resize(1440);
  checks.push("reply composer, bulk controls, all functional pages, five settings categories, narrow settings");

  // Switch the actual isolated Host's appearance through its settings UI.
  await page.getByText("更多", { exact: true }).last().click();
  await page.getByText("设置", { exact: true }).last().click();
  await page.getByRole("button", { name: "深色", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-ds-dark-theme", "");
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await rail.getByRole("button", { name: "邮件", exact: true }).click();
  for (const width of [1440, 1024, 768, 390]) {
    await resize(width); await noOverflow(); await shot(`reader-dark-${width}`);
    if (width < 760) {
      await root.getByRole("button", { name: "返回邮件列表", exact: true }).click();
      await root.getByRole("button", { name: "打开文件夹列表", exact: true }).click();
      await shot(`drawer-dark-${width}`);
      await page.keyboard.press("Escape");
    }
  }
  await resize(1440);
  await rail.getByRole("button", { name: "日历", exact: true }).click(); await shot("calendar-dark");
  await rail.getByRole("button", { name: "设置", exact: true }).click(); await shot("settings-dark");
  await resize(390); await noOverflow(); await shot("settings-dark-390");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(root.getByRole("button", { name: "同步邮箱", exact: true })).toHaveCSS("transition-duration", "0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  checks.push("actual Host dark theme, four container sizes, dark drawer/calendar/settings, reduced motion");
  await resize(1440);
  await page.getByText("更多", { exact: true }).last().click();
  await page.getByText("设置", { exact: true }).last().click();
  await page.getByRole("button", { name: "浅色", exact: true }).click();
  await expect(page.locator("body")).not.toHaveAttribute("data-ds-dark-theme", "");
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await rail.getByRole("button", { name: "邮件", exact: true }).click();
  await row.locator("button.dm-message").click();
  const primary = root.getByRole("button", { name: "写邮件", exact: true }), background = await primary.evaluate((el) => getComputedStyle(el).backgroundColor);
  await primary.hover(); await expect(primary).not.toHaveCSS("background-color", background); await shot("button-hover-light");
  await root.getByRole("combobox", { name: "文件夹排序" }).selectOption("count-desc");
  await expect(root.getByRole("combobox", { name: "文件夹排序" })).toBeEnabled();
  await page.reload();
  await page.getByRole("navigation", { name: "全局面板", exact: true }).getByRole("button", { name: "DSH Mail", exact: true }).waitFor();
  await page.waitForTimeout(2500);
  if (await page.getByText("开始使用", { exact: true }).isVisible()) await page.keyboard.press("Escape");
  if (!await root.isVisible()) await page.getByRole("navigation", { name: "全局面板", exact: true }).getByRole("button", { name: "DSH Mail", exact: true }).click();
  await resize(1440);
  await expect(root.getByRole("combobox", { name: "文件夹排序" })).toHaveValue("count-desc");
  await account.getByLabel("管理文件夹 Altagram", { exact: true }).click();
  await expect(account.locator(".dm-folder-actions[open]").getByRole("button", { name: "文件夹颜色：紫色", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await root.getByRole("combobox", { name: "文件夹排序" }).selectOption("name-asc");
  await expect(root.getByRole("combobox", { name: "文件夹排序" })).toBeEnabled();
  await row.locator("button.dm-message").click(); await shot("final-light-1440");
  checks.push("primary button hover and browser reload persistence of sort/color");
  if (process.argv.includes("--prepare-restart")) {
    await root.getByRole("combobox", { name: "文件夹排序" }).selectOption("count-desc");
    await expect(root.getByRole("combobox", { name: "文件夹排序" })).toBeEnabled();
  }
  await page.getByRole("button", { name: "新建会话", exact: true }).first().click();
  await expect(page.locator("[data-phase=hero]")).toBeVisible();
  await expect(page.locator("[class*=heroOptions]").getByRole("button", { name: "打开 DSH Mail", exact: true })).toHaveCount(0);
  await page.screenshot({ path: ".cache/screenshots/navigation-new-conversation-no-entry.png" });
  await page.getByRole("navigation", { name: "全局面板", exact: true }).getByRole("button", { name: "DSH Mail", exact: true }).click();
  await expect(root).toBeVisible(); await resize(1440); await root.screenshot({ path: ".cache/screenshots/navigation-left-entry.png" });
  checks.push("conversation heroes omit the duplicate mail shortcut; left sidebar still opens the workspace");
  assert.deepEqual(errors, []);
  await writeFile(".cache/navigation-ui-verification.json", JSON.stringify({ checks, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ checks, pageErrors: errors }, null, 2));
} catch (error) {
  if (page) { await page.screenshot({ path: ".cache/screenshots/navigation-failure.png" }); await writeFile(".cache/navigation-failure.txt", await page.locator("body").innerText()); }
  throw error;
} finally { await browser.close(); }

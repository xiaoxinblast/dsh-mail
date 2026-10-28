// Requires the repository-local navigation and message fixtures; no real mail is sent.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const url = process.argv[2];
if (!url || new URL(url).hostname !== "127.0.0.1") throw new Error("Pass the isolated Host's complete 127.0.0.1 URL.");
const browser = await chromium.launch({ channel: "msedge", headless: true }), errors = [], checks = [];
let page, imageRequests = 0;
await mkdir(".cache/screenshots", { recursive: true });
try {
  page = await browser.newPage({ viewport: { width: 1920, height: 1000 } }); page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://mail-image.example.invalid/**", async (route) => { imageRequests++; await route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64") }); });
  await page.goto(url); await page.getByText("开始使用", { exact: true }).waitFor(); await page.keyboard.press("Escape"); await page.getByText("DSH Mail", { exact: true }).click();
  const root = page.locator(".dsh-mail"), rail = root.getByRole("navigation", { name: "功能导航" });
  const resize = async (width) => { await root.evaluate((el, width) => { el.style.width = `${width}px`; el.style.height = "900px"; el.style.flex = "none"; }, width); assert.equal(await root.evaluate((el) => el.clientWidth), width); };
  const shot = async (name) => { await page.waitForTimeout(220); await root.screenshot({ path: `.cache/screenshots/followup-${name}.png` }); };
  const noOverflow = async () => assert.ok(await root.evaluate((el) => el.scrollWidth <= el.clientWidth && [...el.querySelectorAll(".dm-workspace,.dm-calendar-main")].filter((item) => item.getClientRects().length).every((item) => item.scrollWidth <= item.clientWidth)), "No horizontal overflow");
  const setTheme = async (theme) => { if (await page.locator("body").evaluate((el) => el.hasAttribute("data-ds-dark-theme")) === (theme === "深色")) return; await page.getByText("更多", { exact: true }).last().click(); await page.getByText("设置", { exact: true }).last().click(); await page.getByRole("button", { name: theme, exact: true }).click(); await page.getByRole("button", { name: "关闭", exact: true }).last().click(); };
  await setTheme("浅色");
  await resize(1440);
  const subject = "[验收] 文件夹位置与图片加载";
  await root.locator(".dm-message-row").filter({ hasText: subject }).locator("button.dm-message").click();
  const locations = root.getByLabel("邮件所在文件夹", { exact: true }), body = () => root.frameLocator('iframe[title="邮件正文"]');
  await expect(locations.getByRole("button", { name: "[验收] 收件箱", exact: true })).toBeVisible();
  await expect(body().getByAltText("内嵌图片")).toHaveAttribute("src", /^data:image/);
  await expect(body().getByAltText("外部图片")).not.toHaveAttribute("src", /.+/); assert.equal(imageRequests, 0);
  await root.getByRole("button", { name: "添加或移动到文件夹", exact: true }).click();
  let dialog = root.getByRole("dialog"); await expect(dialog.getByRole("radio", { name: "复制，保留原邮件", exact: true })).toBeChecked();
  await dialog.getByRole("textbox", { name: "查找目标文件夹", exact: true }).fill("[验收] 项目 A");
  await dialog.getByRole("combobox", { name: "目标文件夹", exact: true }).selectOption({ label: "[验收] 项目 A" }); await shot("transfer-dialog-light");
  await dialog.getByRole("button", { name: "复制邮件", exact: true }).click(); await expect(dialog).toBeHidden({ timeout: 15000 });
  await expect(locations.getByRole("button", { name: "[验收] 项目 A", exact: true })).toBeVisible();
  await expect(locations.getByRole("button", { name: "[验收] 收件箱", exact: true })).toBeVisible(); await shot("locations-copy-light");
  await root.getByRole("button", { name: "添加或移动到文件夹", exact: true }).click(); dialog = root.getByRole("dialog");
  await dialog.getByRole("radio", { name: "移动，离开原位置", exact: true }).check();
  await dialog.getByRole("combobox", { name: "目标文件夹", exact: true }).selectOption({ label: "[验收] 项目 B" });
  await dialog.getByRole("button", { name: "移动邮件", exact: true }).click(); await expect(dialog).toBeHidden({ timeout: 15000 });
  await expect(locations.getByRole("button", { name: "[验收] 收件箱", exact: true })).toHaveCount(0);
  await expect(locations.getByRole("button", { name: "[验收] 项目 B", exact: true })).toBeVisible();
  await locations.getByRole("button", { name: "[验收] 项目 B", exact: true }).click();
  await expect(root.getByRole("img", { name: "所在文件夹：[验收] 项目 B", exact: true })).toBeVisible(); await shot("locations-move-light");
  checks.push("real UI copies preserve source, moves change current location, same-message chips and list corner agree");

  const imagePreference = async (enabled) => { await rail.getByRole("button", { name: "设置", exact: true }).click(); await root.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: "邮件与日历偏好", exact: true }).click(); const checkbox = root.getByRole("checkbox", { name: "默认加载外部图片（HTTPS）", exact: true }); await checkbox.setChecked(enabled); const save = root.getByRole("button", { name: "保存偏好", exact: true }); if (await save.isEnabled()) { await save.click(); await expect(save).toBeDisabled(); } };
  await imagePreference(true); assert.equal(imageRequests, 0, "Hidden reader does not fetch external images"); await shot("image-preference-light");
  await rail.getByRole("button", { name: "邮件", exact: true }).click(); await expect(body().getByAltText("外部图片")).toHaveAttribute("src", "https://mail-image.example.invalid/sample.png"); await expect.poll(() => imageRequests).toBeGreaterThan(0);
  await shot("images-allowed-light"); await root.getByRole("button", { name: "阻止图片", exact: true }).click(); await expect(body().getByAltText("外部图片")).not.toHaveAttribute("src", /.+/);
  await locations.getByRole("button", { name: "[验收] 项目 A", exact: true }).click(); await expect(body().getByAltText("外部图片")).toHaveAttribute("src", "https://mail-image.example.invalid/sample.png");
  await page.reload(); await page.getByText("DSH Mail", { exact: true }).waitFor(); await page.waitForTimeout(2500); if (await page.getByText("开始使用", { exact: true }).isVisible()) await page.keyboard.press("Escape"); if (!await root.isVisible()) await page.getByText("DSH Mail", { exact: true }).click(); await resize(1440);
  await rail.getByRole("button", { name: "设置", exact: true }).click(); await root.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: "邮件与日历偏好", exact: true }).click(); await expect(root.getByRole("checkbox", { name: "默认加载外部图片（HTTPS）", exact: true })).toBeChecked();
  await imagePreference(false); checks.push("CID works while external images are blocked; global default, one-message override, new-message reset and reload persistence");

  await rail.getByRole("button", { name: "日历", exact: true }).click();
  if (await root.getByRole("status").getByRole("button", { name: "×", exact: true }).isVisible()) await root.getByRole("status").getByRole("button", { name: "×", exact: true }).click();
  const active = root.locator(".fc-event:visible").filter({ hasText: "进行中 · 本周翻译交付" }).first(), ended = root.locator(".fc-event:visible").filter({ hasText: "已结束 · 项目交付" }).first();
  await expect(active).toBeVisible(); await expect(active).toHaveCSS("background-color", "rgb(34, 219, 244)"); await expect(ended).toHaveCSS("background-color", "rgb(189, 244, 252)");
  assert.ok((await root.locator(".fc-view-harness").boundingBox()).height >= 650, "Calendar uses the available height");
  await expect(root.locator(".dm-mini-calendar")).toBeVisible();
  const title = await root.locator(".fc-toolbar-title").innerText(); await root.getByRole("button", { name: "小月历下一月", exact: true }).click(); await expect(root.locator(".fc-toolbar-title")).not.toHaveText(title); await root.locator(".fc-today-button").click();
  await root.getByRole("checkbox", { name: "显示日历：我的日历", exact: true }).uncheck(); await expect(active).toHaveCount(0); await root.getByRole("checkbox", { name: "显示日历：我的日历", exact: true }).check(); await expect(active).toBeVisible();
  await root.locator(".fc-header-toolbar").getByRole("button", { name: "日程", exact: true }).click();
  const inherited = root.locator(".fc-event:visible").filter({ hasText: "[验收] 跟随日历颜色" }).first(); await inherited.click(); dialog = root.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "跟随日历颜色", exact: true })).toHaveAttribute("aria-pressed", "true");
  const originalDates = await dialog.locator('input[type="date"]').evaluateAll((items) => items.map((item) => item.value));
  await dialog.getByRole("button", { name: "保存事件", exact: true }).click(); await expect(dialog).toBeHidden();
  await inherited.click(); dialog = root.getByRole("dialog"); await expect(dialog.getByRole("button", { name: "跟随日历颜色", exact: true })).toHaveAttribute("aria-pressed", "true"); assert.deepEqual(await dialog.locator('input[type="date"]').evaluateAll((items) => items.map((item) => item.value)), originalDates);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click(); await root.locator(".fc-header-toolbar").getByRole("button", { name: "月", exact: true }).click();
  checks.push("editing an existing inherited-color event preserves its color policy and all-day dates");
  await root.getByRole("button", { name: "新事件", exact: true }).click(); dialog = root.getByRole("dialog"); await expect(dialog.getByRole("button", { name: "事件颜色：亮青", exact: true })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("textbox", { name: "事件名称", exact: true }).fill("[验收] 新事件正常色"); await dialog.locator('button[type="submit"]').click(); await expect(dialog).toBeHidden();
  await expect(root.locator(".fc-event").filter({ hasText: "[验收] 新事件正常色" }).first()).toHaveCSS("background-color", "rgb(34, 219, 244)");
  for (const width of [1440, 1024, 768, 390]) { await resize(width); await noOverflow(); await shot(`calendar-light-${width}`); if (width < 1000) { await root.getByRole("button", { name: "打开日历列表", exact: true }).click(); await shot(`calendar-panel-light-${width}`); await page.keyboard.press("Escape"); await expect(root.getByRole("button", { name: "打开日历列表", exact: true })).toBeFocused(); } }
  checks.push("full-height calendar, mini-month navigation, calendar visibility, normal new events and faded ended events across four widths");

  const hoverRail = async (theme) => { await resize(1440); for (const button of await rail.locator("button").all()) { const name = await button.getAttribute("aria-label"); await page.mouse.move(1850,950); await page.waitForTimeout(180); const before = await button.evaluate((el) => getComputedStyle(el).backgroundColor); await button.hover(); await expect(button).not.toHaveCSS("background-color", before); await shot(`rail-${theme}-${name}`); } };
  await hoverRail("light");
  await setTheme("深色"); await expect(page.locator("body")).toHaveAttribute("data-ds-dark-theme", "");
  await hoverRail("dark");
  for (const width of [1440, 768, 390]) { await resize(width); await noOverflow(); await shot(`calendar-dark-${width}`); }
  await page.emulateMedia({ reducedMotion: "reduce" }); await rail.getByRole("button", { name: "日历", exact: true }).hover(); await expect(rail.getByRole("button", { name: "日历", exact: true }).locator("svg")).toHaveCSS("transform", "none"); await page.emulateMedia({ reducedMotion: "no-preference" });
  checks.push("every rail icon has visible hover feedback in both themes, including the selected icon; reduced motion removes icon movement");
  await resize(1440); await setTheme("浅色");
  assert.deepEqual(errors, []); await writeFile(".cache/message-ui-verification.json", JSON.stringify({ checks, pageErrors: errors, imageRequests }, null, 2)); console.log(JSON.stringify({ checks, pageErrors: errors, imageRequests }, null, 2));
} catch (error) { if (page) { await page.screenshot({ path: ".cache/screenshots/followup-failure.png" }); await writeFile(".cache/followup-failure.txt", `${error.stack}\n\n${await page.locator("body").innerText()}`); } throw error; }
finally { await browser.close(); }

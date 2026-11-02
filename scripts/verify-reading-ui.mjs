// Real isolated DSH Host only; run seed-reading-fixtures.mjs first.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import JSZip from "jszip";

const url = process.argv[2] || (await readFile(".cache/reading-host.log", "utf8")).match(/http:\/\/127\.0\.0\.1:[^\s]+/)?.[0];
if (!url || new URL(url).hostname !== "127.0.0.1") throw new Error("Pass the isolated Host's loopback URL.");
const browser = await chromium.launch({ channel: "msedge", headless: true }), errors = [], checks = [];
await mkdir(".cache/screenshots", { recursive: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 2100, height: 1300 } }); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url); await page.getByRole("navigation", { name: "全局面板", exact: true }).waitFor(); await page.keyboard.press("Escape");
  await page.getByRole("navigation", { name: "全局面板", exact: true }).getByRole("button", { name: "DSH Mail", exact: true }).click();
  const root = page.locator(".dsh-mail:visible"), rail = root.getByRole("navigation", { name: "功能导航" }), folders = rail.getByRole("button", { name: "邮箱与文件夹", exact: true });
  const resize = async (width, height = 900) => { await root.evaluate((el, size) => { el.style.width = `${size.width}px`; el.style.height = `${size.height}px`; el.style.flex = "none"; }, { width, height }); await expect.poll(() => root.evaluate((el) => el.clientWidth)).toBe(width); };
  const shot = (name) => root.screenshot({ path: `.cache/screenshots/reading-${name}.png` });
  const noOverflow = async () => assert.ok(await root.evaluate((el) => el.scrollWidth <= el.clientWidth && [...el.querySelectorAll(".dm-mail-layout,.dm-list-pane,.dm-detail-pane,.dm-attachment-grid")].filter((x) => x.getClientRects().length).every((x) => x.scrollWidth <= x.clientWidth)), "No horizontal overflow");
  const open = async (name) => { await rail.getByRole("button", { name: "邮件", exact: true }).click(); const input = root.getByRole("textbox", { name: "搜索邮件", exact: true }); await input.fill(`[验收] ${name}`); await input.press("Enter"); const row = root.locator(".dm-message-row").filter({ has: page.getByRole("heading", { name: `[验收] ${name}`, exact: true }) }); await row.locator("button.dm-message").click(); await expect(root.locator(".dm-reader h2")).toHaveText(`[验收] ${name}`); return row; };
  const theme = async (name) => { if (await page.locator("body").evaluate((el) => el.hasAttribute("data-ds-dark-theme")) === (name === "深色")) return; await page.getByText("更多", { exact: true }).last().click(); await page.getByText("设置", { exact: true }).last().click(); await page.getByRole("button", { name, exact: true }).click(); await page.getByRole("button", { name: "关闭", exact: true }).last().click(); };
  await theme("浅色"); await resize(1440);
  await expect(root.locator(".dm-folders")).toBeHidden(); await expect(root.getByRole("separator")).toHaveCount(1);
  await folders.click(); await expect(root.getByRole("textbox", { name: "查找文件夹" })).toBeFocused();
  await root.getByRole("textbox", { name: "查找文件夹" }).fill("项目"); await shot("folders-light");
  await page.keyboard.press("Escape"); await expect(folders).toBeFocused(); await expect(root.locator(".dm-folders")).toBeHidden();
  await folders.click(); const backdrop = root.getByRole("button", { name: "关闭文件夹列表", exact: true }), box = await backdrop.boundingBox(); await backdrop.click({ position: { x: box.width - 3, y: box.height - 3 } }); await expect(folders).toBeFocused();
  await folders.click(); await root.getByRole("textbox", { name: "查找文件夹" }).fill("[验收] 项目 A"); await root.locator(".dm-folder-row>button").filter({ hasText: "[验收] 项目 A" }).click(); await expect(root.locator(".dm-folders")).toBeHidden(); await expect(root.locator(".dm-list-heading h2")).toHaveText("[验收] 项目 A");
  await rail.getByRole("button", { name: "已发送", exact: true }).click(); await expect(root.locator(".dm-list-heading h2")).toHaveText("已发送");
  await rail.getByRole("button", { name: "星标邮件", exact: true }).click(); await expect(root.locator(".dm-list-heading h2")).toHaveText("星标邮件");
  await rail.getByRole("button", { name: "草稿与发件箱", exact: true }).click(); await expect(root.locator(".dm-list-heading h2")).toHaveText("草稿与发件箱");
  checks.push("two panes at desktop width, rail mailbox navigation, folder search/select, Escape/backdrop and focus restoration");

  const row = await open("无附件的共享通知");
  const frame = () => root.frameLocator('iframe[title="邮件正文"]');
  await expect(frame().getByRole("heading", { name: "项目资料已共享", exact: true })).toBeVisible();
  await expect(frame().locator('img[src^="data:image/"]')).toHaveCount(4);
  await expect(root.getByRole("region", { name: "邮件附件", exact: true })).toHaveCount(0); await expect(row.locator(".dm-message-bottom svg")).toHaveCount(0);
  await expect(frame().locator("script,form,input,iframe,object")).toHaveCount(0);
  assert.equal(await root.locator('iframe[title="邮件正文"]').evaluate((el) => !el.sandbox.contains("allow-scripts") && !el.sandbox.contains("allow-forms") && !el.sandbox.contains("allow-top-navigation")), true);
  await shot("inline-only-light-1440"); checks.push("legacy five-part phantom fixture shows zero downloads while all four CID images render; scripts/forms/top-navigation remain sandboxed");

  await open("长邮件正文阅读");
  const height = () => root.locator('iframe[title="邮件正文"]').evaluate((el) => el.clientHeight);
  await expect.poll(height).toBeGreaterThan(3000); const normal = await height();
  assert.equal(await frame().locator("body").evaluate((el) => el.scrollHeight <= window.innerHeight), true);
  await resize(768); await expect.poll(height).toBeGreaterThan(normal); await resize(1440);
  for (const width of [1920, 1440, 1100, 1024, 768, 390]) { await resize(width); await noOverflow(); await expect(root.locator(".dm-folders")).toBeHidden(); await expect(root.getByRole("separator")).toHaveCount(width >= 760 ? 1 : 0); await shot(`long-light-${width}`); }
  checks.push("body height fits full content without inner vertical scroll, reflows with width, long mail and layouts at 1920/1440/1100/1024/768/390px");

  await resize(1440); await open("附件缩略图与文档类型");
  const cards = root.locator(".dm-attachment"); await expect(cards).toHaveCount(5);
  for (const label of ["Word", "PDF", "Excel", "压缩文件"]) await expect(cards.locator(".dm-file-type").filter({ hasText: label })).toBeVisible();
  const image = cards.filter({ hasText: "山景示意图.png" }); await image.scrollIntoViewIfNeeded(); await expect(image.locator("img")).toBeVisible(); await expect.poll(() => image.locator("img").evaluate((el) => el.naturalWidth)).toBe(320);
  await noOverflow(); await shot("attachments-light-1440");
  await image.getByRole("button", { name: "预览", exact: true }).click(); await expect(root.locator(".dm-image-preview")).toBeVisible(); await shot("image-preview-light"); await root.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await cards.filter({ hasText: "项目交付说明.docx" }).getByRole("button", { name: "预览", exact: true }).click(); await expect(root.getByRole("dialog")).toContainText("此类型不在应用内预览"); await root.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await root.getByRole("button", { name: "收起附件", exact: true }).click(); await expect(root.locator(".dm-attachment-grid")).toBeHidden(); await shot("attachments-collapsed-light-1440");
  const downloaded = page.waitForEvent("download"); await root.getByRole("button", { name: "打包下载全部附件", exact: true }).click(); const file = await downloaded; await file.saveAs(".cache/reading-attachments.zip");
  const zip = await JSZip.loadAsync(await readFile(".cache/reading-attachments.zip")), names = Object.keys(zip.files); assert.equal(names.length, 5); assert.ok(names.some((name) => name.endsWith("山景示意图.png"))); assert.ok(!names.some((name) => name.includes("signature")));
  await root.getByRole("button", { name: "展开附件", exact: true }).click(); await expect(root.locator(".dm-attachment-grid")).toBeVisible(); assert.equal(await image.locator(".dm-attachment-art").evaluate((el) => el.clientHeight), 46);
  await resize(390); await image.scrollIntoViewIfNeeded(); await noOverflow(); await shot("attachments-light-390");
  await theme("深色"); await resize(1440); await image.scrollIntoViewIfNeeded(); await shot("attachments-dark-1440"); await root.getByRole("button", { name: "收起附件", exact: true }).click(); await shot("attachments-collapsed-dark-1440"); await root.getByRole("button", { name: "展开附件", exact: true }).click(); await resize(390); await image.scrollIntoViewIfNeeded(); await shot("attachments-dark-390");
  checks.push("compact 48px thumbnails with actual image content and document type art, collapse/expand, download while collapsed, ZIP contains exactly five real downloads, light/dark and mobile cards");

  await resize(1440); await open("附件异常与长文件名"); const broken = cards.filter({ hasText: "无法解码的图片.png" }); await broken.scrollIntoViewIfNeeded(); await expect(broken).toContainText("缩略图未加载，可尝试预览或下载"); await expect(cards).toHaveCount(2); await resize(390); await broken.scrollIntoViewIfNeeded(); await noOverflow(); await shot("thumbnail-fallback-long-name-dark-390");
  checks.push("undecodable image falls back without breaking the reader; unknown document and long filename fit narrow cards");

  await resize(1440); await open("无附件的共享通知"); await shot("inline-only-dark-1440"); await folders.click(); await shot("folders-dark"); await page.keyboard.press("Escape");
  await open("纯文本阅读"); await expect(root.locator('iframe[title="邮件正文"]')).toHaveCount(0); await expect(root.locator(".dm-mail-body pre")).toContainText("纯文本邮件也应正常显示"); await noOverflow(); await shot("plain-dark");
  await theme("浅色");
  assert.deepEqual(errors, []); checks.push("plain-text body and link preserved, no page errors");
  await writeFile(".cache/reading-ui-verification.json", JSON.stringify({ passed: true, checks, pageErrors: errors, bodyHeight: normal }, null, 2)); console.log(JSON.stringify({ passed: true, checks, pageErrors: errors }));
} catch (error) { if (page) { await page.screenshot({ path: ".cache/screenshots/reading-failure.png" }); await writeFile(".cache/reading-failure.txt", (await page.locator("body").innerText()).slice(0, 16000)); } throw error; }
finally { await browser.close(); }

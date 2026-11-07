import { chromium } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const log = await readFile(".cache/current-host.log", "utf8"), url = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0];
if (!url) throw new Error("Start the repository-local isolated Host first.");
await mkdir("output/playwright", { recursive: true });
const verify = (0, eval)(`(${await readFile("scripts/verify-workspace-fullscreen-ui.js", "utf8")})`);
const browser = await chromium.launch({ channel: "msedge", headless: true }), page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
try {
  await page.goto(url); await page.getByText("请查看完整引用并创建回复草", { exact: true }).click();
  await page.getByRole("button", { name: "打开 DSH Mail", exact: true }).click();
  const result = await verify(page); await writeFile(".cache/fullscreen-native-verification.json", JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (e) { await page.screenshot({ path: ".cache/screenshots/fullscreen-native-failure.png" }); await writeFile(".cache/fullscreen-native-failure.txt", await page.locator("body").innerText()); throw e; }
finally { await browser.close(); }

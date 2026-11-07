// Isolated UI benchmark: synthetic data, no network mail or model calls.
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
const sourceRoot = resolve(process.env.DSH_MAIL_PERF_SOURCE || ".");
const { MailService } = await import(pathToFileURL(resolve(sourceRoot, "src/service.mjs")));
const phase = process.argv[2] || "after", count = Number(process.env.DSH_MAIL_PERF_COUNT || 100000);
await mkdir(".cache", { recursive: true });
const directory = process.env.DSH_MAIL_PERF_REUSE ? resolve(process.env.DSH_MAIL_PERF_REUSE) : await mkdtemp(resolve(".cache/ui-benchmark-"));
assert.ok(directory.startsWith(resolve(".cache") + sep), "Benchmark data must stay in the repository cache");
const service = new MailService({ directory, transport: { close: async () => {} } });
if (!process.env.DSH_MAIL_PERF_REUSE) {
for (let i = 0; i < 3; i++) {
  service.store.put("accounts", { id: `a${i}`, name: `合成邮箱 ${i + 1}`, email: `me${i}@example.invalid`, local: true, enabled: true });
  service.store.put("folders", { id: `f${i}`, accountId: `a${i}`, path: "INBOX", role: "\\Inbox" });
}

for (let start = 0; start < count; start += 1000) service.store.transaction(() => {
  for (let i = start; i < Math.min(count, start + 1000); i++) service.store.upsertMessage({ id: `m${i}`, accountId: `a${i % 3}`, folderId: `f${i % 3}`, uidValidity: "1", uid: i + 1, messageId: `<${i}@example.invalid>`, date: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), subject: `合成项目进展 ${i}`, text: `本次交付确认 ${i}`, html: i >= count - 20 ? "<p>长邮件段落，验证滚动和布局测量。</p>".repeat(250) : "", from: [{ name: "项目团队", address: "client@example.invalid" }], to: [], attachments: [], flags: ["\\Seen"], seen: true, bodyLoaded: true });
});
service.store.transaction(() => {
  for (let i = 0; i < 200; i++) service.store.put("drafts", { id: `d${i}`, accountId: "a0", subject: `合成草稿 ${i}`, text: "草稿内容".repeat(500), status: "draft", attachments: [] });
  for (let i = 0; i < 1000; i++) service.store.put("contacts", { id: `c${i}`, name: `联系人 ${i}`, email: `person${i}@example.invalid`, group: "合成" });
  for (let i = 0; i < 500; i++) service.store.put("tasks", { id: `t${i}`, title: `待办 ${i}`, done: i % 3 === 0, priority: "normal" });
});
}
assert.equal(service.store.db.prepare("SELECT count(*) AS n FROM messages").get().n, count);
assert.ok(service.store.list("accounts").every((a) => a.local && /^me[0-2]@example.invalid$/.test(a.email)));
await service.invoke({ action: "settings.save", value: { mailListWidth: 340, mailFolderWidth: 240 } }, { kind: "human" });
const built = await build({ stdin: { contents: "import React from 'react';import{createRoot}from'react-dom/client';import{App}from'./ui/workbench.jsx';createRoot(document.getElementById('root')).render(<App call={async(_id,operation,signal)=>{const r=await fetch('/api',{method:'POST',body:JSON.stringify(operation),signal});const v=await r.json();if(v.error)throw new Error(v.error);return v;}}/>);", resolveDir: sourceRoot, loader: "jsx" }, bundle: true, write: false, format: "iife", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
const requests = [];
const server = createServer(async (req, res) => {
  if (req.url === "/client.js") { res.setHeader("Content-Type", "text/javascript"); res.end(built.outputFiles[0].text); return; }
  if (req.url === "/api") {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const operation = JSON.parse(Buffer.concat(chunks)), start = performance.now();
    try { const value = JSON.stringify(await service.invoke(operation, { kind: "human" })); requests.push({ action: operation.action, ms: performance.now() - start, bytes: Buffer.byteLength(value) }); res.setHeader("Content-Type", "application/json"); res.end(value); }
    catch (e) { res.end(JSON.stringify({ error: e.message })); } return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<!doctype html><style>:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f6fa;--dsw-alias-border-l2:#d7dce5;--dsw-alias-label-primary:#17212b;--dsw-alias-label-secondary:#5a6675;--dsw-alias-brand-primary:#2563eb}body{margin:0;font:14px system-ui}#root{height:100vh}</style><div id="root"></div><script src="/client.js"></script>');
});
let browser;
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => { window.longTasks = []; new PerformanceObserver((list) => window.longTasks.push(...list.getEntries().map((e) => e.duration))).observe({ type: "longtask", buffered: true }); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator(".dm-message-row").first().waitFor();
  const rows = page.locator("button.dm-message"), latencies = [], feedback = [], automationLatencies = [];
  // First read warms the account conversation index; measure subsequent cached reads.
  for (let i = 0; i < 21; i++) {
    const start = performance.now();
    const timing = await rows.nth(i % 10).evaluate((el) => new Promise((done, reject) => {
      const subject = el.querySelector("h3").textContent, start = performance.now(); let feedback;
      el.click();
      const frame = () => {
        if (!feedback && el.closest(".dm-message-row").classList.contains("selected")) feedback = performance.now() - start;
        const body = document.querySelector(".dm-mail-body iframe");
        if (document.querySelector(".dm-reader h2")?.textContent === subject && body?.contentDocument?.body?.textContent.includes("长邮件段落") && parseInt(body.style.height) > 1000) return done({ feedback, open: performance.now() - start });
        if (performance.now() - start > 20000) return reject(new Error("Mail did not render"));
        requestAnimationFrame(frame);
      }; requestAnimationFrame(frame);
    }));
    if (i) { latencies.push(timing.open); feedback.push(timing.feedback); automationLatencies.push(performance.now() - start); }
  }
  await page.evaluate(() => { window.frameTimes = []; let last = performance.now(); window.sampleFrames = true; const frame = (at) => { if (!window.sampleFrames) return; window.frameTimes.push(at - last); last = at; requestAnimationFrame(frame); }; requestAnimationFrame(frame); });
  const divider = page.getByRole("separator", { name: "调整邮件列表宽度" }), box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 120); await page.mouse.down();
  for (let i = 0; i < 80; i++) { await page.mouse.move(box.x + Math.sin(i / 10) * 110, box.y + 120); await page.locator(".dm-detail-pane").evaluate((el) => el.scrollTop += 20); }
  await page.mouse.up();
  const frames = await page.evaluate(() => { window.sampleFrames = false; return window.frameTimes; });
  const openRequests = [...requests];
  await page.waitForTimeout(1000); requests.length = 0; await page.evaluate(() => window.longTasks = []); await page.waitForTimeout(11000);
  const p95 = (values) => +values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * .95)].toFixed(2);
  const report = { phase, messages: count, accounts: 3, drafts: 200, contacts: 1000, cachedOpenP95Ms: p95(latencies), feedbackP95Ms: p95(feedback), automationP95Ms: p95(automationLatencies), openSamplesMs: latencies, openRequests, frameP95Ms: p95(frames), idleRequests: requests, idleLongTasks: await page.evaluate(() => window.longTasks), errors, limitations: "合成本地数据；不代表真实邮箱网络、日常宿主或模型延迟。" };
  await page.screenshot({ path: `.cache/ui-benchmark-${phase}.png` });
  await writeFile(`.cache/ui-benchmark-${phase}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await new Promise((done) => server.close(done)); await service.close(); }

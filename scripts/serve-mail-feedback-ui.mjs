// Isolated real App + MailService with synthetic mail and a controllable transport.
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { MailService } from "../src/service.mjs";
import { normalizeAccount } from "../src/mail.mjs";

await mkdir(".cache", { recursive: true });
await mkdir("output/playwright/mail-feedback", { recursive: true });
const requests = [], sends = [];
let clockOffset = 0, nextUid = 100;
const service = new MailService({ directory: await mkdtemp(resolve(".cache/mail-feedback-")), clock: () => Date.now() + clockOffset, transport: {
  close: async () => {}, flags: async () => {}, findSent: async () => [1],
  move: async (_account, _folder, message) => ({ uidValidity: "1", uidMap: new Map([[message.uid, ++nextUid]]) }),
  copy: async (_account, _folder, message) => ({ uidValidity: "1", uidMap: new Map([[message.uid, ++nextUid]]) }),
  send: async (_account, _raw, envelope) => new Promise((resolve, reject) => sends.push({ envelope, resolve, reject }))
} });
service.store.put("accounts", { ...normalizeAccount({ id: "demo", name: "项目协作", email: "me@example.invalid", imapHost: "127.0.0.1", smtpHost: "127.0.0.1" }), authFailed: true, status: "connected", folders: { sent: "sent", archive: "archive", junk: "junk", trash: "trash" } });
for (const [id, path, role] of [["inbox", "INBOX", "\\Inbox"], ["sent", "已发送", "\\Sent"], ["archive", "归档", "\\Archive"], ["junk", "垃圾邮件", "\\Junk"], ["trash", "废纸篓", "\\Trash"], ["projects", "项目文件夹", ""]]) service.store.put("folders", { id, path, role, accountId: "demo", uidValidity: "1", selectable: true });
for (let i = 0; i < 18; i++) service.store.upsertMessage({ id: `message-${i}`, accountId: "demo", folderId: "inbox", uidValidity: "1", uid: i + 1, messageId: `<message-${i}@example.invalid>`, subject: ["十一月项目交付安排", "设计稿确认与下一步计划", "本周协作进度"][i % 3] + ` ${i}`, date: new Date(Date.now() - i * 3600000).toISOString(), from: [{ name: "项目经理", address: "client@example.invalid" }], to: [{ address: "me@example.invalid" }], cc: [{ address: "team@example.invalid" }], text: "请确认交付时间，期待你的回复。", html: "<p>请确认交付时间，期待你的回复。</p>", attachments: [], flags: [], bodyLoaded: true });
await service.invoke({ action: "settings.save", value: { theme: "light", markReadOnOpen: true } }, { kind: "human" });
service.start();
const built = await build({ stdin: { contents: "import React from 'react';import{createRoot}from'react-dom/client';import{App}from'./ui/workbench.jsx';const call=async(_id,operation,signal)=>{const r=await fetch('/api',{method:'POST',body:JSON.stringify(operation),signal});const v=await r.json();if(v.fixtureError)throw new Error(v.fixtureError);return v;};createRoot(document.getElementById('root')).render(<App sessionId='feedback-ui' call={call}/>);", resolveDir: process.cwd(), loader: "jsx" }, bundle: true, write: false, loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/client.js") { res.setHeader("Content-Type", "text/javascript"); res.end(built.outputFiles[0].text); return; }
    if (req.url === "/api" || req.url === "/control") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const args = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      let result;
      if (req.url === "/api") { requests.push(args); result = await service.invoke(args, { kind: "human", sessionId: "feedback-ui" }); }
      else if (args.advance) { clockOffset += args.advance; result = { advanced: clockOffset }; }
      else if (args.finish) {
        const sending = sends.shift(); if (!sending) throw new Error("No synthetic send in progress");
        if (args.finish === "failed") sending.reject(Object.assign(new Error("测试服务器拒绝发送"), { responseCode: 550 }));
        else if (args.finish === "uncertain") sending.reject(Object.assign(new Error("测试连接中断，发送结果未知"), { code: "ECONNRESET" }));
        else sending.resolve({ accepted: sending.envelope.to, rejected: [] });
        result = { finished: args.finish };
      } else if (args.settings) result = await service.invoke({ action: "settings.save", value: args.settings }, { kind: "human" });
      else result = { requests, sending: sends.length, drafts: service.store.list("drafts"), messages: service.store.folderMessages("inbox"), jobs: service.store.list("jobs") };
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result)); return;
    }
    res.setHeader("Content-Type", "text/html;charset=utf-8");
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DSH Mail 交互验收</title><style>:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f6fa;--dsw-alias-border-l2:#d7dce5;--dsw-alias-label-primary:#17212b;--dsw-alias-label-secondary:#5a6675;--dsw-alias-brand-primary:#2563eb;--dsw-alias-state-error-primary:#c44555}body{margin:0;font:14px system-ui}#root{height:100vh}</style><div id="root"></div><script src="/client.js"></script></html>');
  } catch (error) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ fixtureError: error.message })); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}`;
await writeFile(".cache/mail-feedback-url.txt", url); console.log(url);
process.on("SIGINT", async () => { for (const send of sends.splice(0)) send.reject(new Error("Fixture stopped")); await service.close(); server.close(); });

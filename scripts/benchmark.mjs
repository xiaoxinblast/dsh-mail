import { Store } from "../src/store.mjs";
import { mkdir, mkdtemp, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
await mkdir(".cache", { recursive: true });
const directory = await mkdtemp(resolve(".cache/benchmark-")), store = new Store(directory);
const count = Number(process.env.DSH_MAIL_BENCH_COUNT || 100000), started = performance.now();
try {
  for (let start = 0; start < count; start += 500) {
    store.transaction(() => { for (let i = start; i < Math.min(count, start + 500); i++) store.upsertMessage({ accountId: `account-${i % 3}`, folderId: `inbox-${i % 3}`, uidValidity: "1", uid: i + 1, date: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), subject: `${i % 4 === 0 ? "项目报价 日本語見積書" : "项目进展"} ${i}`, text: `测试数据 ${i}，交付时间安排。This is a synthetic performance fixture.`, from: [{ name: "测试客户", address: `client${i % 100}@example.com` }], to: [{ address: "me@example.com" }], flags: i % 10 ? ["\\Seen"] : [], bodyLoaded: true }); });
    if (start % 10000 === 0) console.log(`Indexed ${start + 500}/${count}`);
    await new Promise((r) => setImmediate(r));
  }
  const populatedMs = performance.now() - started, results = [];
  for (const [name, query] of [["first-page", {}], ["page-1000", { offset: 50000 }], ["chinese-search", { q: "报价" }], ["japanese-search", { q: "見積書" }], ["sender", { from: "client42@" }]]) {
    const times = [];
    for (let n = 0; n < 5; n++) { const before = performance.now(), result = store.search(query); times.push(performance.now() - before); if (!result.total) throw new Error(`Missing benchmark rows: ${name}`); }
    results.push({ name, medianMs: Number(times.sort((a,b) => a-b)[2].toFixed(2)), maxMs: Number(Math.max(...times).toFixed(2)) });
  }
  const report = { node: process.version, platform: process.platform, accounts: 3, messages: count, populatedMs: Math.round(populatedMs), databaseBytes: (await stat(store.path)).size, results, limitations: "合成数据的本机数据库基准；不代表真实 163 网络同步性能或 UI 帧率。" };
  await writeFile(".cache/benchmark.json", JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { store.close(); }

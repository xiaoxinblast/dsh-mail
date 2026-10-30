import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
assert.equal(lock.version, pkg.version); assert.equal(lock.packages[""].version, pkg.version);
assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml"); assert.equal(pkg.engines.dsh, "0.2.1-rc.5");
for (const range of Object.values(pkg.peerDependencies)) assert.equal(range, pkg.engines.dsh);
const bundle = await readFile("dist/client.js", "utf8"); assert.ok(bundle.startsWith('window.__ModuleLoader__.load({id:"dsh-mail",factory(require)')); assert.ok(!bundle.includes('chunk:"client.js"'));
assert.ok((await stat("dist/client.js")).size < 15 * 1024 * 1024);
for (const file of ["dsh/index.mjs", "dsh/agent.mjs", "dsh/bridge.mjs", "src/service.mjs", "src/store.mjs", "src/mail.mjs", "src/calendar.mjs", "src/vault.mjs", "src/rules.mjs", "src/notifications.mjs", "src/conversations.mjs", "ui/mail-layout.mjs"]) execFileSync(process.execPath, ["--check", file]);
const prohibited = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{25,}\b/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/];
async function scan(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { if (["node_modules", ".cache", ".dsh-meow", ".git"].includes(entry.name)) continue; const file = join(dir, entry.name); if (entry.isDirectory()) await scan(file); else { assert.ok(!/\.(?:sqlite|db|log|eml|mbox)$/i.test(file), `Runtime/private file: ${file}`); if (/\.(?:mjs|jsx|js|json|md|yml|yaml|css)$/.test(file)) { const text = await readFile(file, "utf8"); for (const pattern of prohibited) assert.ok(!pattern.test(text), `Possible secret: ${file}`); } } } }
await scan(".");
console.log("Bundle metadata, compatibility, syntax, build size and public-source secret pattern checks passed.");

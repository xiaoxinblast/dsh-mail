import { createHash, randomUUID } from "node:crypto";
import { basename, resolve, sep } from "node:path";

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const digest = (value) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
export function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export function requireValue(condition, code, message) { if (!condition) fail(code, message); }
export function errorInfo(error) {
  const text = String(error?.message || error).replace(/(password|pass|authorization|token)[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
  let code = error?.code || "OPERATION_FAILED", message = text;
  if (/unsafe login/i.test(text)) { code = "IMAP_ID_REQUIRED"; message = "网易拒绝客户端身份，请检查 IMAP ID 配置与网页安全提醒。"; }
  else if (/authentication|login failed|authorization code|invalid credentials|535/i.test(text)) { code = "AUTHENTICATION_FAILED"; message = "认证失败：请在网页开启 IMAP/SMTP 并重新生成客户端授权码。"; }
  else if (/certificate|tls|ssl/i.test(text)) { code = "TLS_FAILED"; message = "安全连接失败，请检查服务器地址、端口与证书。"; }
  else if (/quota|over.?limit|too many|rate.?limit/i.test(text)) { code = "SERVER_LIMIT"; message = "邮箱服务器配额或访问频率限制，请稍后重试。"; }
  else if (/timeout|etimedout|econn|enotfound|network/i.test(text)) { code = "NETWORK_FAILED"; message = "无法连接邮箱服务器，请检查网络与服务器配置。"; }
  return { code, message: message.slice(0, 800) };
}
export function cleanFilename(name) {
  const result = basename(String(name || "attachment").replaceAll("\\", "/")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
  return (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(result) ? `_${result}` : result || "attachment").slice(0, 180);
}
export function inside(root, name) {
  const path = resolve(root, name), base = resolve(root);
  requireValue(path.startsWith(base + sep), "INVALID_PATH", "文件路径必须位于所选目录内。");
  return path;
}
export function bounded(value, fallback = 50, max = 200) { return Math.min(max, Math.max(1, Math.trunc(Number(value) || fallback))); }
export function addresses(value) {
  if (Array.isArray(value)) return value.flatMap(addresses);
  if (value?.value) return value.value.map((item) => ({ name: item.name || "", address: String(item.address || "").toLowerCase() }));
  if (value?.address) return [{ name: value.name || "", address: String(value.address).toLowerCase() }];
  return String(value || "").split(/[,;\n]/).map((s) => {
    const match = s.trim().match(/^(.*?)<([^<>]+)>$/);
    return { name: match ? match[1].trim().replace(/^"|"$/g, "") : "", address: (match ? match[2] : s).trim().toLowerCase() };
  }).filter((x) => x.address);
}
export function validateAddresses(value, required = false) {
  const result = addresses(value);
  requireValue(!required || result.length, "RECIPIENT_REQUIRED", "请填写收件人。");
  for (const item of result) requireValue(!/[\r\n]/.test(item.name) && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(item.address), "INVALID_ADDRESS", `邮箱地址无效：${item.address}`);
  return result;
}
export function searchTokens(text) {
  const value = String(text || "").normalize("NFKC").toLowerCase();
  const tokens = value.match(/[\p{L}\p{N}]+/gu) || [];
  for (const run of value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) || []) {
    const chars = [...run];
    tokens.push(...chars);
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1]);
  }
  return [...new Set(tokens)].join(" ");
}
export function queryTokens(text) {
  const value = String(text || "").normalize("NFKC").toLowerCase();
  const chunks = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{N}]+/gu) || [];
  return chunks.flatMap((part) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(part) && [...part].length > 1
    ? [...part].slice(0, -1).map((c, i) => c + [...part][i + 1]) : [part]).map((s) => `"${s}"`).join(" AND ");
}
export function headerSafe(value) { requireValue(!/[\r\n]/.test(String(value || "")), "INVALID_HEADER", "邮件头不能包含换行。"); return String(value || ""); }

// Keep display normalization separate from the original MIME data.
export function displayName(value) {
  let name = String(value || "").trim();
  while (/^["“”'‘’].*["“”'‘’]$/s.test(name)) name = name.slice(1, -1).trim();
  return /^[\s"“”'‘’]*$/.test(name) ? "" : name;
}
export const personLabel = (person) => displayName(person?.name) || person?.address || "未知发件人";
export function addressPeople(value) {
  if (Array.isArray(value)) return value.flatMap(addressPeople);
  if (value?.address) return [{ name: displayName(value.name), address: String(value.address).trim().toLowerCase() }];
  const parts = []; let part = "", quoted = false, angle = 0, escaped = false;
  for (const c of String(value || "")) {
    if (c === '"' && !escaped) quoted = !quoted;
    if (!quoted && c === "<") angle++;
    if (!quoted && c === ">") angle = Math.max(0, angle - 1);
    if (!quoted && !angle && /[,;；\n]/.test(c)) { parts.push(part); part = ""; } else part += c;
    escaped = c === "\\" && !escaped;
  }
  parts.push(part);
  return parts.map((item) => { const match = item.trim().match(/^(.*?)<([^<>]+)>$/); return { name: match ? displayName(match[1]) : "", address: (match ? match[2] : item).trim().toLowerCase() }; }).filter((p) => p.address);
}
export function splitQuotedText(value) {
  const text = String(value || "");
  const match = /^(?:>.*|On .{1,400}wrote:\s*|在.{1,400}(?:写道|寫道)[：:]\s*|-{2,}\s*(?:Original Message|原始邮件|原始郵件)\s*-{2,}|—— [^\n]+ ——)\r?$/im.exec(text);
  return match ? { current: text.slice(0, match.index), quoted: text.slice(match.index) } : { current: text, quoted: "" };
}
export function draftTextParts(draft) {
  const text = String(draft.text || "");
  if (!draft.sourceMessageId) return { current: text, quoted: "" };
  if (draft.quotedText !== undefined) return draft.quotedText && text.endsWith(draft.quotedText) ? { current: text.slice(0, -draft.quotedText.length), quoted: draft.quotedText } : { current: text, quoted: "" };
  return splitQuotedText(text); // Older replies have no stored boundary.
}
export const escapeHtml = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const textHtml = (value) => `<p>${escapeHtml(value).replace(/\n/g, "</p><p>")}</p>`;
export const pendingDrafts = (drafts) => drafts.filter((d) => !["sent", "discarded"].includes(d.status));

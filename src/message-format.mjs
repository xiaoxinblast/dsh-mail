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
// Confident standalone markers only: never infer a boundary from an ordinary
// date, email address, signature rule, or mathematical greater-than sign.
export function isQuoteBoundary(value) {
  const line = String(value || "").replace(/\u00a0/g, " ").trim().replace(/[\t ]+/g, " ");
  return /^(?:[—–_-]{1,}|-{2,})\s*\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?\s+[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+\s*(?:[—–_-]{1,}|-{2,})$/i.test(line)
    || /^On .{1,400}wrote:\s*$/i.test(line)
    || /^在.{1,400}(?:写道|寫道)[：:]\s*$/.test(line)
    || /^-{2,}\s*(?:Original Message|原始邮件|原始郵件)\s*-{2,}$/i.test(line);
}
export function quotedTextSections(value) {
  const text = String(value || ""), sections = []; let offset = 0, start = 0, quoting = false;
  for (const line of text.split(/(?<=\n)/)) {
    const boundary = isQuoteBoundary(line) || (!quoting && /^>/.test(line));
    if (boundary) { if (offset > start) sections.push({ quoted: quoting, text: text.slice(start, offset) }); quoting = true; start = offset; }
    offset += line.length;
  }
  if (start < text.length) sections.push({ quoted: quoting, text: text.slice(start) });
  return sections;
}
export function splitQuotedText(value) {
  const text = String(value || ""), sections = quotedTextSections(text);
  const current = sections[0]?.quoted ? "" : sections[0]?.text || "";
  return { current, quoted: text.slice(current.length) };
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

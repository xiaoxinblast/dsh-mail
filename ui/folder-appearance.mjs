export const FOLDER_COLORS = [["蓝色", "#2563eb"], ["青色", "#0891b2"], ["绿色", "#15803d"], ["橙色", "#d97706"], ["紫色", "#7c3aed"], ["粉色", "#db2777"], ["红色", "#dc2626"], ["灰色", "#64748b"]];
const roles = { "\\Inbox": ["inbox", "#2563eb"], "\\Sent": ["sent", "#0891b2"], "\\Drafts": ["draft", "#7c3aed"], "\\Trash": ["trash", "#64748b"], "\\Junk": ["archive", "#d97706"], "\\Archive": ["archive", "#15803d"] };
export function folderAppearance(folder) { const [icon, color] = roles[folder.role] || ["folder", "#64748b"]; return { icon, color: /^#[0-9a-f]{6}$/i.test(folder.color || "") ? folder.color : color }; }
export function senderAppearance(message) {
  const name = message.from?.[0]?.name || message.from?.[0]?.address || "?";
  const hash = [...name].reduce((n, c) => (n * 31 + c.codePointAt(0)) >>> 0, 0);
  return { text: /\s/.test(name.trim()) ? name.trim().split(/\s+/).slice(0, 2).map((x) => [...x][0]).join("").toUpperCase() : [...name].slice(0, 2).join("").toUpperCase(), color: FOLDER_COLORS[hash % FOLDER_COLORS.length][1] };
}

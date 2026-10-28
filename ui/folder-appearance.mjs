import { isInboxFolder, visibleFolders } from "../src/folders.mjs";

export const FOLDER_COLORS = [["蓝色", "#2563eb"], ["青色", "#0891b2"], ["绿色", "#15803d"], ["橙色", "#d97706"], ["紫色", "#7c3aed"], ["粉色", "#db2777"], ["红色", "#dc2626"], ["灰色", "#64748b"], ["天蓝", "#0ea5e9"], ["靛蓝", "#4f46e5"], ["亮紫", "#a855f7"], ["深青", "#0f766e"], ["湖蓝", "#06b6d4"], ["翡翠绿", "#10b981"], ["草绿", "#65a30d"], ["鼠尾草绿", "#84a98c"], ["黄色", "#eab308"], ["琥珀", "#f59e0b"], ["珊瑚橙", "#f97316"], ["杏橙", "#fb923c"], ["玫红", "#f43f5e"], ["深玫红", "#be185d"], ["棕色", "#92400e"], ["深灰", "#334155"]];
const SENDER_COLORS = FOLDER_COLORS.slice(0, 8);
const roles = { "\\Inbox": ["inbox", "#2563eb"], "\\Sent": ["sent", "#0891b2"], "\\Drafts": ["draft", "#7c3aed"], "\\Trash": ["trash", "#64748b"], "\\Junk": ["archive", "#d97706"], "\\Archive": ["archive", "#15803d"] };
export function folderAppearance(folder) { const [icon, color] = roles[folder.role] || ["folder", "#64748b"]; return { icon, color: /^#[0-9a-f]{6}$/i.test(folder.color || "") ? folder.color : color }; }
export function messageFolderLocations(message, folders) {
  const byFolder = new Map();
  for (const location of message.locations || [{ id: message.id, folderId: message.folderId }]) if (!byFolder.has(location.folderId)) byFolder.set(location.folderId, location);
  return visibleFolders(folders.filter((folder) => byFolder.has(folder.id) && !isInboxFolder(folder))).map((folder) => ({ ...byFolder.get(folder.id), folder }));
}
export function senderAppearance(message) {
  const name = message.from?.[0]?.name || message.from?.[0]?.address || "?";
  const hash = [...name].reduce((n, c) => (n * 31 + c.codePointAt(0)) >>> 0, 0);
  return { text: /\s/.test(name.trim()) ? name.trim().split(/\s+/).slice(0, 2).map((x) => [...x][0]).join("").toUpperCase() : [...name].slice(0, 2).join("").toUpperCase(), color: SENDER_COLORS[hash % SENDER_COLORS.length][1] };
}

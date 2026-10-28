export const FOLDER_SORTS = [["name-asc", "名称升序"], ["name-desc", "名称降序"], ["count-desc", "邮件数量从多到少"]];
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const nameGroup = (folder) => /^[a-z0-9]/i.test(folder.name || folder.path || "") ? 0 : 1;
const byName = (a, b) => nameGroup(a) - nameGroup(b) || collator.compare(a.name || a.path || "", b.name || b.path || "") || collator.compare(a.path || "", b.path || "") || String(a.id).localeCompare(String(b.id));

export function visibleFolders(folders, sort = "name-asc", query = "") {
  const term = query.trim().toLocaleLowerCase("zh-CN");
  return folders.filter((f) => !f.missing && !f.deleted && (!term || `${f.name || ""}\n${f.path || ""}`.toLocaleLowerCase("zh-CN").includes(term))).sort((a, b) => sort === "count-desc" ? (b.count ?? 0) - (a.count ?? 0) || byName(a, b) : (sort === "name-desc" ? -1 : 1) * byName(a, b));
}

export function sentFolders(accounts, folders) {
  return accounts.filter((a) => !a.deleted).flatMap((account) => folders.filter((f) => f.accountId === account.id && !f.missing && !f.deleted && f.selectable !== false && (account.folders?.sent ? f.id === account.folders.sent : f.role === "\\Sent")));
}

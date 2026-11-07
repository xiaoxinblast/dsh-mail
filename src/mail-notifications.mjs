// Reading a mail acknowledges its reminder independently of the automatic read-flag preference.
export function acknowledgeMail(service, message) {
  service.openedNotificationMails ||= new Set(); service.openedNotificationMails.add(message.id);
  if (service.openedNotificationMails.size > 2000) service.openedNotificationMails.delete(service.openedNotificationMails.values().next().value);
  let changed = 0, retainedLegacy = false;
  for (const notice of service.store.list("notifications").filter((n) => n.kind === "new-mail" && !n.dismissed)) {
    const tracked = Array.isArray(notice.data?.messageIds), ids = notice.data?.messageIds;
    if (tracked ? !ids.includes(message.id) : notice.data?.accountId !== message.accountId) continue;
    const remaining = tracked ? service.store.db.prepare("SELECT id FROM messages WHERE seen=0 AND id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)).map((m) => m.id).filter((id) => !service.openedNotificationMails.has(id)) : retainedLegacy ? [] : service.store.db.prepare("SELECT id FROM messages WHERE account_id=? AND seen=0 AND date<=? AND folder_id IN (SELECT id FROM entities WHERE kind='folders' AND json_extract(data,'$.role')=?)").all(message.accountId, notice.createdAt, "\\Inbox").map((m) => m.id).filter((id) => !service.openedNotificationMails.has(id));
    if (!tracked) retainedLegacy = true;
    service.store.put("notifications", { ...notice, dismissed: !remaining.length, title: `未读邮件 · ${remaining.length} 封`, data: { ...notice.data, messageIds: remaining } });
    service.removeNativeNotification(notice.id); changed++;
  }
  return changed;
}

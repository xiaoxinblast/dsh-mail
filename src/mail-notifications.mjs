const unreadInbox = `m.seen=0 AND m.account_id=? AND m.folder_id IN (SELECT id FROM entities WHERE kind='folders'
  AND (json_extract(data,'$.role')='\\Inbox' OR upper(json_extract(data,'$.path'))='INBOX')
  AND coalesce(json_extract(data,'$.missing'),0)=0 AND coalesce(json_extract(data,'$.deleted'),0)=0)`;

export function unreadReminderIds(service, data, createdAt) {
  const rows = Array.isArray(data.messageIds)
    ? service.store.db.prepare(`SELECT m.id FROM json_each(?) ids CROSS JOIN messages m ON m.id=ids.value WHERE ${unreadInbox} ORDER BY ids.key`).all(JSON.stringify(data.messageIds), data.accountId)
    : service.store.db.prepare(`SELECT m.id FROM messages m WHERE ${unreadInbox} AND m.date<=?`).all(data.accountId, createdAt);
  return rows.map((row) => row.id).filter((id) => !service.openedNotificationMails?.has(id));
}

// Reading a mail acknowledges its reminder independently of the automatic read-flag preference.
export function acknowledgeMail(service, message) {
  service.openedNotificationMails ||= new Set(); service.openedNotificationMails.add(message.id);
  if (service.openedNotificationMails.size > 2000) service.openedNotificationMails.delete(service.openedNotificationMails.values().next().value);
  return updateMailReminders(service, message);
}

function updateMailReminders(service, message) {
  let changed = 0, retainedLegacy = false;
  const active = service.store.db.prepare("SELECT data FROM entities WHERE kind='notifications' AND json_extract(data,'$.kind')='new-mail' AND NOT coalesce(json_extract(data,'$.dismissed'),0) AND NOT coalesce(json_extract(data,'$.deleted'),0) ORDER BY updated DESC").all();
  for (const row of active) {
    const notice = JSON.parse(row.data), ids = notice.data?.messageIds, tracked = Array.isArray(ids);
    if (!notice.data?.accountId || (message && (tracked ? !ids.includes(message.id) : notice.data.accountId !== message.accountId))) continue;
    const remaining = !tracked && retainedLegacy ? [] : unreadReminderIds(service, notice.data, notice.createdAt);
    if (!message && remaining.length && (!tracked || remaining.length === ids.length)) continue;
    if (message && !tracked) retainedLegacy = true;
    service.store.put("notifications", { ...notice, dismissed: !remaining.length, title: `未读邮件 · ${remaining.length} 封`, data: { ...notice.data, messageIds: remaining } });
    service.removeNativeNotification(notice.id); changed++;
  }
  return changed;
}

export function reconcileMailReminders(service, versions = service.store.resourceVersions()) {
  const key = () => `${versions.messages || 0}:${versions.folders || 0}:${versions.notifications || 0}`;
  if (service.mailReminderVersion === key()) return;
  if (updateMailReminders(service)) versions.notifications = service.store.resourceVersions().notifications;
  service.mailReminderVersion = key();
}

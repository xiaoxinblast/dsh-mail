export const DEFAULT_SETTINGS = { calendarTimeZone: "Asia/Hong_Kong", eventTimeZone: "Asia/Hong_Kong", calendarView: "dayGridMonth", firstDay: 1, defaultAccountId: "", syncIntervalMinutes: 2, markReadOnOpen: true, folderSort: "name-asc" };
export const CALENDAR_VIEWS = [["dayGridMonth", "月"], ["timeGridWeek", "周"], ["timeGridDay", "日"], ["listWeek", "日程"]];

export function preferredAccount(accounts, settings) {
  const available = accounts.filter((a) => a.enabled && !a.local && !a.deleted);
  return available.find((a) => a.id === settings.defaultAccountId) || available[0];
}

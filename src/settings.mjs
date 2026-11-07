const requireValue = (valid, code, message) => { if (!valid) throw Object.assign(new Error(message), { code }); };

export const DEFAULT_SETTINGS = { calendarTimeZone: "Asia/Hong_Kong", eventTimeZone: "Asia/Hong_Kong", calendarView: "dayGridMonth", firstDay: 1, defaultAccountId: "", syncIntervalMinutes: 2, markReadOnOpen: true, folderSort: "name-asc", loadRemoteImages: false, mailFolderWidth: 240, mailListWidth: 340, desktopNotifications: true,
  theme: "host", accent: "blue", density: "standard", interfaceSize: "standard", motion: "auto", showAvatars: true, snippetLines: 1, pageSize: 50, groupThreads: false, readingSize: 14, markReadDelay: 0,
  composeFormat: "rich", expandRecipients: false, notifyMail: true, notifyCalendar: true, notifyTasks: true, notificationSound: true, quietHours: false, quietStart: "22:00", quietEnd: "08:00",
  eventReminder: 15, taskPriority: "normal", aiLanguage: "简体中文", aiStyle: "professional", rememberAssistant: false };
export const CALENDAR_VIEWS = [["dayGridMonth", "月"], ["timeGridWeek", "周"], ["timeGridDay", "日"], ["listWeek", "日程"]];
export const ACCENTS = { blue: "#2563eb", violet: "#7c3aed", teal: "#0d9488", green: "#15803d", rose: "#be185d", orange: "#c2410c" };
export const SETTING_FIELDS = {
  theme: ["主题", [["host", "跟随宿主"], ["light", "浅色"], ["dark", "深色"]]], accent: ["强调色", [["blue", "海蓝"], ["violet", "紫罗兰"], ["teal", "青绿"], ["green", "森林"], ["rose", "玫瑰"], ["orange", "暖橙"]]],
  density: ["界面密度", [["compact", "紧凑"], ["standard", "标准"], ["comfortable", "宽松"]]], interfaceSize: ["界面字号", [["small", "小"], ["standard", "标准"], ["large", "大"]]], motion: ["动态效果", [["auto", "自动 · 遵循系统设置"], ["off", "关闭"]]],
  showAvatars: ["显示发件人头像", "boolean"], snippetLines: ["邮件摘要", [[0, "不显示"], [1, "1 行"], [2, "2 行"]]], pageSize: ["每页邮件数", [[25, "25 封"], [50, "50 封"], [100, "100 封"]]], groupThreads: ["默认合并当前页邮件往来", "boolean"], readingSize: ["阅读字号", [[14, "14 px"], [16, "16 px"], [18, "18 px"], [20, "20 px"]]], markReadOnOpen: ["打开邮件时自动标为已读", "boolean"], markReadDelay: ["自动已读延迟", [[0, "立即"], [1, "1 秒"], [3, "3 秒"], [5, "5 秒"]]], loadRemoteImages: ["默认加载外部图片（HTTPS）", "boolean"],
  composeFormat: ["新草稿默认格式", [["rich", "富文本"], ["plain", "纯文本"]]], expandRecipients: ["默认展开抄送和密送", "boolean"],
  desktopNotifications: ["启用 Windows 系统通知", "boolean"], notifyMail: ["新邮件通知", "boolean"], notifyCalendar: ["日历提醒", "boolean"], notifyTasks: ["待办与跟进提醒", "boolean"], notificationSound: ["播放系统通知声音", "boolean"], quietHours: ["启用免打扰时段", "boolean"], quietStart: ["免打扰开始", "time"], quietEnd: ["免打扰结束", "time"],
  eventReminder: ["新事件默认提醒", [[0, "开始时"], [5, "提前 5 分钟"], [15, "提前 15 分钟"], [30, "提前 30 分钟"], [60, "提前 1 小时"]]], taskPriority: ["新待办默认优先级", [["normal", "普通"], ["high", "高"], ["low", "低"]]],
  aiLanguage: ["默认翻译语言", "language"], aiStyle: ["默认回复风格", [["professional", "自然专业"], ["concise", "简洁直接"], ["friendly", "友好亲切"], ["formal", "正式礼貌"]]], rememberAssistant: ["记住邮箱助手展开状态", "boolean"]
};
export function validateExperienceSettings(settings) {
  for (const [key, [label, type]] of Object.entries(SETTING_FIELDS)) {
    const value = settings[key];
    const valid = Array.isArray(type) ? type.some(([option]) => option === value) : type === "boolean" ? typeof value === "boolean" : type === "time" ? typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) : typeof value === "string" && value.trim().length > 0 && value.length <= 80;
    requireValue(valid, "INVALID_SETTINGS", `${label}设置无效。`);
  }
  requireValue(!settings.quietHours || settings.quietStart !== settings.quietEnd, "INVALID_SETTINGS", "免打扰开始与结束时间不能相同。");
}
export function notificationAllowed(settings, kind, at) {
  if (!settings.desktopNotifications || (kind === "new-mail" ? !settings.notifyMail : kind === "event" ? !settings.notifyCalendar : !settings.notifyTasks)) return false;
  if (!settings.quietHours) return true;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: settings.calendarTimeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
  return !(settings.quietStart < settings.quietEnd ? time >= settings.quietStart && time < settings.quietEnd : time >= settings.quietStart || time < settings.quietEnd);
}

export function preferredAccount(accounts, settings) {
  const available = accounts.filter((a) => a.enabled && !a.local && !a.deleted);
  return available.find((a) => a.id === settings.defaultAccountId) || available[0];
}

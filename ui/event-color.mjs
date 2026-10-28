import { DateTime } from "luxon";

export const EVENT_COLORS = [["亮青", "#22dbf4"], ["橙色", "#ffb878"], ["薄荷绿", "#7ae8c0"], ["黄色", "#fbd34d"], ["蓝色", "#78aaff"], ["紫色", "#b18aff"], ["粉色", "#f48ab4"], ["灰色", "#98a9bb"]];
const LEGACY_COLORS = { "#ffead7": "#ffb878", "#d7f8ec": "#7ae8c0", "#bdf4fc": "#22dbf4", "#fef3ce": "#fbd34d", "#dceaff": "#78aaff", "#ede4ff": "#b18aff", "#fbe2eb": "#f48ab4", "#e9edf1": "#98a9bb" };

export function eventColor(event, calendars) {
  const candidate = event.color || calendars.find((calendar) => calendar.id === event.calendarId)?.color;
  return /^#[0-9a-f]{6}$/i.test(candidate || "") ? candidate : "#155e75";
}

export function eventHasEnded(event, { now = Date.now(), timeZone = "Asia/Hong_Kong" } = {}) {
  if (!event.end) return false;
  const end = DateTime.fromISO(event.end, { zone: event.allDay ? timeZone : event.timeZone || timeZone });
  return end.isValid && end.toMillis() <= now;
}

export function eventAppearance(event, calendars, options) {
  const saved = eventColor(event, calendars), color = LEGACY_COLORS[saved.toLowerCase()] || saved, ended = eventHasEnded(event, options);
  const channels = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const mix = (target, amount) => `#${channels.map((c) => Math.round(c * (1 - amount) + target * amount).toString(16).padStart(2, "0")).join("")}`;
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return { backgroundColor: ended ? mix(255, 0.7) : color, borderColor: ended ? mix(255, 0.5) : color, textColor: ended ? mix(0, 0.65) : luminance > 0.179 ? "#000000" : "#ffffff" };
}

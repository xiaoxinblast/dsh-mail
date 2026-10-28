export const EVENT_COLORS = [["浅橙", "#ffead7"], ["薄荷绿", "#d7f8ec"], ["浅青", "#bdf4fc"], ["奶油黄", "#fef3ce"], ["浅蓝", "#dceaff"], ["浅紫", "#ede4ff"], ["浅粉", "#fbe2eb"], ["浅灰", "#e9edf1"], ["亮青", "#22dbf4"], ["杏橙", "#ffb878"]];

export function eventColor(event, calendars) {
  const candidate = event.color || calendars.find((calendar) => calendar.id === event.calendarId)?.color;
  return /^#[0-9a-f]{6}$/i.test(candidate || "") ? candidate : "#155e75";
}

export function eventAppearance(event, calendars) {
  const color = eventColor(event, calendars);
  const channels = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const mix = (target, amount) => `#${channels.map((c) => Math.round(c * (1 - amount) + target * amount).toString(16).padStart(2, "0")).join("")}`;
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return { backgroundColor: luminance < 0.35 ? mix(255, 0.82) : color, borderColor: luminance > 0.8 ? mix(0, 0.2) : color, textColor: mix(0, luminance < 0.35 ? 0.25 : 0.65) };
}

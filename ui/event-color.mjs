export const EVENT_COLORS = [["蓝色", "#2563eb"], ["青色", "#155e75"], ["绿色", "#15803d"], ["紫色", "#7c3aed"], ["粉色", "#be185d"], ["红色", "#dc2626"], ["橙色", "#c2410c"], ["灰色", "#475569"]];

export function eventAppearance(event, calendars) {
  const candidate = event.color || calendars.find((calendar) => calendar.id === event.calendarId)?.color;
  const color = /^#[0-9a-f]{6}$/i.test(candidate || "") ? candidate : "#155e75";
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return { backgroundColor: color, borderColor: color, textColor: luminance > 0.179 ? "#000000" : "#ffffff" };
}

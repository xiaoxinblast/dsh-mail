import { DateTime } from "luxon";
export function scheduledInstant(local, zone) {
  const value = DateTime.fromFormat(local, "yyyy-MM-dd'T'HH:mm", { zone });
  if (!value.isValid || value.toFormat("yyyy-MM-dd'T'HH:mm") !== local) throw new Error("发送时间或时区无效；夏令时跳过的时间不可用。");
  if (value.getPossibleOffsets().length > 1) throw new Error("此时间处于夏令时重复时段，请选择无歧义的时间。");
  return value.toUTC().toISO();
}
export function sendTimeLabel(instant, zone = "Asia/Shanghai") {
  return DateTime.fromISO(instant, { zone }).toFormat("yyyy-MM-dd HH:mm ZZZZ") + ` · ${zone}`;
}

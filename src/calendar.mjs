import ICAL from "ical.js";
import { DateTime } from "luxon";
import timezones from "@touch4it/ical-timezones";
import { id, now, requireValue, validateAddresses } from "./util.mjs";

export function zoneFor(name = "Asia/Hong_Kong") {
  if (name === "UTC") return ICAL.Timezone.utcTimezone;
  if (!ICAL.TimezoneService.has(name)) {
    requireValue(DateTime.now().setZone(name).isValid, "INVALID_TIMEZONE", "时区无效。");
    const raw = timezones.getVtimezoneComponent(name);
    requireValue(raw, "TIMEZONE_MISSING", `缺少时区定义：${name}`);
    const parsed = new ICAL.Component(ICAL.parse(raw));
    const component = parsed.name === "vtimezone" ? parsed : parsed.getFirstSubcomponent("vtimezone");
    ICAL.TimezoneService.register(name, new ICAL.Timezone({ component, tzid: name }));
  }
  return ICAL.TimezoneService.get(name);
}
function calendarTime(value, zone, allDay) {
  const d = DateTime.fromISO(value, { zone });
  requireValue(d.isValid, "INVALID_DATE", "请填写有效日期和时间。");
  const t = ICAL.Time.fromString(allDay ? d.toISODate() : d.toFormat("yyyy-MM-dd'T'HH:mm:ss"));
  t.zone = allDay ? ICAL.Timezone.localTimezone : zoneFor(zone); return t;
}
function setDate(component, name, value, zone, allDay) {
  const property = new ICAL.Property(name);
  property.setValue(calendarTime(value, zone, allDay));
  if (!allDay && zone !== "UTC") property.setParameter("tzid", zone);
  component.addProperty(property);
}
export function eventToComponent(event) {
  const c = new ICAL.Component("vevent"), zone = event.timeZone || "Asia/Hong_Kong";
  c.addPropertyWithValue("uid", event.uid || event.id);
  c.addPropertyWithValue("summary", event.title);
  c.addPropertyWithValue("description", event.description || "");
  c.addPropertyWithValue("location", event.location || "");
  c.addPropertyWithValue("sequence", Number(event.sequence || 0));
  c.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  setDate(c, "dtstart", event.start, zone, event.allDay);
  setDate(c, "dtend", event.end, zone, event.allDay);
  if (event.rrule) c.addPropertyWithValue("rrule", ICAL.Recur.fromString(event.rrule.replace(/^RRULE:/i, "")));
  if (event.recurrenceId) setDate(c, "recurrence-id", event.recurrenceId, zone, event.allDay);
  for (const date of event.exdates || []) setDate(c, "exdate", date, zone, event.allDay);
  for (const date of event.rdates || []) setDate(c, "rdate", date, zone, event.allDay);
  if (event.organizer) c.addPropertyWithValue("organizer", `mailto:${validateAddresses(event.organizer, true)[0].address}`);
  for (const person of event.attendees || []) { const p = new ICAL.Property("attendee"); p.setValue(`mailto:${validateAddresses(person.address || person, true)[0].address}`); p.setParameter("partstat", person.partstat || "NEEDS-ACTION"); p.setParameter("rsvp", "TRUE"); c.addProperty(p); }
  if (event.status) c.addPropertyWithValue("status", event.status);
  return c;
}
export function exportEvents(events, method = "PUBLISH") {
  const c = new ICAL.Component("vcalendar");
  c.addPropertyWithValue("prodid", "-//DSH Mail//Calendar//ZH-CN"); c.addPropertyWithValue("version", "2.0"); c.addPropertyWithValue("method", method);
  for (const zone of new Set(events.filter((e) => !e.allDay).map((e) => e.timeZone || "Asia/Hong_Kong"))) if (zone !== "UTC") c.addSubcomponent(zoneFor(zone).component);
  for (const event of events) c.addSubcomponent(eventToComponent(event));
  return c.toString();
}
export function normalizeEvent(input) {
  requireValue(String(input.title || "").trim(), "TITLE_REQUIRED", "请填写事件名称。");
  const timeZone = input.timeZone || "Asia/Hong_Kong"; zoneFor(timeZone);
  const start = DateTime.fromISO(input.start || "", { zone: timeZone }), end = DateTime.fromISO(input.end || "", { zone: timeZone });
  requireValue(start.isValid && end.isValid && end > start, "INVALID_EVENT_RANGE", "结束时间必须晚于开始时间；全天事件的结束日期不包含当天。");
  if (input.rrule) ICAL.Recur.fromString(input.rrule.replace(/^RRULE:/i, ""));
  return { ...input, id: input.id || id(), uid: input.uid || id(), calendarId: input.calendarId || "default", title: input.title.trim(), timeZone, allDay: !!input.allDay, start: input.allDay ? start.toISODate() : start.toISO(), end: input.allDay ? end.toISODate() : end.toISO(), reminderMinutes: Math.max(0, Number(input.reminderMinutes ?? 15)), sequence: Number(input.sequence || 0) };
}
export function importEvents(raw, calendarId = "default") {
  const root = new ICAL.Component(ICAL.parse(raw));
  requireValue(root.name === "vcalendar", "INVALID_ICS", "文件不是有效的 iCalendar。");
  for (const zone of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(zone.getFirstPropertyValue("tzid"), new ICAL.Timezone({ component: zone }));
  const method = root.getFirstPropertyValue("method") || "PUBLISH";
  return root.getAllSubcomponents("vevent").map((c) => {
    for (const name of ["dtstart", "dtend", "recurrence-id"]) { const z = c.getFirstProperty(name)?.getParameter("tzid"); if (z && !ICAL.TimezoneService.has(z)) zoneFor(z); }
    const event = new ICAL.Event(c), start = event.startDate, end = start ? event.endDate : null;
    const timeZone = c.getFirstProperty("dtstart")?.getParameter("tzid") || (start?.zone?.tzid === "UTC" ? "UTC" : "Asia/Hong_Kong");
    const str = (t) => t?.isDate ? t.toString() : t ? DateTime.fromJSDate(t.toJSDate()).setZone(timeZone).toISO() : null;
    return { id: id(), uid: event.uid, calendarId, title: event.summary || "（无标题会议）", description: event.description || "", location: event.location || "", start: str(start), end: str(end), allDay: start?.isDate || false, timeZone, rrule: c.getFirstPropertyValue("rrule")?.toString() || "", exdates: c.getAllProperties("exdate").flatMap((p) => p.getValues().map(str)), rdates: c.getAllProperties("rdate").flatMap((p) => p.getValues().map(str)), recurrenceId: str(event.recurrenceId), sequence: c.getFirstPropertyValue("sequence") || 0, organizer: String(c.getFirstPropertyValue("organizer") || "").replace(/^mailto:/i, ""), attendees: c.getAllProperties("attendee").map((p) => ({ address: String(p.getFirstValue()).replace(/^mailto:/i, ""), partstat: p.getParameter("partstat") || "NEEDS-ACTION" })), status: method === "CANCEL" ? "CANCELLED" : c.getFirstPropertyValue("status") || "CONFIRMED", stamp: c.getFirstPropertyValue("dtstamp")?.toString(), method, originalIcs: raw, reminderMinutes: 15 };
  });
}
export function occurrences(events, start, end) {
  const from = new Date(start), until = new Date(end), result = [];
  const key = (e, value) => `${e.uid}/${e.allDay ? value.slice(0, 10) : DateTime.fromISO(value, { zone: e.timeZone || "Asia/Hong_Kong" }).toMillis()}`;
  const exceptions = new Map(events.filter((e) => e.recurrenceId).map((e) => [key(e, e.recurrenceId), e]));
  requireValue(Number.isFinite(+from) && Number.isFinite(+until) && until > from && +until - +from <= 370 * 86400000, "INVALID_RANGE", "日历查询范围必须在一年以内。");
  for (const data of events.filter((e) => !e.recurrenceId && e.status !== "CANCELLED")) {
    const event = new ICAL.Event(eventToComponent(data)), iterator = event.iterator();
    for (let n = 0; n < 100000; n++) {
      const next = iterator.next(); if (!next || next.toJSDate() >= until) break;
      const details = event.getOccurrenceDetails(next), s = details.startDate.toJSDate(), e = details.endDate.toJSDate();
      const exception = exceptions.get(key(data, data.allDay ? next.toString() : s.toISOString()));
      if (exception) continue;
      if (e <= from) continue;
      result.push({ ...data, eventId: data.id, id: `${data.id}:${next.toString()}`, occurrenceStart: next.toString(), start: data.allDay ? details.startDate.toString() : s.toISOString(), end: data.allDay ? details.endDate.toString() : e.toISOString() });
      if (result.length > 10000) throw new Error("日历结果过多，请缩小日期范围。");
      if (!data.rrule && !data.rdates?.length) break;
    }
  }
  for (const exception of exceptions.values()) if (exception.status !== "CANCELLED" && new Date(exception.end) > from && new Date(exception.start) < until) result.push({ ...exception, eventId: exception.id });
  return result.sort((a, b) => a.start.localeCompare(b.start));
}
export function applyInvitation(store, imported, { sourceMessageId } = {}) {
  requireValue(imported.uid, "INVITATION_UID_REQUIRED", "会议邀请缺少 UID。");
  const old = store.list("events").find((e) => e.uid === imported.uid && (e.recurrenceId || "") === (imported.recurrenceId || ""));
  if (old && old.organizer && old.organizer.toLowerCase() !== imported.organizer?.toLowerCase()) return { status: "organizer-conflict", event: old };
  if (old && (imported.sequence < old.sequence || (imported.sequence === old.sequence && !(imported.status === "CANCELLED" && old.status !== "CANCELLED") && (!imported.stamp || imported.stamp <= (old.stamp || ""))))) return { status: "unchanged", event: old };
  if (imported.method === "REPLY") return { status: "reply-requires-review", event: old || imported };
  const data = imported.status === "CANCELLED" && old ? { ...old, sequence: imported.sequence, status: "CANCELLED", stamp: imported.stamp } : normalizeEvent({ ...old, ...imported });
  const event = store.put("events", { ...data, id: old?.id || imported.id, sourceMessageId: sourceMessageId || old?.sourceMessageId, importedAt: now() });
  return { status: imported.status === "CANCELLED" ? "cancelled" : old ? "updated" : "created", event };
}

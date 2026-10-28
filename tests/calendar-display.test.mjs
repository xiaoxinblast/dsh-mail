import test from "node:test";
import assert from "node:assert/strict";
import { eventAppearance, eventHasEnded, eventColor } from "../ui/event-color.mjs";

test("calendar fades only ended occurrences, including midnight-exclusive all-day ranges", () => {
  const now = Date.parse("2026-10-29T04:00:00Z"), options = { now, timeZone: "Asia/Hong_Kong" };
  const active = { color: "#22dbf4", start: "2026-10-28", end: "2026-11-01", allDay: true };
  assert.equal(eventHasEnded(active, options), false);
  assert.equal(eventAppearance(active, [], options).backgroundColor, "#22dbf4");
  const ended = { ...active, end: "2026-10-29" };
  assert.equal(eventHasEnded(ended, options), true);
  assert.equal(eventAppearance(ended, [], options).backgroundColor, "#bdf4fc");
  assert.equal(eventHasEnded({ end: "2026-10-29T04:00:00Z" }, options), true);
  assert.equal(eventHasEnded({ end: "2026-10-29T04:00:01Z" }, options), false);
  assert.equal(eventHasEnded({ ...ended, end: "2026-10-29" }, { now: Date.parse("2026-10-29T01:00:00Z"), timeZone: "America/New_York" }), false);
  assert.equal(eventHasEnded({ end: "invalid" }, options), false);
});

test("legacy pastel choices display their normal hue without rewriting saved event colors", () => {
  const event = { color: "#bdf4fc", end: "2099-01-01T00:00:00Z" };
  assert.equal(eventColor(event, []), "#bdf4fc");
  assert.equal(eventAppearance(event, []).backgroundColor, "#22dbf4");
  assert.equal(event.color, "#bdf4fc");
  assert.equal(eventAppearance({ color: "#123456" }, []).backgroundColor, "#123456");
});

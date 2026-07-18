"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeEventRow } = require("../normalize/events");
const { crossCheckEvents } = require("../normalize/crossCheck");
const {
  STOP_TYPE,
  minutesBetween,
  buildStops,
  compareWindow,
} = require("../normalize/standing");

const REAL_GPS = "49.066596 8.372236";

function ev(overrides, orderIndex) {
  return normalizeEventRow(
    {
      transport_number: "T1",
      delivery_number: "D1",
      timezone: "Etc/UTC",
      source: "VisibilityHubUser VisibilityHubUser",
      coordinates: REAL_GPS,
      ...overrides,
    },
    { orderIndex },
  );
}

test("minutesBetween liefert vorzeichenbehaftete Minuten", () => {
  assert.equal(
    minutesBetween("2026-07-16T09:00:00.000Z", "2026-07-16T12:00:00.000Z"),
    180,
  );
  assert.equal(minutesBetween("2026-07-16T12:00:00.000Z", null), null);
});

test("buildStops: Ladestopp mit Ankunft+Abfahrt -> Standdauer", () => {
  const events = [
    ev(
      {
        status_qualifier: "status.loading.arrival",
        event_time: "2026-07-16 09:00",
      },
      0,
    ),
    ev(
      {
        status_qualifier: "status.loading.departure",
        event_time: "2026-07-16 12:00",
      },
      1,
    ),
  ];
  const { phases } = crossCheckEvents(events);
  const stops = buildStops(phases);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].stop_type, STOP_TYPE.LOADING);
  assert.equal(stops[0].standing_minutes, 180);
  assert.equal(stops[0].incomplete, false);
  assert.equal(stops[0].needs_review, false);
  assert.equal(stops[0].arrival_source, "VISIBILITY");
});

test("buildStops: unvollstaendiger Stopp (nur Ankunft) -> Prueffall", () => {
  const events = [
    ev(
      {
        status_qualifier: "status.unloading.arrival",
        event_time: "2026-07-16 09:00",
      },
      0,
    ),
  ];
  const { phases } = crossCheckEvents(events);
  const stops = buildStops(phases);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].stop_type, STOP_TYPE.UNLOADING);
  assert.equal(stops[0].standing_minutes, null);
  assert.equal(stops[0].incomplete, true);
  assert.equal(stops[0].needs_review, true);
});

test("buildStops: negative Dauer (Abfahrt vor Ankunft) -> markiert", () => {
  const events = [
    ev(
      {
        status_qualifier: "status.loading.arrival",
        event_time: "2026-07-16 12:00",
      },
      0,
    ),
    ev(
      {
        status_qualifier: "status.loading.departure",
        event_time: "2026-07-16 09:00",
      },
      1,
    ),
  ];
  const { phases } = crossCheckEvents(events);
  const stops = buildStops(phases);
  assert.equal(stops[0].negative_duration, true);
  assert.equal(stops[0].standing_minutes, null);
  assert.equal(stops[0].needs_review, true);
});

test("buildStops: Lade- und Entladestopp je Lieferung, Reihenfolge stabil", () => {
  const events = [
    ev(
      {
        status_qualifier: "status.loading.arrival",
        event_time: "2026-07-16 09:00",
      },
      0,
    ),
    ev(
      {
        status_qualifier: "status.loading.departure",
        event_time: "2026-07-16 12:00",
      },
      1,
    ),
    ev(
      {
        status_qualifier: "status.unloading.arrival",
        event_time: "2026-07-17 06:00",
      },
      2,
    ),
    ev(
      {
        status_qualifier: "status.unloading.departure",
        event_time: "2026-07-17 08:00",
      },
      3,
    ),
  ];
  const { phases } = crossCheckEvents(events);
  const stops = buildStops(phases);
  assert.equal(stops.length, 2);
  assert.equal(stops[0].stop_type, STOP_TYPE.LOADING);
  assert.equal(stops[1].stop_type, STOP_TYPE.UNLOADING);
  assert.equal(stops[1].standing_minutes, 120);
});

test("compareWindow: Abfahrt nach Fensterende -> minutes_after_window_end", () => {
  const events = [
    ev(
      {
        status_qualifier: "status.unloading.arrival",
        event_time: "2026-07-17 06:00",
      },
      0,
    ),
    ev(
      {
        status_qualifier: "status.unloading.departure",
        event_time: "2026-07-17 09:30",
      },
      1,
    ),
  ];
  const { phases } = crossCheckEvents(events);
  const [stop] = buildStops(phases);
  const result = compareWindow(stop, {
    from: "2026-07-17T06:00:00.000Z",
    to: "2026-07-17T08:00:00.000Z",
  });
  assert.equal(result.arrival_vs_window_from_minutes, 0);
  assert.equal(result.departure_vs_window_to_minutes, 90);
  assert.equal(result.minutes_after_window_end, 90);
  assert.equal(result.within_window, false);
  assert.equal(result.standing_minutes, 210);
});

test("compareWindow: innerhalb des Fensters -> within_window true, kein Ueberhang", () => {
  const events = [
    ev(
      {
        status_qualifier: "status.loading.arrival",
        event_time: "2026-07-16 09:15",
      },
      0,
    ),
    ev(
      {
        status_qualifier: "status.loading.departure",
        event_time: "2026-07-16 09:45",
      },
      1,
    ),
  ];
  const { phases } = crossCheckEvents(events);
  const [stop] = buildStops(phases);
  const result = compareWindow(stop, {
    from: "2026-07-16T09:00:00.000Z",
    to: "2026-07-16T10:00:00.000Z",
  });
  assert.equal(result.within_window, true);
  assert.equal(result.minutes_after_window_end, 0);
});

test("compareWindow: ohne Fenster -> Deltas null, kein within_window", () => {
  const events = [
    ev(
      {
        status_qualifier: "status.loading.arrival",
        event_time: "2026-07-16 09:00",
      },
      0,
    ),
    ev(
      {
        status_qualifier: "status.loading.departure",
        event_time: "2026-07-16 12:00",
      },
      1,
    ),
  ];
  const { phases } = crossCheckEvents(events);
  const [stop] = buildStops(phases);
  const result = compareWindow(stop, {});
  assert.equal(result.arrival_vs_window_from_minutes, null);
  assert.equal(result.minutes_after_window_end, null);
  assert.equal(result.within_window, false);
  // Standdauer bleibt als Faktum erhalten.
  assert.equal(result.standing_minutes, 180);
});

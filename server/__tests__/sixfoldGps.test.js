"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  classifySixfoldStop,
  normalizeEventName,
} = require("../normalize/sixfoldGps");

const REAL_POSITION = { lat: 49.99106, lng: 10.55039 };

function stop(overrides) {
  return {
    type: "loading",
    status: "departed",
    arrival_time: "2026-07-20T10:39:00.000Z",
    departure_time: "2026-07-20T11:20:00.000Z",
    location: { name: "X", position: REAL_POSITION },
    status_events: [],
    ...overrides,
  };
}

test("normalizeEventName trimmt und normalisiert Grossschreibung", () => {
  assert.equal(normalizeEventName(" approach "), "APPROACH");
  assert.equal(normalizeEventName(null), "");
});

test("APPROACH + DEPART mit gueltigem Geofence -> voll GPS-verifiziert", () => {
  const result = classifySixfoldStop(
    stop({
      status_events: [
        { event_name: "APPROACH", event_time: "2026-07-20T10:39:00.000Z" },
        { event_name: "DEPART", event_time: "2026-07-20T11:20:00.000Z" },
      ],
    }),
  );
  assert.equal(result.gps_connected, true);
  assert.equal(result.arrival_verified, true);
  assert.equal(result.departure_verified, true);
  assert.equal(result.needs_review, false);
  assert.deepEqual(result.flags, []);
});

test("DEPART_UNKNOWN -> Abfahrt geschaetzt, Prueffall", () => {
  const result = classifySixfoldStop(
    stop({
      status_events: [
        { event_name: "APPROACH", event_time: "2026-07-20T10:39:00.000Z" },
        {
          event_name: "DEPART_UNKNOWN",
          event_time: "2026-07-20T11:20:00.000Z",
        },
      ],
    }),
  );
  assert.equal(result.arrival_verified, true);
  assert.equal(result.departure_verified, false);
  assert.equal(result.departure_estimated, true);
  assert.equal(result.needs_review, true);
  assert.ok(result.flags.includes("departure_estimated"));
});

test("0/0-Koordinaten -> nicht verifiziert, Prueffall", () => {
  const result = classifySixfoldStop(
    stop({
      location: { name: "X", position: { lat: 0, lng: 0 } },
      status_events: [
        { event_name: "APPROACH", event_time: "2026-07-20T10:39:00.000Z" },
        { event_name: "DEPART", event_time: "2026-07-20T11:20:00.000Z" },
      ],
    }),
  );
  assert.equal(result.gps_connected, false);
  assert.equal(result.coordinates.verified, false);
  assert.equal(result.coordinates.reason, "zero_zero");
  assert.equal(result.needs_review, true);
  assert.ok(result.flags.includes("coordinates_zero_zero"));
});

test("Zeiten ohne GPS-Praesenz-Ereignis -> wie manuell, Prueffall", () => {
  const result = classifySixfoldStop(
    stop({
      status_events: [
        { event_name: "NAVIGATE", event_time: "2026-07-20T10:00:00.000Z" },
      ],
    }),
  );
  assert.equal(result.gps_connected, false);
  assert.equal(result.needs_review, true);
  assert.ok(result.flags.includes("no_gps_presence_event"));
  assert.ok(result.flags.includes("arrival_not_gps_verified"));
});

test("nur APPROACH ohne DEPART bei gesetzter Abfahrt -> Abfahrt nicht verifiziert", () => {
  const result = classifySixfoldStop(
    stop({
      status_events: [
        { event_name: "APPROACH", event_time: "2026-07-20T10:39:00.000Z" },
      ],
    }),
  );
  assert.equal(result.arrival_verified, true);
  assert.equal(result.departure_verified, false);
  assert.equal(result.departure_estimated, false);
  assert.ok(result.flags.includes("departure_not_gps_verified"));
  assert.equal(result.needs_review, true);
});

test("fehlende status_events + fehlende Position -> leere Klassifikation", () => {
  const result = classifySixfoldStop({
    arrival_time: null,
    departure_time: null,
    location: null,
    status_events: null,
  });
  assert.equal(result.gps_connected, false);
  assert.equal(result.arrival_verified, false);
  assert.equal(result.needs_review, true);
  assert.deepEqual(result.event_names, []);
});

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeEventRow } = require("../normalize/events");
const { buildWindowIndex } = require("../normalize/zeitfenster");
const { computeStandgeldFromEvents } = require("../normalize/pipeline");

function ev(qualifier, localTime) {
  return normalizeEventRow({
    transport_number: "4B_20260726_0006622395",
    delivery_number: "D1",
    status_qualifier: qualifier,
    source: "TP XP Service Account",
    event_time: localTime,
    timezone: "Europe/Berlin",
    coordinates: "0 0",
  });
}

test("computeStandgeldFromEvents: Ladestopp -> 30 EUR im Bereich", () => {
  const events = [
    ev("status.loading.arrival", "2026-07-16 06:00"),
    ev("status.loading.departure", "2026-07-16 08:30"),
  ];

  const excelIndex = buildWindowIndex([
    { ladenummer: "6622395", ladezeit_start: "06:00", entladezeit_start: null },
  ]);

  const result = computeStandgeldFromEvents(events, {
    excelIndex,
    range: { from: "13.07.", to: "16.07.", year: 2026 },
  });

  assert.equal(result.event_count, 2);
  assert.equal(result.stops.length, 1);
  assert.equal(result.stops[0].stop_type, "LOADING");
  assert.equal(result.summary.selected_count, 1);
  assert.equal(result.summary.total_fee_eur, 30);
  assert.equal(result.selected[0].window_source, "EXCEL");
});

test("computeStandgeldFromEvents: ausserhalb Bereich -> nicht abgerechnet", () => {
  const events = [
    ev("status.loading.arrival", "2026-07-10 06:00"),
    ev("status.loading.departure", "2026-07-10 08:30"),
  ];
  const excelIndex = buildWindowIndex([
    { ladenummer: "6622395", ladezeit_start: "06:00", entladezeit_start: null },
  ]);

  const result = computeStandgeldFromEvents(events, {
    excelIndex,
    range: { from: "13.07.", to: "16.07.", year: 2026 },
  });

  assert.equal(result.stops.length, 1);
  assert.equal(result.summary.selected_count, 0);
  assert.equal(result.summary.total_fee_eur, 0);
});

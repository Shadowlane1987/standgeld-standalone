"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeEventRow } = require("../normalize/events");
const { buildGpsIndex } = require("../normalize/exportBilling");
const { billFromLiveData } = require("../normalize/liveBilling");

function tpEvent(transportNumber, qualifier, localTime) {
  return normalizeEventRow({
    transport_number: transportNumber,
    status_qualifier: qualifier,
    source: "TP XP Service Account",
    event_time: localTime,
    timezone: "Europe/Berlin",
    coordinates: "0 0",
  });
}

test("billFromLiveData: nutzt XP-Zeiten aus Event Management statt Export-Istzeiten", () => {
  const transports = [
    {
      transport_number: "2Z_20260714_0006637330",
      vehicle_registration: "PEBL7024",
      loading: {
        window_local: "2026-07-14 03:00",
        arrival_local: "2026-07-14 03:05",
        departure_local: "2026-07-14 11:39",
      },
      unloading: null,
    },
  ];

  const events = [
    tpEvent(
      "2Z_20260714_0006637330",
      "status.loading.arrival",
      "2026-07-14 03:05",
    ),
    tpEvent(
      "2Z_20260714_0006637330",
      "status.loading.departure",
      "2026-07-14 05:05",
    ),
  ];

  const result = billFromLiveData(transports, events);
  assert.equal(result.stops.length, 1);
  assert.equal(result.stops[0].arrival_local, "2026-07-14 03:05");
  assert.equal(result.stops[0].departure_local, "2026-07-14 05:05");
  assert.equal(result.stops[0].arrival_source, "XP");
  assert.equal(result.stops[0].departure_source, "XP");
  assert.equal(result.stops[0].counted_standing_minutes, 120);
  assert.equal(result.stops[0].minutes_over_free, 0);
  assert.equal(result.stops[0].fee_eur, 0);
});

test("billFromLiveData: fruehe Sixfold-Ankunft + spaetere XP-Abfahrt aus Event Management", () => {
  const transports = [
    {
      transport_number: "2Z_20260714_0006637330",
      vehicle_registration: "PEBL7024",
      loading: {
        window_local: "2026-07-14 03:00",
        arrival_local: "2026-07-14 03:05",
        departure_local: "2026-07-14 11:39",
      },
      unloading: null,
    },
  ];

  const events = [
    tpEvent(
      "2Z_20260714_0006637330",
      "status.loading.arrival",
      "2026-07-14 03:05",
    ),
    tpEvent(
      "2Z_20260714_0006637330",
      "status.loading.departure",
      "2026-07-14 05:05",
    ),
  ];

  const gpsIndex = buildGpsIndex([
    {
      transport_number: "2Z_20260714_0006637330",
      license_plate: "PEBL7024",
      type: "loading",
      arrival_time: "2026-07-14T01:04:00.000Z",
      departure_time: "2026-07-14T02:12:00.000Z",
      position: { lat: 52.5, lng: 13.4 },
      gps: { arrival_verified: true, departure_verified: true },
    },
  ]);

  const result = billFromLiveData(transports, events, { gpsIndex });
  assert.equal(result.stops.length, 1);
  assert.equal(result.stops[0].arrival_source, "GPS");
  assert.equal(result.stops[0].departure_source, "XP");
  assert.equal(result.stops[0].counted_standing_minutes, 121);
  assert.equal(result.stops[0].minutes_over_free, 1);
});
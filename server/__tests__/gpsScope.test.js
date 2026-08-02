"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeScope,
  stopIsSixfoldConnected,
  stopHasExcelTimes,
  classifyTransportsByGps,
  filterBillingByGpsScope,
} = require("../normalize/gpsScope");

function stop(overrides = {}) {
  return {
    transport_number: "T1",
    stop_type: "LOADING",
    arrival_source: "GPS",
    departure_source: "GPS",
    fee_eur: 0,
    needs_review: false,
    gps_missing: false,
    ...overrides,
  };
}

test("normalizeScope faellt bei Unbekanntem auf all zurueck", () => {
  assert.equal(normalizeScope("sixfold"), "sixfold");
  assert.equal(normalizeScope("spot"), "spot");
  assert.equal(normalizeScope("ALL"), "all");
  assert.equal(normalizeScope("quatsch"), "all");
  assert.equal(normalizeScope(undefined), "all");
});

test("stopIsSixfoldConnected nur bei Kennzeichen/GPS-Verknuepfung", () => {
  assert.equal(stopIsSixfoldConnected(stop({ gps_available: true })), true);
  assert.equal(stopIsSixfoldConnected(stop({ origin: "sixfold_only" })), true);
  assert.equal(stopIsSixfoldConnected(stop({ gps_available: false })), false);
  assert.equal(stopIsSixfoldConnected(stop({ gps_plate_match: true })), false);
});

test("stopHasExcelTimes nur wenn Ankunft UND Abfahrt aus Excel", () => {
  assert.equal(
    stopHasExcelTimes(
      stop({
        xp_arrival_time: "2026-01-01T08:00:00Z",
        xp_departure_time: "2026-01-01T09:00:00Z",
      }),
    ),
    true,
  );
  assert.equal(
    stopHasExcelTimes(stop({ xp_arrival_time: "2026-01-01T08:00:00Z" })),
    false,
  );
  assert.equal(stopHasExcelTimes(stop()), false);
});

test("classifyTransportsByGps: angebunden vs. nicht angebunden", () => {
  const stops = [
    // A: Kennzeichen/GPS-Verknuepfung -> Sixfold
    stop({ transport_number: "A", gps_available: true }),
    // B: reine Sixfold-Tour -> Sixfold
    stop({ transport_number: "B", origin: "sixfold_only" }),
    // C: kein Kennzeichen -> nicht angebunden
    stop({
      transport_number: "C",
      arrival_source: "XP",
      departure_source: "XP",
    }),
  ];
  const connected = classifyTransportsByGps(stops);
  assert.equal(connected.get("A"), true);
  assert.equal(connected.get("B"), true);
  assert.equal(connected.get("C"), false);
});

test("filterBillingByGpsScope all gibt Ergebnis unveraendert zurueck", () => {
  const result = { stops: [stop()], summary: { total_fee_eur: 0 } };
  assert.equal(filterBillingByGpsScope(result, "all"), result);
});

test("filterBillingByGpsScope sixfold/spot trennt Transporte und rechnet Summe neu", () => {
  const result = {
    stops: [
      // Transport A: an Sixfold angebunden -> Batch
      stop({
        transport_number: "A",
        stop_type: "LOADING",
        gps_available: true,
        fee_eur: 30,
      }),
      stop({
        transport_number: "A",
        stop_type: "UNLOADING",
        gps_available: true,
        fee_eur: 60,
      }),
      // Transport B: kein Kennzeichen, aber Excel-Zeiten -> Spotmarkt
      stop({
        transport_number: "B",
        stop_type: "UNLOADING",
        arrival_source: "XP",
        departure_source: "XP",
        xp_arrival_time: "2026-01-01T08:00:00Z",
        xp_departure_time: "2026-01-01T11:00:00Z",
        fee_eur: 90,
      }),
    ],
    summary: { total_fee_eur: 180, transport_count: 2 },
  };

  const sixfold = filterBillingByGpsScope(result, "sixfold");
  assert.deepEqual(
    sixfold.stops.map((s) => s.transport_number),
    ["A", "A"],
  );
  assert.equal(sixfold.summary.total_fee_eur, 90);
  assert.equal(sixfold.summary.transport_count, 1);
  assert.equal(sixfold.summary.gps_scope, "sixfold");

  const spot = filterBillingByGpsScope(result, "spot");
  assert.deepEqual(
    spot.stops.map((s) => s.transport_number),
    ["B"],
  );
  assert.equal(spot.summary.total_fee_eur, 90);
  assert.equal(spot.summary.transport_count, 1);
  assert.equal(spot.summary.gps_scope, "spot");
});

test("filterBillingByGpsScope spot: Tour ohne Excel-Zeiten kommt nicht mit hinein", () => {
  const result = {
    stops: [
      // kein Kennzeichen, aber KEINE Excel-Zeiten -> ausgeschlossen
      stop({
        transport_number: "N",
        stop_type: "UNLOADING",
        arrival_source: "XP",
        departure_source: "XP",
        fee_eur: 45,
      }),
      // kein Kennzeichen, MIT Excel-Zeiten -> bleibt
      stop({
        transport_number: "M",
        stop_type: "UNLOADING",
        arrival_source: "XP",
        departure_source: "XP",
        xp_arrival_time: "2026-01-01T08:00:00Z",
        xp_departure_time: "2026-01-01T10:00:00Z",
        fee_eur: 60,
      }),
    ],
    summary: { total_fee_eur: 105 },
  };
  const spot = filterBillingByGpsScope(result, "spot");
  assert.deepEqual(
    spot.stops.map((s) => s.transport_number),
    ["M"],
  );
  assert.equal(spot.summary.total_fee_eur, 60);

  // Auf der Batch-Seite tauchen diese Touren ohne Kennzeichen nicht auf.
  const sixfold = filterBillingByGpsScope(result, "sixfold");
  assert.equal(sixfold.stops.length, 0);
});

test("filterBillingByGpsScope: Prueffall zaehlt nicht in die Summe, Sixfold-Transport bleibt in Batch", () => {
  const result = {
    stops: [
      // Stopp ohne Transportnummer -> nicht angebunden, ohne Excel-Zeiten
      stop({
        transport_number: "",
        arrival_source: null,
        departure_source: null,
        needs_review: true,
        fee_eur: 0,
      }),
      // C: angebunden, aber Prueffall -> Summe 0
      stop({
        transport_number: "C",
        stop_type: "UNLOADING",
        gps_available: true,
        needs_review: true,
        fee_eur: 50,
      }),
    ],
    summary: { total_fee_eur: 0 },
  };
  const sixfold = filterBillingByGpsScope(result, "sixfold");
  assert.equal(
    sixfold.stops.map((s) => s.transport_number).includes("C"),
    true,
  );
  assert.equal(sixfold.summary.total_fee_eur, 0);

  // Stopp ohne Transportnummer und ohne Excel-Zeiten landet in keiner Sicht.
  const spot = filterBillingByGpsScope(result, "spot");
  assert.equal(spot.stops.length, 0);
});

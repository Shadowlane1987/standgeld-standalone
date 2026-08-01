"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeScope,
  isStopGpsBacked,
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
  assert.equal(normalizeScope("verified"), "verified");
  assert.equal(normalizeScope("gaps"), "gaps");
  assert.equal(normalizeScope("ALL"), "all");
  assert.equal(normalizeScope("quatsch"), "all");
  assert.equal(normalizeScope(undefined), "all");
});

test("isStopGpsBacked nur wenn Ankunft UND Abfahrt GPS", () => {
  assert.equal(isStopGpsBacked(stop()), true);
  assert.equal(isStopGpsBacked(stop({ departure_source: "XP" })), false);
  assert.equal(isStopGpsBacked(stop({ arrival_source: null })), false);
});

test("classifyTransportsByGps: ein fehlender Stopp macht Transport zur Luecke", () => {
  const stops = [
    stop({ transport_number: "A", stop_type: "LOADING" }),
    stop({
      transport_number: "A",
      stop_type: "UNLOADING",
      departure_source: "XP",
    }),
    stop({ transport_number: "B", stop_type: "LOADING" }),
    stop({ transport_number: "B", stop_type: "UNLOADING" }),
  ];
  const status = classifyTransportsByGps(stops);
  assert.equal(status.get("A"), false);
  assert.equal(status.get("B"), true);
});

test("filterBillingByGpsScope all gibt Ergebnis unveraendert zurueck", () => {
  const result = { stops: [stop()], summary: { total_fee_eur: 0 } };
  assert.equal(filterBillingByGpsScope(result, "all"), result);
});

test("filterBillingByGpsScope verified/gaps trennt Transporte und rechnet Summe neu", () => {
  const result = {
    stops: [
      // Transport A: vollstaendig GPS -> verified
      stop({ transport_number: "A", stop_type: "LOADING", fee_eur: 30 }),
      stop({ transport_number: "A", stop_type: "UNLOADING", fee_eur: 60 }),
      // Transport B: Abfahrt XP -> Luecke
      stop({
        transport_number: "B",
        stop_type: "UNLOADING",
        departure_source: "XP",
        fee_eur: 90,
      }),
    ],
    summary: { total_fee_eur: 180, transport_count: 2 },
  };

  const verified = filterBillingByGpsScope(result, "verified");
  assert.deepEqual(
    verified.stops.map((s) => s.transport_number),
    ["A", "A"],
  );
  assert.equal(verified.summary.total_fee_eur, 90);
  assert.equal(verified.summary.transport_count, 1);
  assert.equal(verified.summary.gps_scope, "verified");

  const gaps = filterBillingByGpsScope(result, "gaps");
  assert.deepEqual(
    gaps.stops.map((s) => s.transport_number),
    ["B"],
  );
  assert.equal(gaps.summary.total_fee_eur, 90);
  assert.equal(gaps.summary.transport_count, 1);
  assert.equal(gaps.summary.gps_scope, "gaps");
});

test("filterBillingByGpsScope: Prueffall zaehlt nicht in die Summe, Transport ohne Nummer ist Luecke", () => {
  const result = {
    stops: [
      stop({
        transport_number: "",
        arrival_source: null,
        departure_source: null,
        needs_review: true,
        fee_eur: 0,
      }),
      stop({
        transport_number: "C",
        stop_type: "UNLOADING",
        needs_review: true,
        fee_eur: 50,
      }),
    ],
    summary: { total_fee_eur: 0 },
  };
  const gaps = filterBillingByGpsScope(result, "gaps");
  // Beide sind Luecken (leere Nummer + C hat Prueffall/XP nicht vollstaendig GPS? C ist GPS aber needs_review)
  const verified = filterBillingByGpsScope(result, "verified");
  // C ist arrival/departure GPS -> verified-Kandidat, aber needs_review -> Summe 0
  assert.equal(
    verified.stops.map((s) => s.transport_number).includes("C"),
    true,
  );
  assert.equal(verified.summary.total_fee_eur, 0);
  // Stopp ohne Transportnummer landet in gaps
  assert.equal(gaps.stops.length >= 1, true);
});

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { REASON, computeStandgeld } = require("../normalize/standgeld");

// Basis: Fenster 06:00Z. Ankunft puenktlich, Abfahrt variiert.
function stop(overrides) {
  return {
    transport_number: "T1",
    delivery_number: "D1",
    stop_type: "LOADING",
    window_start: "2026-07-16T06:00:00.000Z",
    arrival_time: "2026-07-16T06:00:00.000Z",
    ...overrides,
  };
}

test("2h09 ueber Fenster -> unter Schwelle, 0 EUR", () => {
  const r = computeStandgeld(
    stop({ departure_time: "2026-07-16T08:09:00.000Z" }),
  );
  assert.equal(r.counted_standing_minutes, 129);
  assert.equal(r.reason, REASON.BELOW_TRIGGER);
  assert.equal(r.chargeable, false);
  assert.equal(r.fee_eur, 0);
});

test("2h10 ueber Fenster -> erste Stufe, 30 EUR", () => {
  const r = computeStandgeld(
    stop({ departure_time: "2026-07-16T08:10:00.000Z" }),
  );
  assert.equal(r.counted_standing_minutes, 130);
  assert.equal(r.minutes_over_free, 10);
  assert.equal(r.billable_blocks, 1);
  assert.equal(r.fee_eur, 30);
  assert.equal(r.chargeable, true);
  assert.equal(r.reason, REASON.CHARGEABLE);
});

test("2h30 -> genau ein angefangener Block, 30 EUR", () => {
  const r = computeStandgeld(
    stop({ departure_time: "2026-07-16T08:30:00.000Z" }),
  );
  assert.equal(r.minutes_over_free, 30);
  assert.equal(r.billable_blocks, 1);
  assert.equal(r.fee_eur, 30);
});

test("2h31 -> zweiter angefangener Block, 60 EUR", () => {
  const r = computeStandgeld(
    stop({ departure_time: "2026-07-16T08:31:00.000Z" }),
  );
  assert.equal(r.minutes_over_free, 31);
  assert.equal(r.billable_blocks, 2);
  assert.equal(r.fee_eur, 60);
});

test("innerhalb der 2h Freizeit -> 0 EUR", () => {
  const r = computeStandgeld(
    stop({ departure_time: "2026-07-16T07:30:00.000Z" }),
  );
  assert.equal(r.counted_standing_minutes, 90);
  assert.equal(r.reason, REASON.WITHIN_FREE);
  assert.equal(r.fee_eur, 0);
});

test("Spaetankunft: Zaehlung ab Ankunft, nicht ab Fenster", () => {
  const r = computeStandgeld(
    stop({
      arrival_time: "2026-07-16T07:00:00.000Z",
      departure_time: "2026-07-16T09:30:00.000Z",
    }),
  );
  assert.equal(r.arrived_late, true);
  assert.equal(r.count_start, "2026-07-16T07:00:00.000Z");
  assert.equal(r.counted_standing_minutes, 150);
  assert.equal(r.fee_eur, 30);
});

test("Fruehankunft: Wartezeit vor dem Fenster wird NICHT gezaehlt", () => {
  const r = computeStandgeld(
    stop({
      arrival_time: "2026-07-16T05:00:00.000Z",
      departure_time: "2026-07-16T08:30:00.000Z",
    }),
  );
  assert.equal(r.arrived_late, false);
  // Zaehlbeginn 06:00 (Fenster), nicht 05:00.
  assert.equal(r.count_start, "2026-07-16T06:00:00.000Z");
  assert.equal(r.counted_standing_minutes, 150);
  assert.equal(r.fee_eur, 30);
});

test("fehlende Zeitbasis -> nicht berechenbar, Prueffall", () => {
  const r = computeStandgeld(
    stop({ window_start: null, departure_time: "2026-07-16T09:00:00.000Z" }),
  );
  assert.equal(r.reason, REASON.MISSING_DATA);
  assert.equal(r.chargeable, false);
  assert.equal(r.needs_review, true);
});

test("needs_review wird aus dem Stopp uebernommen", () => {
  const r = computeStandgeld(
    stop({
      departure_time: "2026-07-16T09:00:00.000Z",
      needs_review: true,
    }),
  );
  assert.equal(r.needs_review, true);
  assert.equal(r.fee_eur, 60);
});

test("konfigurierbare Freizeit/Satz", () => {
  const r = computeStandgeld(
    stop({ departure_time: "2026-07-16T07:45:00.000Z" }),
    { freeMinutes: 60, blockRateEur: 25 },
  );
  // 105 min gezaehlt, 45 ueber Freizeit -> 2 Bloecke * 25 = 50.
  assert.equal(r.counted_standing_minutes, 105);
  assert.equal(r.minutes_over_free, 45);
  assert.equal(r.billable_blocks, 2);
  assert.equal(r.fee_eur, 50);
});

test("Obergrenze 650 EUR wird nie ueberschritten", () => {
  // 25 h 10 gezaehlt -> weit ueber 650 EUR ungedeckelt.
  const r = computeStandgeld(
    stop({ departure_time: "2026-07-17T07:10:00.000Z" }),
  );
  assert.equal(r.fee_capped, true);
  assert.equal(r.fee_eur, 650);
  assert.equal(r.max_fee_eur, 650);
  // Bloecke bleiben ungedeckelt sichtbar (Nachvollziehbarkeit).
  assert.ok(r.billable_blocks * r.block_rate_eur > 650);
});

test("knapp unter der Obergrenze bleibt ungedeckelt", () => {
  // Genau 650 EUR (nicht darueber) -> nicht gedeckelt.
  const r = computeStandgeld(
    stop({ departure_time: "2026-07-16T06:00:00.000Z" }),
    { maxFeeEur: 650, freeMinutes: 0, triggerMinutes: 0 },
  );
  assert.equal(r.fee_eur, 0);
  assert.equal(r.fee_capped, false);
});

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
  // 23 h 30 gezaehlt (plausibel, unter 24 h) -> weit ueber 650 EUR ungedeckelt.
  const r = computeStandgeld(
    stop({ departure_time: "2026-07-17T05:30:00.000Z" }),
  );
  assert.equal(r.fee_capped, true);
  assert.equal(r.fee_eur, 650);
  assert.equal(r.max_fee_eur, 650);
  // Bloecke bleiben ungedeckelt sichtbar (Nachvollziehbarkeit).
  assert.ok(r.billable_blocks * r.block_rate_eur > 650);
});

test("Standzeit ueber 24 h ist unplausibel -> Prueffall, keine Abrechnung", () => {
  // 25 h 10 gezaehlt -> fast sicher falsch gematchte Ankunft/Abfahrt.
  const r = computeStandgeld(
    stop({ departure_time: "2026-07-17T07:10:00.000Z" }),
  );
  assert.equal(r.reason, REASON.IMPLAUSIBLE_DURATION);
  assert.equal(r.chargeable, false);
  assert.equal(r.fee_eur, 0);
  assert.equal(r.needs_review, true);
  // Dauer bleibt zur Nachvollziehbarkeit sichtbar.
  assert.equal(r.counted_standing_minutes, 1510);
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

test("Ruhezeit automatisch abziehen: 13h Standzeit -> 9h abgezogen -> 4h effektiv (Nutzer 2026-07-20)", () => {
  // 13 Stunden (780 min) Standzeit: Fenster 06:00, Ankunft 06:00, Abfahrt 19:00Z.
  // Mit Ruhezeit: 780 - 540 = 240 min (4h) effektiv.
  // Mit Freizeit 120 min: 240 - 120 = 120 min = 4 Bloecke a 30 EUR = 120 EUR.
  const r = computeStandgeld(
    stop({ departure_time: "2026-07-16T19:00:00.000Z" }),
  );
  assert.equal(r.counted_standing_minutes, 780); // Rohwert
  assert.equal(r.effective_standing_minutes, 240); // Nach Ruhezeit-Abzug
  assert.equal(r.rest_time_deducted, true);
  assert.equal(r.minutes_over_free, 120); // 240 - 120 Freizeit
  assert.equal(r.billable_blocks, 4);
  assert.equal(r.fee_eur, 120);
  assert.equal(r.chargeable, true);
  assert.equal(r.reason, REASON.CHARGEABLE);
});

test("Standzeit genau 12h Grenze: keine Ruhezeit abgezogen", () => {
  // 12 Stunden genau = 720 min -> NICHT > 720, also keine Ruhezeit-Abzug.
  const r = computeStandgeld(
    stop({ departure_time: "2026-07-16T18:00:00.000Z" }),
  );
  assert.equal(r.counted_standing_minutes, 720);
  assert.equal(r.effective_standing_minutes, 720); // Kein Abzug
  assert.equal(r.rest_time_deducted, false);
  assert.equal(r.minutes_over_free, 600); // 720 - 120
  assert.equal(r.billable_blocks, 20); // 600 / 30
  assert.equal(r.fee_eur, 600);
  assert.equal(r.chargeable, true);
});

test("Standzeit > 12h mit Ruhezeit ergibt niedrige Gebühr (nicht 650 EUR Deckel)", () => {
  // 15 Stunden = 900 min. Nach Ruhezeit: 900 - 540 = 360 min.
  // Mit Freizeit: 360 - 120 = 240 min = 8 Bloecke = 240 EUR.
  const r = computeStandgeld(
    stop({ departure_time: "2026-07-16T21:00:00.000Z" }),
  );
  assert.equal(r.counted_standing_minutes, 900);
  assert.equal(r.effective_standing_minutes, 360);
  assert.equal(r.rest_time_deducted, true);
  assert.equal(r.fee_eur, 240);
  assert.equal(r.fee_capped, false); // Nicht gedeckelt (weit unter 650)
  assert.equal(r.chargeable, true);
});

test("Umbuchung/Pause: GPS-Ankunft weit vor Fenster -> ab Ankunft zaehlen + Prueffall", () => {
  // Fenster 06:00 (umgebucht), GPS-Ankunft 4h frueher (02:00), Abfahrt 09:00.
  // Ohne Sonderregel wuerde ab 06:00 gezaehlt (3h). Mit GPS-Beleg ab 02:00 (7h).
  const r = computeStandgeld(
    stop({
      arrival_time: "2026-07-16T02:00:00.000Z",
      departure_time: "2026-07-16T09:00:00.000Z",
      arrival_gps_verified: true,
    }),
  );
  assert.equal(r.rebooking_suspected, true);
  assert.equal(r.count_start, "2026-07-16T02:00:00.000Z");
  assert.equal(r.counted_standing_minutes, 420); // 7h ab echter Ankunft
  assert.equal(r.needs_review, true); // Prueffall
  assert.equal(r.chargeable, true);
});

test("Umbuchung/Pause: OHNE GPS bleibt es beim Fenster (konservativ)", () => {
  // Gleiche Zeiten, aber arrival_gps_verified nicht gesetzt -> normale Frueh-
  // ankunft-Regel: ab Fenster 06:00 zaehlen, kein Prueffall.
  const r = computeStandgeld(
    stop({
      arrival_time: "2026-07-16T02:00:00.000Z",
      departure_time: "2026-07-16T09:00:00.000Z",
    }),
  );
  assert.equal(r.rebooking_suspected, false);
  assert.equal(r.count_start, "2026-07-16T06:00:00.000Z");
  assert.equal(r.counted_standing_minutes, 180); // 3h ab Fenster
});

test("Umbuchung/Pause: GPS-Ankunft nur knapp vor Fenster (unter Schwelle) -> Fenster", () => {
  // GPS-Ankunft nur 1h vor Fenster (< 3h Schwelle) -> normale Fruehankunft, kein
  // Umbuchungsfall. Ab Fenster zaehlen.
  const r = computeStandgeld(
    stop({
      arrival_time: "2026-07-16T05:00:00.000Z",
      departure_time: "2026-07-16T09:00:00.000Z",
      arrival_gps_verified: true,
    }),
  );
  assert.equal(r.rebooking_suspected, false);
  assert.equal(r.count_start, "2026-07-16T06:00:00.000Z");
  assert.equal(r.counted_standing_minutes, 180);
});

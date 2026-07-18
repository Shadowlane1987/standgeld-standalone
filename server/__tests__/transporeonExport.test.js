"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  cleanDateTime,
  parseTransporeonExport,
  exportToWindowMap,
} = require("../normalize/transporeonExport");
const { billFromExport } = require("../normalize/exportBilling");

const HEADER = [
  "Entladedatum",
  "Transportnr.",
  "Gebucht ab - Time Slot Management",
  "Ankunft - Time Slot Management",
  "Abfahrt - Time Slot Management",
  "Gebucht ab - Zweite Buchung - Time Slot Management",
  "Ankunft - Zweite Buchung - Time Slot Management",
  "Abfahrt - Zweite Buchung - Time Slot Management",
];

function row(unloadingDate, tn, lw, la, ld, uw, ua, ud) {
  return [unloadingDate, tn, lw, la, ld, uw, ua, ud];
}

test("cleanDateTime: nimmt volles Datum, verwirft Platzhalter", () => {
  assert.equal(cleanDateTime("2026-07-16 18:00"), "2026-07-16 18:00");
  assert.equal(cleanDateTime("2026-07-16T18:00"), "2026-07-16 18:00");
  assert.equal(cleanDateTime("-"), null);
  assert.equal(cleanDateTime(""), null);
  assert.equal(cleanDateTime("Netto"), null);
});

test("parseTransporeonExport: beide Stopps mit vollem Datum", () => {
  const rows = [
    HEADER,
    row(
      "2026-07-17",
      "B2_20260717_0006647418",
      "2026-07-16 18:00",
      "2026-07-16 16:06",
      "2026-07-16 16:57",
      "2026-07-17 07:00",
      "2026-07-16 18:02",
      "2026-07-17 06:54",
    ),
  ];
  const out = parseTransporeonExport(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].transport_number, "B2_20260717_0006647418");
  assert.equal(out[0].loading.window_local, "2026-07-16 18:00");
  assert.equal(out[0].unloading.window_local, "2026-07-17 07:00");
  assert.equal(out[0].unloading.departure_local, "2026-07-17 06:54");
});

test("parseTransporeonExport: Transport ohne Entladefenster hat nur Ladestopp", () => {
  const rows = [
    HEADER,
    row(
      "2026-07-17",
      "91_20260717_0006647297",
      "2026-07-17 04:30",
      "2026-07-17 04:32",
      "2026-07-17 07:10",
      "-",
      "-",
      "-",
    ),
  ];
  const out = parseTransporeonExport(rows);
  assert.equal(out[0].loading.window_local, "2026-07-17 04:30");
  assert.equal(out[0].unloading, null);
});

test("exportToWindowMap: volle lokale Fensterzeit je Stopp", () => {
  const out = parseTransporeonExport([
    HEADER,
    row(
      "2026-07-17",
      "B2_20260717_0006647418",
      "2026-07-16 18:00",
      "",
      "",
      "2026-07-17 07:00",
      "",
      "",
    ),
  ]);
  const map = exportToWindowMap(out);
  assert.equal(map.get("B2_20260717_0006647418|LOADING"), "2026-07-16 18:00");
  assert.equal(map.get("B2_20260717_0006647418|UNLOADING"), "2026-07-17 07:00");
});

test("billFromExport: reproduziert Referenzbetraege (XP-Zeiten)", () => {
  const rows = [
    HEADER,
    // 0C_7213: Fenster 09:00, An 10:15, Ab 14:03 = 228 min -> 120 EUR
    row(
      "2026-07-17",
      "0C_20260717_0006647213",
      "2026-07-17 09:00",
      "2026-07-17 10:15",
      "2026-07-17 14:03",
      "-",
      "-",
      "-",
    ),
    // 61_7227: Fenster 16:00, An 14:48, Ab 19:10 = 190 min -> 90 EUR
    row(
      "2026-07-17",
      "61_20260717_0006647227",
      "2026-07-16 16:00",
      "2026-07-16 14:48",
      "2026-07-16 19:10",
      "-",
      "-",
      "-",
    ),
    // 91_7297: Fenster 04:30, An 04:32, Ab 07:10 = 158 min -> 60 EUR
    row(
      "2026-07-17",
      "91_20260717_0006647297",
      "2026-07-17 04:30",
      "2026-07-17 04:32",
      "2026-07-17 07:10",
      "-",
      "-",
      "-",
    ),
  ];
  const out = parseTransporeonExport(rows);
  const { stops, summary } = billFromExport(out);
  const fee = (needle) =>
    stops.find((s) => s.transport_number.includes(needle)).fee_eur;
  assert.equal(fee("0006647213"), 120);
  assert.equal(fee("0006647227"), 90);
  assert.equal(fee("0006647297"), 60);
  assert.equal(summary.total_fee_eur, 270);
});

test("billFromExport: fehlende Zeiten -> Prueffall, kein Absturz", () => {
  const rows = [
    HEADER,
    row("2026-07-17", "XX_1", "2026-07-17 08:00", "", "", "-", "-", "-"),
  ];
  const { stops } = billFromExport(parseTransporeonExport(rows));
  assert.equal(stops.length, 1);
  assert.equal(stops[0].needs_review, true);
});

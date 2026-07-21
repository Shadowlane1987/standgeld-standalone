"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  cleanDateTime,
  parseTransporeonExport,
  exportToWindowMap,
  exportToEvents,
} = require("../normalize/transporeonExport");
const { billFromExport, buildGpsIndex } = require("../normalize/exportBilling");
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

test("parseTransporeonExport: vertauschte erste/zweite Buchung wird korrigiert", () => {
  const rows = [
    HEADER,
    row(
      "2026-07-13",
      "2Z_20260713_0006636393",
      "2026-07-13 01:00",
      "2026-07-13 06:11",
      "2026-07-13 06:50",
      "2026-07-13 02:00",
      "2026-07-13 03:17",
      "2026-07-13 04:12",
    ),
  ];

  const out = parseTransporeonExport(rows);
  assert.equal(out.length, 1);

  // Erwartung: Loading ist der fruehere Besuch (03:17 -> 04:12),
  // Unloading der spaetere Besuch (06:11 -> 06:50).
  assert.equal(out[0].loading.arrival_local, "2026-07-13 03:17");
  assert.equal(out[0].loading.departure_local, "2026-07-13 04:12");
  assert.equal(out[0].unloading.arrival_local, "2026-07-13 06:11");
  assert.equal(out[0].unloading.departure_local, "2026-07-13 06:50");
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

test("exportToEvents: Lade- UND Entlade-Ist-Zeiten als TP-XP-Events", () => {
  const out = parseTransporeonExport([
    HEADER,
    row(
      "2026-07-17",
      "B2_20260717_0006647418",
      "2026-07-16 18:00",
      "2026-07-16 16:06",
      "2026-07-16 16:57",
      "2026-07-17 07:00",
      "2026-07-17 06:02",
      "2026-07-17 06:54",
    ),
  ]);
  const events = exportToEvents(out);
  // 2 Lade- + 2 Entlade-Events.
  assert.equal(events.length, 4);
  for (const e of events) {
    assert.equal(e.source_type, "TP_XP");
    assert.equal(e.transport_number, "B2_20260717_0006647418");
    assert.equal(e.gps_verified, false);
  }
  const cats = events.map((e) => e.event_category).sort();
  assert.deepEqual(cats, [
    "LOAD_ARRIVAL",
    "LOAD_DEPARTURE",
    "UNLOAD_ARRIVAL",
    "UNLOAD_DEPARTURE",
  ]);
});

test("exportToEvents: fehlende Ist-Zeiten erzeugen keine Events", () => {
  const out = parseTransporeonExport([
    HEADER,
    row(
      "2026-07-17",
      "91_20260717_0006647297",
      "2026-07-17 04:30",
      "-",
      "-",
      "-",
      "-",
      "-",
    ),
  ]);
  // Nur ein Ladefenster, keine Ist-Zeiten -> keine Events.
  assert.equal(exportToEvents(out).length, 0);
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

test("billFromExport: bei invertierter Buchung keine Entlade-Abfahrt im Lade-Stopp", () => {
  const rows = [
    HEADER,
    row(
      "2026-07-13",
      "2Z_20260713_0006636393",
      "2026-07-13 01:00",
      "2026-07-13 06:11",
      "2026-07-13 06:50",
      "2026-07-13 02:00",
      "2026-07-13 03:17",
      "2026-07-13 04:12",
    ),
  ];

  const transports = parseTransporeonExport(rows);
  const gpsIndex = buildGpsIndex([
    {
      transport_number: "2Z_20260713_0006636393",
      license_plate: "PEBL7030",
      type: "loading",
      arrival_time: "2026-07-13T01:04:00.000Z", // 03:04 CEST
      departure_time: "2026-07-13T02:12:00.000Z", // 04:12 CEST
      position: { lat: 52.5, lng: 13.4 },
      gps: { arrival_verified: true, departure_verified: true },
    },
  ]);

  const result = billFromExport(transports, { gpsIndex });
  const loadingStop = result.stops.find((s) => s.stop_type === "LOADING");
  assert.ok(loadingStop);

  // Kritisch: Lade-Stopp endet NICHT mit 06:50 (spaetere Entlade-Abfahrt),
  // sondern mit dem Lade-Ende 04:12.
  assert.equal(loadingStop.departure_local, "2026-07-13 04:12");
  assert.equal(loadingStop.departure_source, "XP");
});

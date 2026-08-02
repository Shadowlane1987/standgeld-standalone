"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  appendSixfoldOnlyStops,
  billSixfoldFirst,
} = require("../normalize/sixfoldFirstBilling");
const { buildWindowIndex } = require("../normalize/zeitfenster");
const { transportNumberToLadenummer } = require("../normalize/ladenummer");

// Basis-Excel-Ergebnis (wie billFromExport es liefert), stark vereinfacht.
function excelResult(stops = []) {
  return {
    stops,
    summary: {
      transport_count: 1,
      stop_count: stops.length,
      chargeable_count: stops.filter((s) => s.fee_eur > 0).length,
      review_count: 0,
      total_fee_eur: stops.reduce((a, s) => a + (s.fee_eur || 0), 0),
    },
  };
}

// Sixfold-Stopp im "simple shape" (wie resolveGpsIndexFromHeaders liefert).
function sixfoldStop(overrides = {}) {
  return {
    transport_number: "B2_20260723_0006654477",
    license_plate: "B-AB123",
    type: "LOADING",
    arrival_time: "2026-07-23T06:00:00.000Z",
    departure_time: "2026-07-23T09:30:00.000Z",
    timeslot_begin: "2026-07-23T06:00:00.000Z",
    booking_location: "DE-14974 Ludwigsfelde",
    position: { lat: 52.3, lng: 13.2 },
    gps: { arrival_verified: true, departure_verified: true },
    ...overrides,
  };
}

test("Sixfold-only Tour wird ergänzt, wenn nicht im Excel", () => {
  const result = appendSixfoldOnlyStops(excelResult([]), {
    transports: [],
    sixfoldStops: [sixfoldStop()],
  });
  assert.equal(result.summary.sixfold_only_count, 1);
  assert.equal(result.stops.length, 1);
  const s = result.stops[0];
  assert.equal(s.origin, "sixfold_only");
  assert.equal(s.arrival_source, "GPS");
  assert.equal(s.departure_source, "GPS");
  assert.equal(s.gps_license_plate, "B-AB123");
  assert.equal(s.booking_location, "DE-14974 Ludwigsfelde");
  // 06:00 -> 09:30 = 210 min, 120 frei, 90 über -> 3 Blöcke -> 90 EUR
  assert.equal(s.fee_eur, 90);
});

test("Tour, die schon im Excel ist (normalisierte TN), wird NICHT doppelt ergänzt", () => {
  const result = appendSixfoldOnlyStops(excelResult([]), {
    // Excel-TN hat anderes Präfix, gleiche 10-stellige Endnummer UND deckt den
    // LADEN-Stopp ab (loading-Zeile vorhanden) -> darf nicht doppelt kommen.
    transports: [
      {
        transport_number: "0C_20260723_0006654477",
        loading: { window_local: "2026-07-23 08:00" },
      },
    ],
    sixfoldStops: [sixfoldStop()],
  });
  assert.equal(result.summary.sixfold_only_count, 0);
  assert.equal(result.stops.length, 0);
});

test("Excel-Tour ohne Entlade-Zeile: Entladestelle wird aus Sixfold-GPS ergänzt (nicht gelöscht)", () => {
  const result = appendSixfoldOnlyStops(excelResult([]), {
    // Excel hat nur den Laden-Stopp; der Entlade-Stopp fehlt in der Excel.
    transports: [
      {
        transport_number: "0C_20260723_0006654477",
        loading: { window_local: "2026-07-23 08:00" },
      },
    ],
    sixfoldStops: [
      sixfoldStop({ type: "LOADING" }),
      sixfoldStop({ type: "UNLOADING" }),
    ],
  });
  // LADEN ist in der Excel -> nicht doppelt; ENTLADEN fehlt -> aus GPS ergänzt.
  assert.equal(result.summary.sixfold_only_count, 1);
  assert.equal(result.stops.length, 1);
  assert.equal(result.stops[0].stop_type, "UNLOADING");
});

test("Sixfold-Stopp ohne verifizierte GPS-Zeit wird nicht abgerechnet", () => {
  const result = appendSixfoldOnlyStops(excelResult([]), {
    transports: [],
    sixfoldStops: [
      sixfoldStop({
        gps: { arrival_verified: false, departure_verified: false },
      }),
    ],
  });
  assert.equal(result.summary.sixfold_only_count, 0);
});

test("0/0-Koordinaten gelten nicht als verifiziertes GPS", () => {
  const result = appendSixfoldOnlyStops(excelResult([]), {
    transports: [],
    sixfoldStops: [sixfoldStop({ position: { lat: 0, lng: 0 } })],
  });
  assert.equal(result.summary.sixfold_only_count, 0);
});

test("Mehrfachbesuch: früheste Ankunft + späteste Abfahrt gewinnen", () => {
  const result = appendSixfoldOnlyStops(excelResult([]), {
    transports: [],
    sixfoldStops: [
      sixfoldStop({
        arrival_time: "2026-07-23T06:00:00.000Z",
        departure_time: "2026-07-23T07:00:00.000Z",
      }),
      sixfoldStop({
        arrival_time: "2026-07-23T05:00:00.000Z",
        departure_time: "2026-07-23T12:00:00.000Z",
      }),
    ],
  });
  assert.equal(result.summary.sixfold_only_count, 1);
  const s = result.stops[0];
  assert.equal(s.gps_arrival_time, "2026-07-23T05:00:00.000Z");
  assert.equal(s.gps_departure_time, "2026-07-23T12:00:00.000Z");
});

test("Excel-Entladezeit ist massgeblich und ersetzt auch ein Sixfold-Fenster", () => {
  const tn = "B2_20260723_0006654477";
  const ladenummer = transportNumberToLadenummer(tn); // "6654477"
  const unloadWindowIndex = buildWindowIndex([
    { ladenummer, entladezeit_start: "16:30" },
  ]);
  const result = appendSixfoldOnlyStops(excelResult([]), {
    transports: [],
    sixfoldStops: [
      sixfoldStop({
        transport_number: tn,
        type: "UNLOADING",
        arrival_time: "2026-07-23T15:00:00.000Z",
        departure_time: "2026-07-23T19:30:00.000Z",
        // Sixfold liefert 06:00, aber die Excel-Entladezeit (16:30) gewinnt.
        timeslot_begin: "2026-07-23T06:00:00.000Z",
      }),
    ],
    unloadWindowIndex,
  });
  assert.equal(result.summary.sixfold_unload_window_from_excel, 1);
  const s = result.stops[0];
  assert.equal(s.unload_window_fallback_applied, true);
  // Zaehlbeginn ab Excel 16:30 -> 19:30 = 180 min, 120 frei, 60 ueber -> 2 -> 60 EUR.
  assert.equal(s.fee_eur, 60);
});

test("Excel-Entladefenster wird ergaenzt, wenn Sixfold KEIN Fenster hat", () => {
  const tn = "B2_20260723_0006654477";
  const ladenummer = transportNumberToLadenummer(tn); // "6654477"
  const unloadWindowIndex = buildWindowIndex([
    { ladenummer, entladezeit_start: "16:30" },
  ]);
  const result = appendSixfoldOnlyStops(excelResult([]), {
    transports: [],
    sixfoldStops: [
      sixfoldStop({
        transport_number: tn,
        type: "UNLOADING",
        // Ankunft VOR Fenster -> Zaehlbeginn ab Excel-Fenster (16:30).
        arrival_time: "2026-07-23T15:00:00.000Z",
        departure_time: "2026-07-23T19:30:00.000Z",
        // KEIN Sixfold-Fenster vorhanden -> Excel fuellt die Luecke.
        timeslot_begin: null,
      }),
    ],
    unloadWindowIndex,
  });
  assert.equal(result.summary.sixfold_unload_window_from_excel, 1);
  const s = result.stops[0];
  assert.equal(s.unload_window_fallback_applied, true);
  assert.equal(s.window_local, "2026-07-23 16:30");
  // 16:30 -> 19:30 = 180 min, 120 frei, 60 ueber -> 2 Bloecke -> 60 EUR.
  assert.equal(s.fee_eur, 60);
});

test("bestehende Excel-Stops bleiben erhalten und Summe stimmt", () => {
  const base = excelResult([
    { fee_eur: 30, needs_review: false, transport_number: "X1" },
  ]);
  const result = appendSixfoldOnlyStops(base, {
    transports: [{ transport_number: "X1_20260723_0000000001" }],
    sixfoldStops: [sixfoldStop()],
  });
  // 1 Excel + 1 Sixfold-only
  assert.equal(result.stops.length, 2);
  assert.equal(result.summary.sixfold_only_count, 1);
  assert.equal(result.summary.total_fee_eur, 120); // 30 + 90
});

// ---- billSixfoldFirst: Sixfold ist die BASIS, Excel nur Overlay ----

test("billSixfoldFirst: ALLE Sixfold-Touren sind Basis, auch ohne Excel", () => {
  const result = billSixfoldFirst([sixfoldStop()], { transports: [] });
  assert.equal(result.summary.transport_count, 1);
  assert.equal(result.stops.length, 1);
  const s = result.stops[0];
  assert.equal(s.origin, "sixfold");
  assert.equal(s.arrival_source, "GPS");
  assert.equal(s.gps_license_plate, "B-AB123");
  assert.equal(s.fee_eur, 90);
});

test("billSixfoldFirst: Excel liefert nur das Fenster, GPS-Zeiten bleiben Basis", () => {
  const result = billSixfoldFirst([sixfoldStop({ type: "UNLOADING" })], {
    transports: [
      {
        transport_number: "0C_20260723_0006654477",
        vehicle_registration: "B-AB123",
        unloading: {
          window_local: "2026-07-23 08:00",
          arrival_local: null,
          departure_local: null,
          location: "DE-29683",
        },
      },
    ],
  });
  assert.equal(result.stops.length, 1);
  const s = result.stops[0];
  assert.equal(s.origin, "sixfold");
  // GPS-Zeiten bleiben massgeblich (06:00 -> 09:30).
  assert.equal(s.gps_arrival_time, "2026-07-23T06:00:00.000Z");
  assert.equal(s.arrival_source, "GPS");
  // Fenster kommt aus der Excel ("Gebucht ab").
  assert.equal(s.window_local, "2026-07-23 08:00");
});

test("billSixfoldFirst: Tour NUR in der Excel wird als excel_only ergaenzt (Spot)", () => {
  const result = billSixfoldFirst([sixfoldStop()], {
    transports: [
      {
        transport_number: "9Z_20260723_0009999999",
        vehicle_registration: null,
        loading: {
          window_local: "2026-07-23 06:00",
          arrival_local: "2026-07-23 06:00",
          departure_local: "2026-07-23 09:30",
          location: "DE-14974",
        },
      },
    ],
  });
  // 1 Sixfold (Basis) + 1 Excel-only.
  assert.equal(result.stops.length, 2);
  assert.equal(result.summary.sixfold_only_count, 1);
  const spot = result.stops.find((s) => s.origin === "excel_only");
  assert.ok(spot);
  assert.equal(spot.arrival_source, "XP");
  assert.equal(spot.gps_available, false);
});

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  billFromExport,
  buildGpsIndex,
  chooseArrival,
  chooseDeparture,
} = require("../normalize/exportBilling");

test("chooseArrival: fruehere Zeit gewinnt (laengere Standzeit)", () => {
  const xp = "2026-07-16T06:30:00.000Z";
  const gps = "2026-07-16T06:00:00.000Z";
  assert.deepEqual(chooseArrival(xp, gps), { iso: gps, source: "GPS" });
  assert.deepEqual(chooseArrival(gps, xp), { iso: gps, source: "XP" });
});

test("chooseArrival: fehlende Zeit -> andere gewinnt", () => {
  const xp = "2026-07-16T06:30:00.000Z";
  assert.deepEqual(chooseArrival(xp, null), { iso: xp, source: "XP" });
  assert.deepEqual(chooseArrival(null, xp), { iso: xp, source: "GPS" });
  assert.deepEqual(chooseArrival(null, null), { iso: null, source: null });
});

test("chooseDeparture: spaetere Zeit gewinnt (laengere Standzeit)", () => {
  const xp = "2026-07-16T08:00:00.000Z";
  const gps = "2026-07-16T09:00:00.000Z";
  assert.deepEqual(chooseDeparture(xp, gps), { iso: gps, source: "GPS" });
  assert.deepEqual(chooseDeparture(gps, xp), { iso: gps, source: "XP" });
});

test("buildGpsIndex: nur verifizierte GPS-Zeiten werden uebernommen", () => {
  const stops = [
    {
      transport_number: "T1",
      type: "loading",
      arrival_time: "2026-07-16T06:00:00.000Z",
      departure_time: "2026-07-16T09:00:00.000Z",
      gps: { arrival_verified: true, departure_verified: false },
    },
  ];
  const index = buildGpsIndex(stops);
  const entry = index.get("T1|LOADING");
  assert.ok(entry);
  assert.equal(entry.arrival_iso, "2026-07-16T06:00:00.000Z");
  assert.equal(entry.departure_iso, null); // departure nicht verifiziert
  assert.equal(entry.present, true);
});

test("buildGpsIndex: Stopps ohne transport_number/type ignorieren", () => {
  const index = buildGpsIndex([
    { transport_number: "", type: "loading", gps: {} },
    { transport_number: "T1", type: "waypoint", gps: {} },
  ]);
  assert.equal(index.size, 0);
});

test("billFromExport ohne gpsIndex: nicht geprueft, XP-Zeiten abgerechnet", () => {
  const transports = [
    {
      transport_number: "T1",
      loading: {
        window_local: "2026-07-16 06:00",
        arrival_local: "2026-07-16 08:00",
        departure_local: "2026-07-16 12:00",
      },
      unloading: null,
    },
  ];
  const { stops, summary } = billFromExport(transports);
  assert.equal(stops.length, 1);
  // Ohne GPS-Quelle NICHT als "kein GPS" markieren (wurde nie geprueft).
  assert.equal(stops[0].gps_checked, false);
  assert.equal(stops[0].gps_missing, false);
  assert.equal(stops[0].gps_available, false);
  assert.equal(stops[0].arrival_source, "XP");
  assert.equal(stops[0].departure_source, "XP");
  assert.equal(summary.gps_checked, false);
  assert.equal(summary.gps_missing_count, 0);
  assert.equal(summary.gps_used_count, 0);
  assert.ok(stops[0].fee_eur > 0); // XP wird trotzdem abgerechnet
});

test("billFromExport mit gpsIndex aber ohne Treffer: gps_missing=true", () => {
  const transports = [
    {
      transport_number: "T1",
      loading: {
        window_local: "2026-07-16 06:00",
        arrival_local: "2026-07-16 08:00",
        departure_local: "2026-07-16 12:00",
      },
      unloading: null,
    },
  ];
  // GPS-Index vorhanden, aber fuer eine ANDERE Transportnummer.
  const gpsIndex = buildGpsIndex([
    {
      transport_number: "T2",
      type: "loading",
      arrival_time: "2026-07-16T06:00:00.000Z",
      departure_time: "2026-07-16T10:00:00.000Z",
      gps: { arrival_verified: true, departure_verified: true },
    },
  ]);
  const { stops, summary } = billFromExport(transports, { gpsIndex });
  assert.equal(stops[0].gps_checked, true);
  assert.equal(stops[0].gps_missing, true);
  assert.equal(summary.gps_checked, true);
  assert.equal(summary.gps_missing_count, 1);
});

test("billFromExport mit gpsIndex: laengere GPS-Abfahrt gewinnt = mehr Standgeld", () => {
  const transports = [
    {
      transport_number: "T1",
      loading: {
        window_local: "2026-07-16 06:00",
        arrival_local: "2026-07-16 08:00",
        departure_local: "2026-07-16 10:00",
      },
      unloading: null,
    },
  ];

  const gpsIndex = buildGpsIndex([
    {
      transport_number: "T1",
      type: "loading",
      arrival_time: "2026-07-16T06:00:00.000Z", // 08:00 Berlin (CEST)
      departure_time: "2026-07-16T10:00:00.000Z", // 12:00 Berlin -> spaeter als XP 10:00
      gps: { arrival_verified: true, departure_verified: true },
    },
  ]);

  const withoutGps = billFromExport(transports);
  const withGps = billFromExport(transports, { gpsIndex });

  assert.equal(withGps.stops[0].departure_source, "GPS");
  assert.equal(withGps.stops[0].gps_available, true);
  assert.equal(withGps.stops[0].gps_missing, false);
  // Spaetere Abfahrt -> hoeheres oder gleiches Standgeld.
  assert.ok(withGps.stops[0].fee_eur >= withoutGps.stops[0].fee_eur);
  assert.equal(withGps.summary.gps_used_count, 1);
});

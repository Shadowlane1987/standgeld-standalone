"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  WINDOW_SOURCE,
  stopLocalDate,
  resolveWindowStart,
  computeStopBilling,
  parseRangeBoundary,
  dateInRange,
  runBilling,
} = require("../normalize/billing");
const { buildWindowIndex } = require("../normalize/zeitfenster");

function excelIndexFor(ladenummer, { ladezeit_start, entladezeit_start }) {
  return buildWindowIndex([
    Object.freeze({ ladenummer, ladezeit_start, entladezeit_start }),
  ]);
}

// Ladestopp Berlin: Ankunft/Abfahrt lokal, Fenster 06:00.
function loadingStop(overrides = {}) {
  return {
    transport_number: "4B_20260726_0006622395",
    delivery_number: "D1",
    stop_type: "LOADING",
    timezone: "Europe/Berlin",
    arrival_local: "2026-07-16 06:00",
    departure_local: "2026-07-16 08:30",
    arrival_time: "2026-07-16T04:00:00.000Z", // 06:00 Berlin (CEST +2)
    departure_time: "2026-07-16T06:30:00.000Z", // 08:30 Berlin
    needs_review: false,
    ...overrides,
  };
}

test("parseRangeBoundary: verschiedene Formate", () => {
  assert.equal(parseRangeBoundary("2026-07-13"), "2026-07-13");
  assert.equal(parseRangeBoundary("13.07.2026"), "2026-07-13");
  assert.equal(parseRangeBoundary("13.07.", { year: 2026 }), "2026-07-13");
  assert.equal(parseRangeBoundary("3.7.", { year: 2026 }), "2026-07-03");
  assert.equal(parseRangeBoundary("", { year: 2026 }), null);
  assert.equal(parseRangeBoundary(null), null);
});

test("dateInRange: inklusiv, offene Grenzen", () => {
  assert.equal(dateInRange("2026-07-14", "2026-07-13", "2026-07-16"), true);
  assert.equal(dateInRange("2026-07-13", "2026-07-13", "2026-07-16"), true);
  assert.equal(dateInRange("2026-07-16", "2026-07-13", "2026-07-16"), true);
  assert.equal(dateInRange("2026-07-12", "2026-07-13", "2026-07-16"), false);
  assert.equal(dateInRange("2026-07-17", "2026-07-13", "2026-07-16"), false);
  assert.equal(dateInRange("2026-07-17", null, null), true);
  assert.equal(dateInRange(null, "2026-07-13", null), false);
});

test("stopLocalDate: aus lokaler Wanduhr", () => {
  assert.equal(stopLocalDate(loadingStop()), "2026-07-16");
});

test("stopLocalDate: Fallback aus UTC + Zeitzone", () => {
  const stop = loadingStop({ arrival_local: null, departure_local: null });
  assert.equal(stopLocalDate(stop), "2026-07-16");
});

test("resolveWindowStart: Transporeon hat Vorrang", () => {
  const excelIndex = excelIndexFor("6622395", {
    ladezeit_start: "05:00",
    entladezeit_start: null,
  });
  const transporeonWindows = new Map([
    ["4B_20260726_0006622395|LOADING", "06:00"],
  ]);
  const win = resolveWindowStart(loadingStop(), {
    excelIndex,
    transporeonWindows,
  });
  assert.equal(win.window_source, WINDOW_SOURCE.TRANSPOREON);
  assert.equal(win.window_local, "2026-07-16 06:00");
  assert.equal(win.window_start, "2026-07-16T04:00:00.000Z");
});

test("resolveWindowStart: Excel-Fallback wenn kein Transporeon-Fenster", () => {
  const excelIndex = excelIndexFor("6622395", {
    ladezeit_start: "06:00",
    entladezeit_start: null,
  });
  const win = resolveWindowStart(loadingStop(), { excelIndex });
  assert.equal(win.window_source, WINDOW_SOURCE.EXCEL);
  assert.equal(win.window_start, "2026-07-16T04:00:00.000Z");
});

test("resolveWindowStart: keine Quelle -> NONE", () => {
  const win = resolveWindowStart(loadingStop(), { excelIndex: new Map() });
  assert.equal(win.window_source, WINDOW_SOURCE.NONE);
  assert.equal(win.window_start, null);
});

test("resolveWindowStart: Fenster mit vollem Datum (Export) -> direkt, Uebernacht korrekt", () => {
  // Entladestopp: Ankunft am 16.07 abends, Fenster erst am 17.07 07:00 (Uebernacht).
  const stop = {
    transport_number: "B2_20260717_0006647418",
    stop_type: "UNLOADING",
    timezone: "Europe/Berlin",
    arrival_local: "2026-07-16 18:02",
    departure_local: "2026-07-17 06:54",
    arrival_time: "2026-07-16T16:02:00.000Z",
    departure_time: "2026-07-17T04:54:00.000Z",
  };
  const transporeonWindows = new Map([
    ["B2_20260717_0006647418|UNLOADING", "2026-07-17 07:00"],
  ]);
  const win = resolveWindowStart(stop, { transporeonWindows });
  assert.equal(win.window_source, WINDOW_SOURCE.TRANSPOREON);
  // Datum aus dem Fensterwert (17.07), NICHT aus dem Stopp-Datum (16.07).
  assert.equal(win.window_local, "2026-07-17 07:00");
  assert.equal(win.window_start, "2026-07-17T05:00:00.000Z");
});

test("computeStopBilling: Excel-Fenster -> Gebuehr 30 EUR bei 2h30", () => {
  const excelIndex = excelIndexFor("6622395", {
    ladezeit_start: "06:00",
    entladezeit_start: null,
  });
  const item = computeStopBilling(loadingStop(), { excelIndex });
  // 06:00 Fenster -> 08:30 Abfahrt = 150 min, 30 ueber Freizeit -> 1 Block.
  assert.equal(item.window_source, WINDOW_SOURCE.EXCEL);
  assert.equal(item.counted_standing_minutes, 150);
  assert.equal(item.fee_eur, 30);
});

test("runBilling: filtert nach Datumsbereich und summiert", () => {
  const excelIndex = buildWindowIndex([
    { ladenummer: "6622395", ladezeit_start: "06:00", entladezeit_start: null },
    { ladenummer: "6622559", ladezeit_start: "06:00", entladezeit_start: null },
  ]);

  const stops = [
    loadingStop(), // 16.07. -> im Bereich, 30 EUR
    loadingStop({
      transport_number: "4B_20260726_0006622559",
      arrival_local: "2026-07-12 06:00",
      departure_local: "2026-07-12 09:00",
      arrival_time: "2026-07-12T04:00:00.000Z",
      departure_time: "2026-07-12T07:00:00.000Z",
    }), // 12.07. -> ausserhalb
  ];

  const result = runBilling({
    stops,
    excelIndex,
    range: { from: "13.07.", to: "16.07.", year: 2026 },
  });

  assert.equal(result.range.from, "2026-07-13");
  assert.equal(result.range.to, "2026-07-16");
  assert.equal(result.summary.stop_count, 2);
  assert.equal(result.summary.selected_count, 1);
  assert.equal(result.summary.chargeable_count, 1);
  assert.equal(result.summary.total_fee_eur, 30);
  assert.equal(result.selected[0].transport_number, "4B_20260726_0006622395");
});

test("runBilling: ohne Bereich werden alle Stopps abgerechnet", () => {
  const excelIndex = excelIndexFor("6622395", {
    ladezeit_start: "06:00",
    entladezeit_start: null,
  });
  const result = runBilling({ stops: [loadingStop()], excelIndex });
  assert.equal(result.summary.selected_count, 1);
  assert.equal(result.summary.total_fee_eur, 30);
});

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  extractFirstTime,
  parseWindowRows,
  buildWindowIndex,
  windowStartForStop,
  normalizeLadenummer,
} = require("../normalize/zeitfenster");

test("extractFirstTime: einfache Uhrzeiten", () => {
  assert.equal(extractFirstTime("11:00"), "11:00");
  assert.equal(extractFirstTime("6:00"), "06:00");
  assert.equal(extractFirstTime("0:00"), "00:00");
});

test("extractFirstTime: Punkt/Semikolon als Trenner", () => {
  assert.equal(extractFirstTime("12.00"), "12:00");
  assert.equal(extractFirstTime("15.30"), "15:30");
  assert.equal(extractFirstTime("06;30"), "06:30");
});

test("extractFirstTime: Sekunden werden ignoriert", () => {
  assert.equal(extractFirstTime("04:00:00 Fr."), "04:00");
  assert.equal(extractFirstTime("16:00:00"), "16:00");
});

test("extractFirstTime: Bereiche -> erste Zeit", () => {
  assert.equal(extractFirstTime("04:00-11:00"), "04:00");
  assert.equal(extractFirstTime("19:00-19:30"), "19:00");
  assert.equal(extractFirstTime("11:45-12:15"), "11:45");
  assert.equal(extractFirstTime("20-20:30"), "20:00");
  assert.equal(extractFirstTime("08:00- 10:00"), "08:00");
});

test("extractFirstTime: bloße Stunde + Uhr -> HH:00", () => {
  assert.equal(extractFirstTime("08-14 Uhr"), "08:00");
  assert.equal(extractFirstTime("5 Uhr Mo LALI"), "05:00");
  assert.equal(extractFirstTime("06 uhr Mo LALI"), "06:00");
  assert.equal(extractFirstTime("13 Uhr LALI"), "13:00");
  assert.equal(extractFirstTime("05-06 uhr"), "05:00");
});

test("extractFirstTime: Datum davor wird ignoriert", () => {
  assert.equal(extractFirstTime("03.07. um 18:00"), "18:00");
  assert.equal(extractFirstTime("04:00/08.07."), "04:00");
  assert.equal(extractFirstTime("bis 14.00"), "14:00");
});

test("extractFirstTime: Labels ohne Zeit -> null", () => {
  assert.equal(extractFirstTime("Netto"), null);
  assert.equal(extractFirstTime("Aldi"), null);
  assert.equal(extractFirstTime("Ohne ZF"), null);
  assert.equal(extractFirstTime(":"), null);
  assert.equal(extractFirstTime(""), null);
});

test("extractFirstTime: SO-Präfix stört nicht", () => {
  assert.equal(extractFirstTime("SO 23:00"), "23:00");
});

test("normalizeLadenummer: nur echte Nummern, Banner raus", () => {
  assert.equal(normalizeLadenummer("6622395"), "6622395");
  assert.equal(normalizeLadenummer("0006622395"), "6622395");
  assert.equal(normalizeLadenummer("06.07."), null);
  assert.equal(normalizeLadenummer(""), null);
});

test("parseWindowRows: Kopf finden, Banner/Leerzeilen überspringen", () => {
  const rows = [
    [
      "Ladenummer",
      "Ladestelle",
      "Entladestelle",
      "Ladezeit",
      "Entladezeit ",
      "Entladenummer",
      "Tournummer",
      "LKW",
    ],
    ["06.07.", "", "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", ""],
    [
      "6622395",
      "Halle",
      "Germersheim XPO",
      "08-14 Uhr",
      "11:00",
      "",
      "",
      "Express",
    ],
    [
      "6622559",
      "Ludwigsfelde",
      "Rossau",
      "SO 23:00",
      "6:00",
      "1002013033",
      "",
      "Thiel",
    ],
    ["6625114", "Ludwigsfelde", "Stavenhagen", "11:00", "Netto", "", "", "ML"],
  ];

  const windows = parseWindowRows(rows);
  assert.equal(windows.length, 3);

  assert.deepEqual(
    {
      ladenummer: windows[0].ladenummer,
      ladezeit_start: windows[0].ladezeit_start,
      entladezeit_start: windows[0].entladezeit_start,
      entladestelle: windows[0].entladestelle,
    },
    {
      ladenummer: "6622395",
      ladezeit_start: "08:00",
      entladezeit_start: "11:00",
      entladestelle: "Germersheim XPO",
    },
  );

  // "Netto" hat keine Zeit -> Entladefenster null (Prueffall stromabwaerts).
  assert.equal(windows[2].entladezeit_start, null);
  assert.equal(windows[2].entladezeit_raw, "Netto");
});

test("buildWindowIndex + windowStartForStop", () => {
  const rows = [
    [
      "Ladenummer",
      "Ladestelle",
      "Entladestelle",
      "Ladezeit",
      "Entladezeit",
      "Entladenummer",
    ],
    ["6622395", "Halle", "Germersheim XPO", "08-14 Uhr", "11:00", ""],
  ];
  const index = buildWindowIndex(parseWindowRows(rows));
  const win = index.get("6622395");

  assert.equal(windowStartForStop(win, "LOADING"), "08:00");
  assert.equal(windowStartForStop(win, "UNLOADING"), "11:00");
  assert.equal(windowStartForStop(win, "OTHER"), null);
  assert.equal(windowStartForStop(undefined, "LOADING"), null);
});

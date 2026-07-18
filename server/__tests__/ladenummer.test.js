"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  transportNumberToLadenummer,
  matchesLadenummer,
} = require("../normalize/ladenummer");

test("letzte 7 Ziffern aus realer Transportnummer", () => {
  assert.equal(
    transportNumberToLadenummer("4B_20260726_0006622395"),
    "6622395",
  );
});

test("weitere reale Transportnummer", () => {
  assert.equal(
    transportNumberToLadenummer("B2_20260720_0006645178"),
    "6645178",
  );
});

test("Datumsblock im Segment stoert nicht (nur letztes Segment zaehlt)", () => {
  assert.equal(
    transportNumberToLadenummer("3D_20260715_0006639797"),
    "6639797",
  );
});

test("leere/ungueltige Eingabe -> null", () => {
  assert.equal(transportNumberToLadenummer(""), null);
  assert.equal(transportNumberToLadenummer(null), null);
  assert.equal(transportNumberToLadenummer("KEINE_ZIFFERN"), null);
});

test("matchesLadenummer bei numerischer Excel-Ladenummer", () => {
  assert.equal(matchesLadenummer("4B_20260726_0006622395", 6622395), true);
  assert.equal(matchesLadenummer("4B_20260726_0006622395", "6622395"), true);
});

test("matchesLadenummer schlaegt bei falscher Nummer fehl", () => {
  assert.equal(matchesLadenummer("4B_20260726_0006622395", 6622559), false);
});

test("matchesLadenummer ignoriert fuehrende Nullen der Cola-Nummer", () => {
  assert.equal(matchesLadenummer("4B_20260726_0006622395", "06622395"), true);
});

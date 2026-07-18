"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  unescapeGwtString,
  parseTransportList,
} = require("../normalize/gwtTransportList");

test("unescapeGwtString entschaerft \\xNN und \\/", () => {
  assert.equal(unescapeGwtString("A \\x26 B"), "A & B");
  assert.equal(unescapeGwtString("a\\/b"), "a/b");
});

test("parseTransportList mappt Transportnummer -> transportId (Gap-Logik)", () => {
  // Zwei Zeilen. GWT liest rueckwaerts: Zeile A (hoechste Indizes) zuerst.
  // Vorwaerts (aufsteigender Index): tid_B, TN_B(ref2), tid_A, TN_A(ref1).
  const fixture =
    "//OK['3WkKq',2,'3WkKs',1," +
    '["AA_20260101_0000000001","BB_20260101_0000000002"],0,7]';

  const rows = parseTransportList(fixture);
  const byTn = Object.fromEntries(rows.map((r) => [r.transportNumber, r]));

  assert.equal(rows.length, 2);
  assert.equal(byTn["AA_20260101_0000000001"].transportIdB64, "3WkKs");
  assert.equal(byTn["AA_20260101_0000000001"].transportId, "928662188");
  assert.equal(byTn["BB_20260101_0000000002"].transportIdB64, "3WkKq");
  assert.equal(byTn["BB_20260101_0000000002"].transportId, "928662186");
});

test("parseTransportList: nur die naechste Long unterhalb der Nummer zaehlt", () => {
  // Zeile A hat ZWEI Longs in ihrer Luecke; die transportId ist die mit dem
  // hoechsten Index (direkt unter der Transportnummer): '3WkKs'.
  const fixture = "//OK['3R774','3WkKs',1," + '["AA_20260101_0000000001"],0,7]';
  const rows = parseTransportList(fixture);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].transportIdB64, "3WkKs");
});

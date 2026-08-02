"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { looksLikeRealPlate } = require("../normalize/exportBilling");

test("echte Kennzeichen werden als echt erkannt", () => {
  assert.equal(looksLikeRealPlate("B-XY 1234"), true);
  assert.equal(looksLikeRealPlate("HH AB 123"), true);
  assert.equal(looksLikeRealPlate("M-AB1234"), true);
  assert.equal(looksLikeRealPlate("GD 12345"), true); // auslaendisches Kennzeichen
  assert.equal(looksLikeRealPlate("WGM4567"), true);
});

test("Fake-Kennzeichen (Handynummer) werden als Fake erkannt", () => {
  assert.equal(looksLikeRealPlate("015112345678"), false);
  assert.equal(looksLikeRealPlate("0151 1234 5678"), false);
  assert.equal(looksLikeRealPlate("+4915112345678"), false);
  assert.equal(looksLikeRealPlate("0176-12345678"), false);
  assert.equal(looksLikeRealPlate("00491511234567"), false);
});

test("leere oder unbrauchbare Werte sind kein echtes Kennzeichen", () => {
  assert.equal(looksLikeRealPlate(""), false);
  assert.equal(looksLikeRealPlate(null), false);
  assert.equal(looksLikeRealPlate(undefined), false);
  assert.equal(looksLikeRealPlate("AB"), false); // keine Ziffer
  assert.equal(looksLikeRealPlate("A1"), false); // zu kurz
});

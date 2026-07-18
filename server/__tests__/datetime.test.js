"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  zoneOffsetMs,
  parseWallClock,
  hasExplicitOffset,
  isValidTimeZone,
  toUtcIso,
} = require("../normalize/datetime");

test("zoneOffsetMs: Europe/Berlin Sommer = +2h, Winter = +1h", () => {
  const summer = Date.UTC(2026, 6, 16, 0, 0, 0); // Juli
  const winter = Date.UTC(2026, 0, 15, 0, 0, 0); // Januar
  assert.equal(zoneOffsetMs(summer, "Europe/Berlin"), 2 * 3600 * 1000);
  assert.equal(zoneOffsetMs(winter, "Europe/Berlin"), 1 * 3600 * 1000);
});

test("parseWallClock akzeptiert Grid- und ISO-Trenner", () => {
  assert.deepEqual(parseWallClock("2026-07-16 09:30"), {
    y: 2026,
    mo: 7,
    d: 16,
    h: 9,
    mi: 30,
    s: 0,
  });
  assert.deepEqual(parseWallClock("2026-07-16T09:30:45"), {
    y: 2026,
    mo: 7,
    d: 16,
    h: 9,
    mi: 30,
    s: 45,
  });
  assert.equal(parseWallClock("keine zeit"), null);
});

test("hasExplicitOffset erkennt Z und numerische Offsets", () => {
  assert.equal(hasExplicitOffset("2026-07-16T07:30:00.000Z"), true);
  assert.equal(hasExplicitOffset("2026-07-16T09:30:00+02:00"), true);
  assert.equal(hasExplicitOffset("2026-07-16 09:30"), false);
});

test("isValidTimeZone", () => {
  assert.equal(isValidTimeZone("Europe/Berlin"), true);
  assert.equal(isValidTimeZone("Etc/UTC"), true);
  assert.equal(isValidTimeZone("Nicht/Existiert"), false);
  assert.equal(isValidTimeZone(null), false);
});

test("toUtcIso: Wanduhrzeit + Zeitzone -> korrektes UTC (Sommer)", () => {
  assert.equal(
    toUtcIso("2026-07-16 09:30", "Europe/Berlin"),
    "2026-07-16T07:30:00.000Z",
  );
  assert.equal(
    toUtcIso("2026-07-16 12:05", "Europe/Amsterdam"),
    "2026-07-16T10:05:00.000Z",
  );
  assert.equal(
    toUtcIso("2026-07-16 07:30", "Etc/UTC"),
    "2026-07-16T07:30:00.000Z",
  );
});

test("toUtcIso: Winterzeit korrekt (CET +1)", () => {
  assert.equal(
    toUtcIso("2026-01-15 09:30", "Europe/Berlin"),
    "2026-01-15T08:30:00.000Z",
  );
});

test("toUtcIso: ohne Zeitzone deterministisch als UTC (keine Maschinen-TZ)", () => {
  assert.equal(toUtcIso("2026-07-16 09:30", null), "2026-07-16T09:30:00.000Z");
  assert.equal(
    toUtcIso("2026-07-16 09:30", "Nicht/Existiert"),
    "2026-07-16T09:30:00.000Z",
  );
});

test("toUtcIso: epoch-Zahl und expliziter Offset unveraendert", () => {
  assert.equal(toUtcIso(1784037780000), new Date(1784037780000).toISOString());
  assert.equal(
    toUtcIso("2026-07-16T07:30:00.000Z", "Europe/Berlin"),
    "2026-07-16T07:30:00.000Z",
  );
});

test("toUtcIso: leer/ungueltig -> null", () => {
  assert.equal(toUtcIso("", "Europe/Berlin"), null);
  assert.equal(toUtcIso(null), null);
  assert.equal(toUtcIso("kaese"), null);
});

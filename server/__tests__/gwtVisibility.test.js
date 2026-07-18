"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  decodeLongBE,
  parseVisibilityResponse,
  mapStatus,
} = require("../normalize/gwtVisibility");

const SAMPLE = fs.readFileSync(
  path.join(__dirname, "..", "..", "data", "captures", "visibility_sample.txt"),
  "utf8",
);

test("decodeLongBE dekodiert Big-Endian GWT-Long", () => {
  // 'Z9wOi5o' -> 1784294289000 (verifiziert in Session)
  assert.equal(decodeLongBE("Z9wOi5o"), 1784294289000);
});

test("mapStatus laesst status.* durch und mappt ProcessKind", () => {
  assert.equal(mapStatus("status.loading.arrival"), "status.loading.arrival");
  assert.equal(mapStatus("loadingDeparture"), "status.loading.departure");
  assert.equal(mapStatus("unloadingArrival"), "status.unloading.arrival");
  assert.equal(mapStatus(null), null);
});

test("parseVisibilityResponse liefert 10 Events in korrekter Reihenfolge", () => {
  const events = parseVisibilityResponse(SAMPLE, {
    transportNumber: "B2_20260717_0006647418",
  });
  assert.equal(events.length, 10);

  const expected = [
    ["status.unloading.departure", "VISIBILITY"],
    ["status.unloading.arrival", "VISIBILITY"],
    ["status.headingtowards.unloadingstation", "VISIBILITY"],
    ["status.loading.departure", "VISIBILITY"],
    ["status.loading.arrival", "VISIBILITY"],
    ["status.headingtowards.loadingstation", "VISIBILITY"],
    ["status.locating.end", "VISIBILITY"],
    ["status.locating.begin", "VISIBILITY"],
    ["status.loading.departure", "TP_XP"],
    ["status.loading.arrival", "TP_XP"],
  ];

  events.forEach((ev, i) => {
    assert.equal(ev.status_qualifier, expected[i][0], `status[${i}]`);
    assert.equal(ev.source_type, expected[i][1], `source[${i}]`);
    assert.equal(ev.transport_number, "B2_20260717_0006647418");
    assert.ok(ev.event_time, `event_time[${i}] gesetzt`);
  });
});

test("parseVisibilityResponse: 0/0-Koordinaten sind nicht GPS-verifiziert", () => {
  const events = parseVisibilityResponse(SAMPLE, {
    transportNumber: "B2_20260717_0006647418",
  });
  for (const ev of events) {
    assert.equal(ev.gps_verified, false);
  }
});

test("parseVisibilityResponse: Lieferungsnummer wird erkannt", () => {
  const events = parseVisibilityResponse(SAMPLE, {});
  // Mindestens ein VisibilityHub-Event traegt die Lieferungsnummer 0346191296.
  assert.ok(events.some((e) => e.delivery_number === "0346191296"));
});

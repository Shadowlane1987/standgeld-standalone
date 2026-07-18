"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  localTimeInZone,
  bookingsToWindowMap,
} = require("../normalize/transporeonWindows");

test("localTimeInZone: UTC -> lokale Startzeit", () => {
  // 04:00Z = 06:00 in Berlin (Sommerzeit).
  assert.equal(
    localTimeInZone("2026-07-16T04:00:00.000Z", "Europe/Berlin"),
    "06:00",
  );
  // Ohne gueltige Zone -> UTC.
  assert.equal(localTimeInZone("2026-07-16T04:00:00.000Z", null), "04:00");
  assert.equal(localTimeInZone("kaputt", "Europe/Berlin"), null);
});

test("bookingsToWindowMap: Ladefenster je Transport", () => {
  const bookings = [
    {
      transport_number: "4B_20260726_0006622395",
      window_from_iso: "2026-07-16T04:00:00.000Z",
      location_timezone: "Europe/Berlin",
    },
    {
      transport_number: "B2_20260720_0006645178",
      window_from_iso: "2026-07-20T05:30:00.000Z",
      location_timezone: "Europe/Berlin",
    },
  ];

  const map = bookingsToWindowMap(bookings);
  assert.equal(map.get("4B_20260726_0006622395|LOADING"), "06:00");
  assert.equal(map.get("B2_20260720_0006645178|LOADING"), "07:30");
});

test("bookingsToWindowMap: erste Buchung je Transport gewinnt, ungueltige ignoriert", () => {
  const bookings = [
    {
      transport_number: "T1",
      window_from_iso: "2026-07-16T04:00:00.000Z",
      location_timezone: "Europe/Berlin",
    },
    {
      transport_number: "T1",
      window_from_iso: "2026-07-16T06:00:00.000Z",
      location_timezone: "Europe/Berlin",
    },
    { transport_number: null, window_from_iso: "2026-07-16T04:00:00.000Z" },
    { transport_number: "T2", window_from_iso: null },
  ];

  const map = bookingsToWindowMap(bookings);
  assert.equal(map.get("T1|LOADING"), "06:00");
  assert.equal(map.has("T2|LOADING"), false);
  assert.equal(map.size, 1);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseDotNetDate,
  normalizeBooking,
  parseBookingsResponse,
} = require("../normalize/bookings");

// Anonymisiertes Fixture nach dem VERIFIZIERTEN Format aus der echten HAR.
// Keine echten personenbezogenen Daten.
const FIXTURE = {
  Status: 0,
  Bookings: [
    {
      TourId: "900000001",
      TourNumber: "01_20260720_0000000001",
      TransportNumber: "",
      Id: "1600000001",
      OpenBookingId: "300000001",
      LocationId: "111111050",
      GateId: "111111694",
      LongitudeForExport: null,
      LatitudeForExport: null,
      TimezoneForExport: null,
      From: "/Date(1784268000000+0200)/",
      StrFrom: "2026-07-17 08:00:00",
      To: "/Date(1784268900000+0200)/",
      StrTo: "2026-07-17 08:15:00",
      VehicleLicencePlate: "",
      VehicleDriverName: "",
      IsCompleted: false,
      BookingExtension: {
        BookingExtensionEntries: [
          { Key: "SapCode", Value: "0300000001" },
          { Key: "OrderNumber", Value: "2000000001" },
          { Key: "Consignee", Value: "00000-TESTORT-TEST MARKT" },
          { Key: "Weight", Value: "20000.0" },
          { Key: "Comment", Value: "Testkommentar" },
          { Key: "unloadingCity", Value: "Teststadt" },
          { Key: "TransportNumber", Value: "01_20260720_0000000001" },
        ],
      },
    },
  ],
};

test("parseDotNetDate zerlegt das .NET-Datumsformat", () => {
  const r = parseDotNetDate("/Date(1784268000000+0200)/");
  assert.equal(r.epochMs, 1784268000000);
  assert.equal(r.offsetMinutes, 120);
  assert.equal(r.iso, new Date(1784268000000).toISOString());
});

test("parseDotNetDate: negativer Offset und ungueltige Eingabe", () => {
  assert.equal(parseDotNetDate("kein datum"), null);
  const neg = parseDotNetDate("/Date(1000000000000-0530)/");
  assert.equal(neg.offsetMinutes, -(5 * 60 + 30));
});

test("normalizeBooking extrahiert die Kernfelder", () => {
  const b = normalizeBooking(FIXTURE.Bookings[0]);
  assert.equal(b.tour_id, "900000001");
  assert.equal(b.tour_number, "01_20260720_0000000001");
  // TransportNumber top-level leer -> Fallback auf Extension bzw. TourNumber.
  assert.equal(b.transport_number, "01_20260720_0000000001");
  assert.equal(b.window_from_local, "2026-07-17 08:00:00");
  assert.equal(b.window_to_local, "2026-07-17 08:15:00");
  assert.equal(b.window_offset_minutes, 120);
  assert.equal(b.location_id, "111111050");
  assert.equal(b.gate_id, "111111694");
  assert.equal(b.is_completed, false);
});

test("normalizeBooking waehlt Lieferungsnummer nach Prioritaet", () => {
  const b = normalizeBooking(FIXTURE.Bookings[0]);
  assert.equal(b.delivery_number, "0300000001"); // SapCode
  assert.equal(b.order_number, "2000000001");
  assert.equal(b.consignee, "00000-TESTORT-TEST MARKT");
  assert.equal(b.weight, "20000.0");
  assert.equal(b.unloading_city, "Teststadt");
});

test("normalizeBooking bevorzugt sapDeliveryNumber vor SapCode", () => {
  const booking = {
    ...FIXTURE.Bookings[0],
    BookingExtension: {
      BookingExtensionEntries: [
        { Key: "SapCode", Value: "0300000001" },
        { Key: "sapDeliveryNumber", Value: "0399999999" },
      ],
    },
  };
  const b = normalizeBooking(booking);
  assert.equal(b.delivery_number, "0399999999");
});

test("normalizeBooking liefert eingefrorenes Objekt", () => {
  const b = normalizeBooking(FIXTURE.Bookings[0]);
  assert.ok(Object.isFrozen(b));
});

test("parseBookingsResponse akzeptiert Objekt und JSON-String", () => {
  const fromObject = parseBookingsResponse(FIXTURE);
  assert.equal(fromObject.status, 0);
  assert.equal(fromObject.bookings.length, 1);

  const fromString = parseBookingsResponse(JSON.stringify(FIXTURE));
  assert.equal(fromString.bookings.length, 1);
  assert.equal(fromString.bookings[0].delivery_number, "0300000001");
});

test("parseBookingsResponse: ungueltiger String -> leeres Ergebnis", () => {
  const r = parseBookingsResponse("kein json");
  assert.equal(r.bookings.length, 0);
  assert.equal(r.status, null);
});

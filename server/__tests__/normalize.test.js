"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyCoordinates,
  classifyCoordinatePair,
} = require("../normalize/coordinates");
const {
  classifySource,
  categorizeStatusQualifier,
  normalizeEventRow,
  SOURCE_TYPE,
  EVENT_CATEGORY,
} = require("../normalize/events");
const { extractTislotData, tislotToEvents } = require("../normalize/tislot");

// ---------------------------------------------------------------------------
// §10 GPS 0/0-Erkennung
// ---------------------------------------------------------------------------
test("classifyCoordinates: echtes GPS wird verifiziert", () => {
  const r = classifyCoordinates("53.603035 10.697445");
  assert.equal(r.verified, true);
  assert.equal(r.reason, "valid_gps");
  assert.ok(Math.abs(r.lat - 53.603035) < 1e-9);
  assert.ok(Math.abs(r.lon - 10.697445) < 1e-9);
});

test("classifyCoordinates: verschiedene 0/0-Schreibweisen sind nicht verifiziert", () => {
  for (const raw of ["0 0", "0,0", "0.000000 / 0.000000", "0/0", "0.0;0.0"]) {
    const r = classifyCoordinates(raw);
    assert.equal(r.verified, false, `sollte nicht verifiziert sein: ${raw}`);
    assert.equal(r.reason, "zero_zero", `Grund fuer ${raw}`);
  }
});

test("classifyCoordinates: leer/null/ungueltig ist nicht verifiziert", () => {
  for (const raw of ["", "   ", null, undefined, "abc", "-"]) {
    const r = classifyCoordinates(raw);
    assert.equal(r.verified, false);
  }
});

test("classifyCoordinates: ausserhalb des Bereichs ist nicht verifiziert", () => {
  const r = classifyCoordinatePair(999, 10);
  assert.equal(r.verified, false);
  assert.equal(r.reason, "out_of_range");
});

test("classifyCoordinates: deutsches Dezimalkomma pro Wert", () => {
  const r = classifyCoordinatePair("52,262216", "13,573271");
  assert.equal(r.verified, true);
});

// ---------------------------------------------------------------------------
// §8 Quellen- und Statusklassifikation
// ---------------------------------------------------------------------------
test("classifySource erkennt die fachlichen Quellen", () => {
  assert.equal(
    classifySource("VisibilityHubUser VisibilityHubUser"),
    SOURCE_TYPE.VISIBILITY,
  );
  assert.equal(classifySource("TP XP Service Account"), SOURCE_TYPE.TP_XP);
  assert.equal(
    classifySource("TRANSPOREON Service Account Support"),
    SOURCE_TYPE.SYSTEM,
  );
  assert.equal(classifySource("235474 TRANSPOREON"), SOURCE_TYPE.SYSTEM);
  assert.equal(classifySource(""), SOURCE_TYPE.OTHER);
});

test("categorizeStatusQualifier bildet Qualifier auf Kategorien ab", () => {
  const cases = [
    ["status.locating.begin", EVENT_CATEGORY.LOCATING],
    ["status.locating.end", EVENT_CATEGORY.LOCATING],
    ["status.headingtowards.loadingstation", EVENT_CATEGORY.TRANSIT],
    ["status.loading.arrival", EVENT_CATEGORY.LOAD_ARRIVAL],
    ["status.loading.departure", EVENT_CATEGORY.LOAD_DEPARTURE],
    ["dispatch.status.loading.begin", EVENT_CATEGORY.LOAD],
    ["status.unloading.arrival", EVENT_CATEGORY.UNLOAD_ARRIVAL],
    ["status.unloading.departure", EVENT_CATEGORY.UNLOAD_DEPARTURE],
    ["status.warning", EVENT_CATEGORY.WARNING],
    ["status.delay.expected.unloadingstation", EVENT_CATEGORY.DELAY],
    ["dispatch.status.arrival", EVENT_CATEGORY.LOAD_ARRIVAL],
    ["dispatch.status.departure", EVENT_CATEGORY.LOAD_DEPARTURE],
    ["irgendwas.unbekannt", EVENT_CATEGORY.OTHER],
  ];
  for (const [q, expected] of cases) {
    assert.equal(categorizeStatusQualifier(q), expected, q);
  }
});

// ---------------------------------------------------------------------------
// §10/§11 Normalisierung: manuelle Visibility (0/0) niemals als GPS verifiziert
// ---------------------------------------------------------------------------
test("normalizeEventRow: VisibilityHubUser mit 0/0 ist NICHT verifiziert", () => {
  const event = normalizeEventRow({
    transport_number: "3D_20260715_0006639797",
    source: "VisibilityHubUser VisibilityHubUser",
    status_qualifier: "status.unloading.departure",
    coordinates: "0 0",
    event_time: 1784037780000,
  });
  assert.equal(event.source_type, SOURCE_TYPE.VISIBILITY);
  assert.equal(event.gps_verified, false);
  assert.equal(event.gps_reason, "zero_zero");
  assert.equal(event.event_category, EVENT_CATEGORY.UNLOAD_DEPARTURE);
});

test("normalizeEventRow: VisibilityHubUser mit echtem GPS ist verifiziert", () => {
  const event = normalizeEventRow({
    source: "VisibilityHubUser VisibilityHubUser",
    status_qualifier: "status.loading.arrival",
    coordinates: "49.066596 8.372236",
  });
  assert.equal(event.gps_verified, true);
  assert.equal(event.gps_reason, "valid_gps");
});

test("normalizeEventRow: TP XP wird nie als GPS-verifiziert markiert", () => {
  const event = normalizeEventRow({
    source: "TP XP Service Account",
    status_qualifier: "dispatch.status.arrival",
    coordinates: "49.066596 8.372236",
  });
  assert.equal(event.source_type, SOURCE_TYPE.TP_XP);
  assert.equal(event.gps_verified, false);
});

test("normalizeEventRow: Rohwert bleibt erhalten (§7)", () => {
  const raw = { foo: "bar" };
  const event = normalizeEventRow({ raw, source: "x" });
  assert.deepEqual(event.raw, raw);
  assert.ok(Object.isFrozen(event));
});

// ---------------------------------------------------------------------------
// §8.1 TP-XP-Extraktion aus dem dispatch-Response (anonymisiertes Fixture)
// ---------------------------------------------------------------------------
// Nachbildung der Struktur aus dem echten Response, mit maskierten \"-Quotes
// und ausschliesslich anonymisierten Werten (kein echter Fahrer/Kennzeichen).
const ESCAPED_DISPATCH_FIXTURE =
  "...irrelevanter GWT-Vorlauf...," +
  '{\\"transportId\\":928019721,\\"bookings\\":[{' +
  '\\"customerId\\":235474,\\"carrierId\\":274313,' +
  '\\"bookingStatusQualifiers\\":{' +
  '\\"dispatch.status.arrival\\":1784028000000,' +
  '\\"dispatch.status.loading.begin\\":1784033640000,' +
  '\\"dispatch.status.loading.end\\":1784035860000,' +
  '\\"dispatch.status.departure\\":1784037780000,' +
  '\\"dispatch.status.custom.allocation\\":946681200000},' +
  '\\"deliveryInfos\\":[{\\"id\\":607815963,\\"number\\":null}],' +
  '\\"driver\\":{\\"licensePlateNumber\\":\\"XX-YZ1234\\"},' +
  '\\"arrivalDate\\":1784028000000,\\"departureDate\\":1784037780000,' +
  '\\"bookingId\\":1651808653}]}' +
  ",...irrelevanter GWT-Nachlauf...";

test("extractTislotData liest das eingebettete JSON", () => {
  const tislot = extractTislotData(ESCAPED_DISPATCH_FIXTURE);
  assert.ok(tislot, "TislotDataDTO sollte gefunden werden");
  assert.equal(tislot.transportId, 928019721);
  assert.equal(tislot.bookings.length, 1);
  assert.equal(tislot.bookings[0].driver.licensePlateNumber, "XX-YZ1234");
});

test("extractTislotData: kein Marker => null", () => {
  assert.equal(extractTislotData("nichts hier"), null);
});

test("tislotToEvents erzeugt TP-XP-Events und filtert Platzhalter", () => {
  const tislot = extractTislotData(ESCAPED_DISPATCH_FIXTURE);
  const events = tislotToEvents(tislot, {
    transportNumber: "3D_20260715_0006639797",
    timezone: "Europe/Berlin",
    importRunId: "run-test",
    importedAt: "2026-07-17T00:00:00.000Z",
  });

  // 4 gueltige Qualifier (arrival, loading.begin, loading.end, departure);
  // der Platzhalter 946681200000 (custom.allocation) wird verworfen.
  assert.equal(events.length, 4);
  for (const event of events) {
    assert.equal(event.source_type, SOURCE_TYPE.TP_XP);
    assert.equal(event.transport_number, "3D_20260715_0006639797");
    assert.equal(event.timezone, "Europe/Berlin");
    assert.ok(event.event_time, "event_time gesetzt");
    assert.equal(event.gps_verified, false);
  }

  const departure = events.find(
    (e) => e.status_qualifier === "dispatch.status.departure",
  );
  assert.ok(departure);
  assert.equal(departure.event_time, new Date(1784037780000).toISOString());
});

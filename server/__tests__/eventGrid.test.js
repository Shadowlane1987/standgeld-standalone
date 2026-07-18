"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  STATUS_LABEL_TO_QUALIFIER,
  stripTags,
  extractTransportNumber,
  parseGridRows,
  gridRowToEventInput,
  parseEventGrid,
} = require("../normalize/eventGrid");

/**
 * Synthetische, PII-freie HTML-Vorlage, die die ECHTE GXT-Grid-Struktur des
 * Transporeon Event-Managements nachbildet (Klassen 1:1, Werte anonymisiert).
 */
function cell(colName, innerHtml) {
  return `<td cellindex="0" class="taKJE taAYC gxColumn-${colName}" style=""><div class="taMJE taBYC" style="">${innerHtml}</div></td>`;
}

function row(cells) {
  return `<tr class="taFKE taDYC taMK gxGridRow">${cells.join("")}</tr>`;
}

const VISIBILITY_SRC =
  '<a onclick="javascript:ta_showSchedulerDetailsWithSU(703287,0);">VisibilityHubUser VisibilityHubUser</a>';
const TPXP_SRC = "TP XP Service Account";

const FIXTURE_HTML = `
<div>Transportnr.: TESTNR_20260720_0000000001</div>
<table>
${row([
  cell("objectSubId", "0000000001"),
  cell("qualifier", "Beladen Ankunft"),
  cell("severity", '<span qtip="OK"><span class="taPXD">OK</span></span>'),
  cell("declaredDatetime", "2026-07-16 09:30"),
  cell("schedulerCreatedId", VISIBILITY_SRC),
  cell("companyCreatedId", "-"),
  cell("declaredDatetimeTimezone", "Europe/Berlin"),
  cell("comment", "status.automatically"),
  cell("datetimeCreated", "2026-07-17 10:13"),
  cell("identity", "0 0"),
])}
${row([
  cell("qualifier", "Beladen Ankunft"),
  cell("severity", '<span qtip="OK"><span class="taPXD">OK</span></span>'),
  cell("declaredDatetime", "2026-07-16 12:05"),
  cell("schedulerCreatedId", TPXP_SRC),
  cell("companyCreatedId", "Anon Verlader GmbH"),
  cell("declaredDatetimeTimezone", "Europe/Amsterdam"),
  cell("comment", "Automatically set"),
  cell("datetimeCreated", "2026-07-16 12:05"),
  cell("identity", "0 0"),
])}
${row([
  cell("objectSubId", "0000000002"),
  cell("qualifier", "Entladen Abfahrt"),
  cell("severity", '<span qtip="OK"><span class="taPXD">OK</span></span>'),
  cell("declaredDatetime", "2026-07-17 08:10"),
  cell("schedulerCreatedId", VISIBILITY_SRC),
  cell("companyCreatedId", "-"),
  cell("declaredDatetimeTimezone", "Europe/Berlin"),
  cell("comment", "status.automatically"),
  cell("datetimeCreated", "2026-07-17 10:14"),
  cell("identity", "52.520008 13.404954"),
])}
</table>
`;

test("STATUS_LABEL_TO_QUALIFIER deckt Belade-/Entlade-/Ortungs-Labels ab", () => {
  assert.equal(
    STATUS_LABEL_TO_QUALIFIER["beladen ankunft"],
    "status.loading.arrival",
  );
  assert.equal(
    STATUS_LABEL_TO_QUALIFIER["entladen abfahrt"],
    "status.unloading.departure",
  );
  assert.equal(
    STATUS_LABEL_TO_QUALIFIER["ortung beginn"],
    "status.locating.begin",
  );
});

test("stripTags entfernt Tags und normalisiert Whitespace", () => {
  assert.equal(stripTags("<a href='#'>Hallo   Welt</a>"), "Hallo Welt");
  assert.equal(stripTags("A&nbsp;B"), "A B");
});

test("extractTransportNumber liest die Kopfzeile", () => {
  assert.equal(
    extractTransportNumber(FIXTURE_HTML),
    "TESTNR_20260720_0000000001",
  );
  assert.equal(extractTransportNumber("<div>ohne</div>"), null);
});

test("parseGridRows liest alle Zeilen mit semantischen Zellen", () => {
  const rows = parseGridRows(FIXTURE_HTML);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].qualifier, "Beladen Ankunft");
  assert.equal(rows[0].declaredDatetimeTimezone, "Europe/Berlin");
  assert.equal(rows[0].identity, "0 0");
  // Scheduler-ID aus dem onclick extrahiert.
  assert.equal(rows[0].schedulerId, "703287");
  // TP-XP-Zeile hat keine Lieferungsnummer.
  assert.equal(rows[1].objectSubId, undefined);
});

test("gridRowToEventInput mappt Label -> status.*-Qualifier", () => {
  const rows = parseGridRows(FIXTURE_HTML);
  const input = gridRowToEventInput(rows[0], {
    transportNumber: "TESTNR_20260720_0000000001",
  });
  assert.equal(input.status_qualifier, "status.loading.arrival");
  assert.equal(input.delivery_number, "0000000001");
  assert.equal(input.transport_number, "TESTNR_20260720_0000000001");
  assert.equal(input.source, "VisibilityHubUser VisibilityHubUser");
});

test("parseEventGrid: VisibilityHubUser mit 0/0 -> nicht GPS-verifiziert (§10)", () => {
  const events = parseEventGrid(FIXTURE_HTML);
  const visZero = events[0];
  assert.equal(visZero.source_type, "VISIBILITY");
  assert.equal(visZero.event_category, "LOAD_ARRIVAL");
  assert.equal(visZero.gps_reason, "zero_zero");
  assert.equal(visZero.gps_verified, false);
  assert.equal(visZero.timezone, "Europe/Berlin");
});

test("parseEventGrid: TP XP Service Account korrekt klassifiziert", () => {
  const events = parseEventGrid(FIXTURE_HTML);
  const tpxp = events[1];
  assert.equal(tpxp.source_type, "TP_XP");
  assert.equal(tpxp.event_category, "LOAD_ARRIVAL");
  assert.equal(tpxp.timezone, "Europe/Amsterdam");
  // TP XP kann per Definition kein verifiziertes GPS liefern.
  assert.equal(tpxp.gps_verified, false);
  // §9: 12:05 Amsterdam (CEST) -> 10:05 UTC; lokale Rohzeit bleibt erhalten.
  assert.equal(tpxp.event_time, "2026-07-16T10:05:00.000Z");
  assert.equal(tpxp.event_time_local, "2026-07-16 12:05");
});

test("parseEventGrid: VisibilityHubUser mit echten Koordinaten -> verifiziert", () => {
  const events = parseEventGrid(FIXTURE_HTML);
  const visGps = events[2];
  assert.equal(visGps.source_type, "VISIBILITY");
  assert.equal(visGps.event_category, "UNLOAD_DEPARTURE");
  assert.equal(visGps.gps_verified, true);
  assert.equal(visGps.gps_reason, "valid_gps");
  assert.ok(Math.abs(visGps.lat - 52.520008) < 1e-6);
});

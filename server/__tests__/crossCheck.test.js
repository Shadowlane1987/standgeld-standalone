"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeEventRow } = require("../normalize/events");
const {
  CROSSCHECK_STATUS,
  diffMinutes,
  crossCheckEvents,
} = require("../normalize/crossCheck");

const REAL_GPS = "49.066596 8.372236";

function ev(overrides, orderIndex) {
  return normalizeEventRow(
    {
      transport_number: "T1",
      delivery_number: "D1",
      timezone: "Europe/Amsterdam",
      ...overrides,
    },
    { orderIndex },
  );
}

test("diffMinutes berechnet Minuten-Abstand robust", () => {
  assert.equal(
    diffMinutes("2026-07-16T10:05:00.000Z", "2026-07-16T07:35:00.000Z"),
    150,
  );
  assert.equal(diffMinutes(null, "2026-07-16T07:35:00.000Z"), null);
});

test("DISCREPANCY: belegte Visibility weicht von TP-XP ab -> Prueffall", () => {
  const events = [
    ev(
      {
        source: "TP XP Service Account",
        status_qualifier: "status.loading.arrival",
        event_time: "2026-07-16 12:05",
        coordinates: "0 0",
      },
      0,
    ),
    ev(
      {
        source: "VisibilityHubUser VisibilityHubUser",
        status_qualifier: "status.loading.arrival",
        event_time: "2026-07-16 09:30",
        timezone: "Europe/Berlin",
        coordinates: REAL_GPS,
      },
      1,
    ),
  ];
  const { phases, review_count } = crossCheckEvents(events);
  assert.equal(phases.length, 1);
  const p = phases[0];
  assert.equal(p.status, CROSSCHECK_STATUS.DISCREPANCY);
  assert.equal(p.needs_review, true);
  // 12:05 Amsterdam = 10:05Z, 09:30 Berlin = 07:30Z -> 155 min
  assert.equal(p.diff_minutes, 155);
  // GPS-belegte Zeit ist massgeblich.
  assert.equal(p.authoritative_source, "VISIBILITY");
  assert.equal(p.authoritative_time, "2026-07-16T07:30:00.000Z");
  assert.equal(review_count, 1);
});

test("NOT_PROVABLE: Visibility ohne echtes GPS -> nicht belegbar, TP-XP massgeblich", () => {
  const events = [
    ev(
      {
        source: "TP XP Service Account",
        status_qualifier: "status.loading.departure",
        event_time: "2026-07-16 13:15",
      },
      0,
    ),
    ev(
      {
        source: "VisibilityHubUser VisibilityHubUser",
        status_qualifier: "status.loading.departure",
        event_time: "2026-07-16 11:00",
        coordinates: "0 0",
      },
      1,
    ),
  ];
  const { phases } = crossCheckEvents(events);
  const p = phases[0];
  assert.equal(p.status, CROSSCHECK_STATUS.NOT_PROVABLE);
  assert.equal(p.visibility_gps_verified, false);
  assert.equal(p.needs_review, true);
  assert.equal(p.authoritative_source, "TP_XP");
});

test("MATCH: TP-XP und belegte Visibility stimmen ueberein", () => {
  const events = [
    ev(
      {
        source: "TP XP Service Account",
        status_qualifier: "status.unloading.arrival",
        event_time: "2026-07-16 12:05",
      },
      0,
    ),
    ev(
      {
        source: "VisibilityHubUser VisibilityHubUser",
        status_qualifier: "status.unloading.arrival",
        event_time: "2026-07-16 12:05",
        coordinates: REAL_GPS,
      },
      1,
    ),
  ];
  const { phases, review_count } = crossCheckEvents(events);
  const p = phases[0];
  assert.equal(p.status, CROSSCHECK_STATUS.MATCH);
  assert.equal(p.diff_minutes, 0);
  assert.equal(p.needs_review, false);
  assert.equal(p.authoritative_source, "VISIBILITY");
  assert.equal(review_count, 0);
});

test("MATCH mit Toleranz: kleine Abweichung innerhalb toleranceMinutes", () => {
  const events = [
    ev(
      {
        source: "TP XP Service Account",
        status_qualifier: "status.unloading.departure",
        event_time: "2026-07-16 12:05",
      },
      0,
    ),
    ev(
      {
        source: "VisibilityHubUser VisibilityHubUser",
        status_qualifier: "status.unloading.departure",
        event_time: "2026-07-16 12:08",
        coordinates: REAL_GPS,
      },
      1,
    ),
  ];
  const { phases } = crossCheckEvents(events, { toleranceMinutes: 5 });
  assert.equal(phases[0].status, CROSSCHECK_STATUS.MATCH);
  assert.equal(phases[0].diff_minutes, 3);
});

test("TP_XP_ONLY und VISIBILITY_ONLY korrekt", () => {
  const tpOnly = crossCheckEvents([
    ev(
      {
        source: "TP XP Service Account",
        status_qualifier: "status.loading.arrival",
        event_time: "2026-07-16 12:05",
      },
      0,
    ),
  ]);
  assert.equal(tpOnly.phases[0].status, CROSSCHECK_STATUS.TP_XP_ONLY);
  assert.equal(tpOnly.phases[0].needs_review, false);

  const visOnly = crossCheckEvents([
    ev(
      {
        source: "VisibilityHubUser VisibilityHubUser",
        status_qualifier: "status.loading.arrival",
        event_time: "2026-07-16 12:05",
        coordinates: REAL_GPS,
      },
      0,
    ),
  ]);
  assert.equal(visOnly.phases[0].status, CROSSCHECK_STATUS.VISIBILITY_ONLY);
  assert.equal(visOnly.phases[0].authoritative_source, "VISIBILITY");
});

test("Nicht-relevante Phasen (Ortung/Transit) werden ausgeschlossen", () => {
  const events = [
    ev(
      {
        source: "VisibilityHubUser VisibilityHubUser",
        status_qualifier: "status.locating.begin",
        event_time: "2026-07-16 07:30",
        coordinates: REAL_GPS,
      },
      0,
    ),
    ev(
      {
        source: "VisibilityHubUser VisibilityHubUser",
        status_qualifier: "status.headingtowards.loadingstation",
        event_time: "2026-07-16 09:00",
        coordinates: REAL_GPS,
      },
      1,
    ),
  ];
  const { phases } = crossCheckEvents(events);
  assert.equal(phases.length, 0);
});

test("summary zaehlt Status und review_count ueber mehrere Phasen", () => {
  const events = [
    ev(
      {
        delivery_number: "D1",
        source: "TP XP Service Account",
        status_qualifier: "status.loading.arrival",
        event_time: "2026-07-16 12:05",
      },
      0,
    ),
    ev(
      {
        delivery_number: "D1",
        source: "VisibilityHubUser VisibilityHubUser",
        status_qualifier: "status.loading.arrival",
        event_time: "2026-07-16 09:30",
        timezone: "Europe/Berlin",
        coordinates: REAL_GPS,
      },
      1,
    ),
    ev(
      {
        delivery_number: "D2",
        source: "TP XP Service Account",
        status_qualifier: "status.unloading.departure",
        event_time: "2026-07-16 18:00",
      },
      2,
    ),
  ];
  const { summary, review_count, phases } = crossCheckEvents(events);
  assert.equal(phases.length, 2);
  assert.equal(summary[CROSSCHECK_STATUS.DISCREPANCY], 1);
  assert.equal(summary[CROSSCHECK_STATUS.TP_XP_ONLY], 1);
  assert.equal(review_count, 1);
});

test("Abgleich nur ueber Transportnr.: unterschiedliche/fehlende Lieferungsnummer trennt nicht", () => {
  // Reales Muster: TP-XP-Zeile ohne Lieferungsnummer, VisibilityHubUser mit
  // gesetzter Nummer -- dieselbe Beladung. Muss EINE Phase ergeben.
  const events = [
    ev(
      {
        delivery_number: null,
        source: "TP XP Service Account",
        status_qualifier: "status.loading.arrival",
        event_time: "2026-07-17 10:50",
      },
      0,
    ),
    ev(
      {
        delivery_number: "0346191670",
        source: "VisibilityHubUser VisibilityHubUser",
        status_qualifier: "status.loading.arrival",
        event_time: "2026-07-17 10:50",
        coordinates: "0 0",
      },
      1,
    ),
  ];

  const { phases } = crossCheckEvents(events);
  assert.equal(phases.length, 1);
  // Visibility ohne echtes GPS -> nicht belegbar, TP-XP-Zeit ist massgeblich.
  assert.equal(phases[0].status, CROSSCHECK_STATUS.NOT_PROVABLE);
  assert.equal(phases[0].tp_xp_count, 1);
  assert.equal(phases[0].visibility_count, 1);
  assert.equal(phases[0].authoritative_source, "TP_XP");
  // Lieferungsnummer bleibt als Metadatum erhalten, trennt aber nicht.
  assert.equal(phases[0].delivery_number, "0346191670");
});

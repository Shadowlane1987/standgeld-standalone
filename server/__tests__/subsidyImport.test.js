"use strict";

const test = require("node:test");
const assert = require("node:assert");

const imp = require("../subsidies/subsidyImport");
const { STATUS, QUELLE, ZUSCHLAGSART } = require("../subsidies/subsidyModel");

function excelRow(overrides = {}) {
  return {
    "Transportnr.": "2M_20260813_0006690051",
    "Zuschlags-ID": "6817202",
    Name: "Standzeit",
    Preis: "120.50",
    "Zuschlag - Währung": "EUR",
    Beschreibung: "",
    Status: "Akzeptiert",
    "Begründung": "",
    Systemzeitstempel: "2026-08-14 15:04",
    ...overrides,
  };
}

test("mapExcelStatus erkennt nur eindeutige Begriffe", () => {
  assert.equal(imp.mapExcelStatus("Akzeptiert"), STATUS.AKZEPTIERT);
  assert.equal(imp.mapExcelStatus("abgelehnt"), STATUS.ABGELEHNT);
  assert.equal(imp.mapExcelStatus("in bearbeitung"), null);
  assert.equal(imp.mapExcelStatus(""), null);
});

test("parseRow wandelt eine gueltige Zeile in einen Kandidaten", () => {
  const res = imp.parseRow(excelRow());
  assert.equal(res.ok, true);
  assert.equal(res.candidate.zuschlags_id, "6817202");
  assert.equal(res.candidate.cola_nummer, "6690051");
  assert.equal(res.candidate.zuschlagsart, ZUSCHLAGSART.STANDGELD);
  assert.equal(res.candidate.betrag, 120.5);
  assert.equal(res.candidate.status, STATUS.AKZEPTIERT);
  assert.equal(res.candidate.entscheidungsdatum, "2026-08-14");
});

test("parseRow meldet Fehler bei fehlender ID, unbekanntem Status, falscher Waehrung", () => {
  const missingId = imp.parseRow(excelRow({ "Zuschlags-ID": "" }));
  assert.equal(missingId.ok, false);
  assert.ok(missingId.errors.some((e) => e.includes("Zuschlags-ID")));

  const badStatus = imp.parseRow(excelRow({ Status: "offen?" }));
  assert.equal(badStatus.ok, false);
  assert.ok(badStatus.errors.some((e) => e.includes("Status")));

  const badCurrency = imp.parseRow(excelRow({ "Zuschlag - Währung": "USD" }));
  assert.equal(badCurrency.ok, false);
  assert.ok(badCurrency.errors.some((e) => e.includes("EUR")));
});

test("matchCandidate trifft ueber gespeicherte Zuschlags-ID", () => {
  const candidate = imp.parseRow(excelRow()).candidate;
  const records = [
    { id: "a", zuschlags_id: "6817202", cola_nummer: "0000000", beantragte_summe: 999 },
  ];
  const m = imp.matchCandidate(candidate, records);
  assert.equal(m.matchedBy, "zuschlags_id");
  assert.equal(m.record.id, "a");
});

test("matchCandidate trifft ueber Cola+Art+Betrag bei nicht verknuepftem Satz", () => {
  const candidate = imp.parseRow(excelRow()).candidate;
  const records = [
    {
      id: "b",
      zuschlags_id: null,
      cola_nummer: "6690051",
      zuschlagsart: ZUSCHLAGSART.STANDGELD,
      beantragte_summe: 120.5,
    },
  ];
  const m = imp.matchCandidate(candidate, records);
  assert.equal(m.matchedBy, "cola_art_betrag");
  assert.equal(m.record.id, "b");
});

test("matchCandidate meldet mehrdeutig bei zwei gleichwertigen Saetzen", () => {
  const candidate = imp.parseRow(excelRow()).candidate;
  const base = {
    zuschlags_id: null,
    cola_nummer: "6690051",
    zuschlagsart: ZUSCHLAGSART.STANDGELD,
    beantragte_summe: 120.5,
  };
  const m = imp.matchCandidate(candidate, [
    { id: "b", ...base },
    { id: "c", ...base },
  ]);
  assert.equal(m.ambiguous, true);
  assert.equal(m.record, null);
});

test("matchCandidate ignoriert archivierte Saetze", () => {
  const candidate = imp.parseRow(excelRow()).candidate;
  const m = imp.matchCandidate(candidate, [
    { id: "a", zuschlags_id: "6817202", archiviert: true },
  ]);
  assert.equal(m.record, null);
});

test("planReconcile: kein Treffer -> no_match", () => {
  const candidate = imp.parseRow(excelRow()).candidate;
  const plan = imp.planReconcile(candidate, []);
  assert.equal(plan.action, "no_match");
});

test("planReconcile: akzeptiert setzt Status + genehmigte Summe = Preis", () => {
  const candidate = imp.parseRow(excelRow()).candidate;
  const records = [
    {
      id: "b",
      zuschlags_id: null,
      cola_nummer: "6690051",
      zuschlagsart: ZUSCHLAGSART.STANDGELD,
      beantragte_summe: 120.5,
      status: STATUS.UNBEKANNT,
    },
  ];
  const plan = imp.planReconcile(candidate, records, { now: "2026-08-16T00:00:00.000Z" });
  assert.equal(plan.action, "update");
  assert.equal(plan.recordId, "b");
  assert.equal(plan.changes.status, STATUS.AKZEPTIERT);
  assert.equal(plan.changes.genehmigte_summe, 120.5);
  assert.equal(plan.changes.zuschlags_id, "6817202");
  assert.equal(plan.changes.status_quelle, QUELLE.TRANSPOREON_EXCEL);
});

test("planReconcile: abgelehnt setzt genehmigte Summe = 0", () => {
  const candidate = imp.parseRow(excelRow({ Status: "Abgelehnt" })).candidate;
  const records = [
    {
      id: "b",
      zuschlags_id: null,
      cola_nummer: "6690051",
      zuschlagsart: ZUSCHLAGSART.STANDGELD,
      beantragte_summe: 120.5,
      status: STATUS.UNBEKANNT,
    },
  ];
  const plan = imp.planReconcile(candidate, records);
  assert.equal(plan.changes.status, STATUS.ABGELEHNT);
  assert.equal(plan.changes.genehmigte_summe, 0);
});

test("planReconcile: bereits abgeglichen -> noop", () => {
  const candidate = imp.parseRow(excelRow()).candidate;
  const records = [
    {
      id: "b",
      zuschlags_id: "6817202",
      cola_nummer: "6690051",
      zuschlagsart: ZUSCHLAGSART.STANDGELD,
      beantragte_summe: 120.5,
      genehmigte_summe: 120.5,
      status: STATUS.AKZEPTIERT,
      entscheidungsdatum: "2026-08-14",
    },
  ];
  const plan = imp.planReconcile(candidate, records);
  assert.equal(plan.action, "noop");
});

test("planReconcileAll verteilt zwei Kandidaten nicht auf denselben Satz", () => {
  const c1 = imp.parseRow(excelRow({ "Zuschlags-ID": "111" })).candidate;
  const c2 = imp.parseRow(excelRow({ "Zuschlags-ID": "222" })).candidate;
  const records = [
    {
      id: "b",
      zuschlags_id: null,
      cola_nummer: "6690051",
      zuschlagsart: ZUSCHLAGSART.STANDGELD,
      beantragte_summe: 120.5,
      status: STATUS.UNBEKANNT,
    },
  ];
  const plans = imp.planReconcileAll([c1, c2], records);
  assert.equal(plans[0].action, "update");
  assert.equal(plans[1].action, "no_match");
  const summary = imp.summarizePlans(plans);
  assert.equal(summary.update, 1);
  assert.equal(summary.no_match, 1);
});

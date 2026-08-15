"use strict";

const test = require("node:test");
const assert = require("node:assert");

const model = require("../subsidies/subsidyModel");

test("normalizeCola nimmt die letzten 7 Ziffern", () => {
  assert.equal(model.normalizeCola("M1_20260805_0006676210"), "6676210");
  assert.equal(model.normalizeCola("6676210"), "6676210");
  assert.equal(model.normalizeCola("  0006676210 "), "6676210");
  assert.equal(model.normalizeCola("12345"), "12345");
  assert.equal(model.normalizeCola(""), "");
  assert.equal(model.normalizeCola("keine-ziffern"), "");
});

test("parseAmount versteht deutsche und englische Formate", () => {
  assert.equal(model.parseAmount("150,00"), 150);
  assert.equal(model.parseAmount("1.234,56"), 1234.56);
  assert.equal(model.parseAmount("120.50"), 120.5);
  assert.equal(model.parseAmount("120"), 120);
  assert.equal(model.parseAmount(99.999), 100);
  assert.equal(model.parseAmount(""), null);
  assert.equal(model.parseAmount("abc"), null);
});

test("normalizeArt akzeptiert Synonyme, sonst null", () => {
  assert.equal(model.normalizeArt("Standgeld"), "STANDGELD");
  assert.equal(model.normalizeArt("standzeit"), "STANDGELD");
  assert.equal(model.normalizeArt("AFF"), "AFF");
  assert.equal(model.normalizeArt("unbekannte art"), null);
});

test("normalizeDate bringt verschiedene Formate auf YYYY-MM-DD", () => {
  assert.equal(model.normalizeDate("2026-08-15"), "2026-08-15");
  assert.equal(model.normalizeDate("15.08.2026"), "2026-08-15");
  assert.equal(model.normalizeDate("2026-08-15T10:22:00Z"), "2026-08-15");
  assert.equal(model.normalizeDate("quatsch"), null);
});

test("createRecord: Startstatus ist immer UNBEKANNT (§11)", () => {
  const r = model.createRecord(
    {
      cola_nummer: "M1_20260805_0006676210",
      zuschlagsart: "Standgeld",
      beantragte_summe: "150,00",
      datum: "2026-08-05",
    },
    { id: "test-1", now: "2026-08-15T08:00:00.000Z" },
  );
  assert.equal(r.status, "UNBEKANNT");
  assert.equal(r.cola_nummer, "6676210");
  assert.equal(r.cola_nummer_original, "M1_20260805_0006676210");
  assert.equal(r.beantragte_summe, 150);
  assert.equal(r.genehmigte_summe, null);
  assert.equal(r.antragsdatum, "2026-08-05");
  assert.equal(r.archiviert, false);
  assert.equal(r.tl_erfasst, false);
  assert.equal(r.schema_version, 1);
});

test("deriveMonthKey nutzt echtes Datum, nicht Text (§29)", () => {
  const r = model.createRecord(
    {
      cola_nummer: "6676210",
      zuschlagsart: "Standgeld",
      beantragte_summe: 10,
      datum: "2026-07-31",
    },
    { id: "m", now: "2026-08-15T00:00:00.000Z" },
  );
  assert.equal(model.deriveMonthKey(r), "2026-07");
});

test("deriveView bildet alle Ansichten ab (§4)", () => {
  const base = model.createRecord(
    {
      cola_nummer: "6676210",
      zuschlagsart: "Standgeld",
      beantragte_summe: 10,
      datum: "2026-08-01",
    },
    { id: "v", now: "2026-08-15T00:00:00.000Z" },
  );
  assert.equal(model.deriveView({ ...base, status: "OFFEN" }), "offen");
  assert.equal(model.deriveView({ ...base, status: "UNBEKANNT" }), "offen");
  assert.equal(
    model.deriveView({ ...base, status: "AKZEPTIERT", tl_erfasst: false }),
    "akzeptiert_tl_offen",
  );
  assert.equal(
    model.deriveView({ ...base, status: "AKZEPTIERT", tl_erfasst: true }),
    "abgeschlossen",
  );
  assert.equal(model.deriveView({ ...base, status: "ABGELEHNT" }), "abgelehnt");
  assert.equal(model.deriveView({ ...base, status: "PRUEFEN" }), "pruefen");
  assert.equal(model.deriveView({ ...base, archiviert: true }), "archiv");
});

test("applyChanges erzeugt Audit-Eintraege fuer geaenderte Felder (§32)", () => {
  const base = model.createRecord(
    {
      cola_nummer: "6676210",
      zuschlagsart: "Standgeld",
      beantragte_summe: 10,
      datum: "2026-08-01",
    },
    { id: "a", now: "2026-08-15T00:00:00.000Z" },
  );
  const { record, audit } = model.applyChanges(
    base,
    { status: "AKZEPTIERT", genehmigte_summe: "12,50" },
    { actor: "tester", source: "test", now: "2026-08-15T09:00:00.000Z" },
  );
  assert.equal(record.status, "AKZEPTIERT");
  assert.equal(record.genehmigte_summe, 12.5);
  assert.equal(record.updated_at, "2026-08-15T09:00:00.000Z");
  const fields = audit.map((a) => a.field).sort();
  assert.deepEqual(fields, ["genehmigte_summe", "status"]);
});

test("validateInput meldet fehlende Pflichtfelder (§12)", () => {
  assert.equal(
    model.validateInput({
      cola_nummer: "6676210",
      zuschlagsart: "Standgeld",
      beantragte_summe: 10,
      datum: "2026-08-01",
    }).ok,
    true,
  );
  const bad = model.validateInput({});
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 4);
});

test("summarize summiert je Ansicht (§30)", () => {
  const records = [
    {
      status: "OFFEN",
      beantragte_summe: 100,
      antragsdatum: "2026-08-01",
      zuschlagsart: "STANDGELD",
    },
    {
      status: "AKZEPTIERT",
      genehmigte_summe: 80,
      beantragte_summe: 90,
      antragsdatum: "2026-08-02",
      tl_erfasst: false,
      zuschlagsart: "RETOURE",
    },
    {
      status: "ABGELEHNT",
      beantragte_summe: 50,
      antragsdatum: "2026-08-03",
      zuschlagsart: "AFF",
    },
  ];
  const s = model.summarize(records, { month: "2026-08" });
  assert.equal(s.anzahl, 3);
  assert.equal(s.beantragt_summe, 240);
  assert.equal(s.akzeptiert_tl_offen_summe, 80);
  assert.equal(s.abgelehnt_summe, 50);
  assert.equal(s.offen_summe, 100);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SubsidyStore } = require("../subsidies/subsidyStore");
const imp = require("../subsidies/subsidyImport");

function tmpStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsidies-rec-"));
  return new SubsidyStore({ root });
}

function excelRow(overrides = {}) {
  return {
    "Transportnr.": "2M_20260813_0006690051",
    "Zuschlags-ID": "6817202",
    Name: "Standzeit",
    Preis: "150.00",
    "Zuschlag - Währung": "EUR",
    Beschreibung: "",
    Status: "Akzeptiert",
    Begründung: "",
    Systemzeitstempel: "2026-08-14 15:04",
    ...overrides,
  };
}

test("reconcile aktualisiert einen eindeutig passenden Satz (akzeptiert -> genehmigt=Preis)", () => {
  const store = tmpStore();
  const rec = store.create({
    cola_nummer: "2M_20260813_0006690051",
    zuschlagsart: "Standgeld",
    beantragte_summe: "150,00",
    datum: "2026-08-13",
  });

  const { candidates } = imp.parseRows([excelRow()]);
  const result = store.reconcile(candidates, { actor: "tester" });

  assert.equal(result.dryRun, false);
  assert.equal(result.summary.update, 1);
  assert.deepEqual(result.applied, [rec.id]);

  const after = store.get(rec.id);
  assert.equal(after.status, "AKZEPTIERT");
  assert.equal(after.genehmigte_summe, 150);
  assert.equal(after.zuschlags_id, "6817202");
  assert.equal(after.status_quelle, "transporeon_excel");
  assert.ok(after.transporeon_import_id);
});

test("reconcile mit dryRun aendert nichts, meldet aber den geplanten Treffer", () => {
  const store = tmpStore();
  const rec = store.create({
    cola_nummer: "2M_20260813_0006690051",
    zuschlagsart: "Standgeld",
    beantragte_summe: "150,00",
    datum: "2026-08-13",
  });

  const { candidates } = imp.parseRows([excelRow()]);
  const result = store.reconcile(candidates, { actor: "tester", dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.summary.update, 1);
  assert.equal(result.applied.length, 0);

  const after = store.get(rec.id);
  assert.equal(after.status, "UNBEKANNT");
  assert.equal(after.zuschlags_id ?? null, null);
});

test("reconcile setzt abgelehnt auf genehmigte_summe=0", () => {
  const store = tmpStore();
  const rec = store.create({
    cola_nummer: "2M_20260813_0006690051",
    zuschlagsart: "Standgeld",
    beantragte_summe: "150,00",
    datum: "2026-08-13",
  });

  const { candidates } = imp.parseRows([excelRow({ Status: "Abgelehnt" })]);
  store.reconcile(candidates, { actor: "tester" });

  const after = store.get(rec.id);
  assert.equal(after.status, "ABGELEHNT");
  assert.equal(after.genehmigte_summe, 0);
});

test("reconcile ist idempotent (zweiter Lauf -> noop, kein zusaetzliches Update)", () => {
  const store = tmpStore();
  store.create({
    cola_nummer: "2M_20260813_0006690051",
    zuschlagsart: "Standgeld",
    beantragte_summe: "150,00",
    datum: "2026-08-13",
  });

  const { candidates } = imp.parseRows([excelRow()]);
  store.reconcile(candidates, { actor: "tester" });
  const second = store.reconcile(candidates, { actor: "tester" });

  assert.equal(second.summary.update, 0);
  assert.equal(second.summary.noop, 1);
  assert.equal(second.applied.length, 0);
});

test("reconcile meldet no_match ohne etwas anzulegen (nichts raten, nichts loeschen)", () => {
  const store = tmpStore();
  const { candidates } = imp.parseRows([excelRow()]);
  const result = store.reconcile(candidates, { actor: "tester" });

  assert.equal(result.summary.no_match, 1);
  assert.equal(result.summary.update, 0);
  assert.equal(store.list({ includeArchived: true, view: "alle" }).length, 0);
});

test("reconcile meldet mehrdeutige Treffer als pruefen, ohne zu aendern", () => {
  const store = tmpStore();
  const a = store.create({
    cola_nummer: "2M_20260813_0006690051",
    zuschlagsart: "Standgeld",
    beantragte_summe: "150,00",
    datum: "2026-08-13",
  });
  const b = store.create({
    cola_nummer: "2M_20260813_0006690051",
    zuschlagsart: "Standgeld",
    beantragte_summe: "150,00",
    datum: "2026-08-13",
  });

  const { candidates } = imp.parseRows([excelRow()]);
  const result = store.reconcile(candidates, { actor: "tester" });

  assert.equal(result.summary.pruefen, 1);
  assert.equal(result.summary.update, 0);
  assert.equal(store.get(a.id).status, "UNBEKANNT");
  assert.equal(store.get(b.id).status, "UNBEKANNT");
});

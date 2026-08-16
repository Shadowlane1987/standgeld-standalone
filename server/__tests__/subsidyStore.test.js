"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SubsidyStore } = require("../subsidies/subsidyStore");

function tmpStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsidies-"));
  return new SubsidyStore({ root });
}

const baseInput = {
  cola_nummer: "M1_20260805_0006676210",
  zuschlagsart: "Standgeld",
  beantragte_summe: "150,00",
  datum: "2026-08-05",
};

test("create legt Datensatz mit Status UNBEKANNT an und schreibt Audit", () => {
  const store = tmpStore();
  const rec = store.create(baseInput, { actor: "tester" });
  assert.ok(rec.id);
  assert.equal(rec.status, "UNBEKANNT");
  assert.equal(rec.cola_nummer, "6676210");
  const hist = store.history(rec.id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].field, "created");
});

test("eine Cola-Nr kann mehrere Zuschlaege haben (§7, kein Dedup)", () => {
  const store = tmpStore();
  const a = store.create(baseInput);
  const b = store.create({ ...baseInput, beantragte_summe: 90 });
  const c = store.create({
    ...baseInput,
    zuschlagsart: "Retoure",
    beantragte_summe: 30,
  });
  assert.notEqual(a.id, b.id);
  assert.notEqual(b.id, c.id);
  const all = store.list({ search: "6676210" });
  assert.equal(all.length, 3);
});

test("Suche per Cola-Nr liefert ALLE Treffer (§37)", () => {
  const store = tmpStore();
  store.create(baseInput);
  store.create({ ...baseInput, beantragte_summe: 20 });
  store.create({
    cola_nummer: "9999999",
    zuschlagsart: "AFF",
    beantragte_summe: 5,
    datum: "2026-08-05",
  });
  const hits = store.list({ search: "6676210" });
  assert.equal(hits.length, 2);
});

test("list filtert nach Verkehr (Nah/Fern getrennt)", () => {
  const store = tmpStore();
  store.create({ ...baseInput, verkehr: "NAHVERKEHR" });
  store.create({ ...baseInput, beantragte_summe: 40, verkehr: "FERNVERKEHR" });
  store.create({ ...baseInput, beantragte_summe: 20, verkehr: "NAHVERKEHR" });

  assert.equal(store.list({ verkehr: "NAHVERKEHR" }).length, 2);
  assert.equal(store.list({ verkehr: "FERNVERKEHR" }).length, 1);
  assert.equal(store.list({ verkehr: "alle" }).length, 3);
  assert.equal(store.list({}).length, 3);
});

test("update aendert Status und archiviert nie loeschend (§3/§31)", () => {
  const store = tmpStore();
  const rec = store.create(baseInput);
  store.update(rec.id, { status: "AKZEPTIERT" }, { actor: "chef" });
  const accepted = store.get(rec.id);
  assert.equal(accepted.status, "AKZEPTIERT");

  store.markTlErfasst(rec.id, { actor: "buchhaltung" });
  assert.equal(store.get(rec.id).tl_erfasst, true);

  store.archive(rec.id, { actor: "chef" });
  const archived = store.get(rec.id);
  assert.equal(archived.archiviert, true);
  // Datei existiert weiterhin - nichts geloescht.
  assert.ok(store.get(rec.id));

  const hist = store.history(rec.id);
  const fields = hist.map((h) => h.field);
  assert.ok(fields.includes("status"));
  assert.ok(fields.includes("tl_erfasst"));
  assert.ok(fields.includes("archiviert"));
});

test("list blendet Archiv standardmaessig aus, zeigt es in Archiv-Ansicht", () => {
  const store = tmpStore();
  const rec = store.create(baseInput);
  store.archive(rec.id);
  assert.equal(store.list({}).length, 0);
  assert.equal(store.list({ view: "archiv" }).length, 1);
  assert.equal(store.list({ includeArchived: true }).length, 1);
});

test("stats liefert Monatskennzahlen", () => {
  const store = tmpStore();
  store.create({ ...baseInput, beantragte_summe: 100 });
  const accepted = store.create({ ...baseInput, beantragte_summe: 90 });
  store.update(accepted.id, { status: "AKZEPTIERT", genehmigte_summe: 80 });
  const s = store.stats({ month: "2026-08" });
  assert.equal(s.anzahl, 2);
  assert.equal(s.akzeptiert_tl_offen_summe, 80);
});

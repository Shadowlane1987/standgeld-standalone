"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { ImportStore } = require("../storage/importStore");

test("ImportStore speichert Excel-Importe mit Metadaten und listet sie wieder auf", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standgeld-imports-"));
  const store = new ImportStore({ root });

  const meta = store.saveImport({
    buffer: Buffer.from("excel"),
    fileName: "transporte.xlsx",
    transports: [
      {
        unloading: {
          window_local: "2026-07-13 09:00",
        },
      },
      {
        unloading: {
          arrival_local: "2026-07-16 12:15",
        },
      },
    ],
  });

  assert.equal(meta.file_name, "transporte.xlsx");
  assert.equal(meta.transport_count, 2);
  assert.equal(meta.unload_date_from, "2026-07-13");
  assert.equal(meta.unload_date_to, "2026-07-16");

  const listed = store.listImports();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, meta.id);

  const filePath = store.resolveImportFile(meta.id);
  assert.ok(filePath);
  assert.equal(fs.readFileSync(filePath, "utf8"), "excel");
});

test("ImportStore kann gespeicherte Importe loeschen", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standgeld-imports-"));
  const store = new ImportStore({ root });

  const meta = store.saveImport({
    buffer: Buffer.from("excel"),
    fileName: "transporte.xlsx",
    transports: [],
  });

  assert.equal(store.listImports().length, 1);
  assert.equal(store.deleteImport(meta.id), true);
  assert.equal(store.listImports().length, 0);
  assert.equal(store.resolveImportFile(meta.id), null);
  assert.equal(store.getImport(meta.id), null);
  assert.equal(store.deleteImport(meta.id), false);
});

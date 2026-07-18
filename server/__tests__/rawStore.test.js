"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { RawStore } = require("../raw/rawStore");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "standgeld-raw-"));
}

test("RawStore: Lauf anlegen, Rohevents anhaengen, zuruecklesen", () => {
  const root = tempRoot();
  const store = new RawStore({ root });

  const { runId, importedAt } = store.createImportRun({
    source: "transporeon-dispatch",
    transport_number: "3D_20260715_0006639797",
  });
  assert.ok(runId);
  assert.ok(importedAt);

  const written = store.appendRawEvents(runId, [
    { event_name: "Ankunft", source_type: "TP_XP" },
    { event_name: "Abfahrt", source_type: "TP_XP" },
  ]);
  assert.equal(written, 2);

  const readBack = store.readRawEvents(runId);
  assert.equal(readBack.length, 2);
  assert.equal(readBack[0].event_name, "Ankunft");

  const runs = store.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].run_id, runId);

  fs.rmSync(root, { recursive: true, force: true });
});

test("RawStore: Roh-Response ist write-once (immutable, §7)", () => {
  const root = tempRoot();
  const store = new RawStore({ root });
  const { runId } = store.createImportRun({});

  store.saveRawResponse(runId, "//OK[...]");
  assert.throws(
    () => store.saveRawResponse(runId, "veraenderter Inhalt"),
    /EEXIST/,
    "zweites Schreiben desselben Roh-Response muss fehlschlagen",
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test("RawStore: append-only fuegt zu bestehenden Events hinzu", () => {
  const root = tempRoot();
  const store = new RawStore({ root });
  const { runId } = store.createImportRun({});

  store.appendRawEvents(runId, [{ event_name: "A" }]);
  store.appendRawEvents(runId, [{ event_name: "B" }]);

  const events = store.readRawEvents(runId);
  assert.deepEqual(
    events.map((e) => e.event_name),
    ["A", "B"],
  );

  fs.rmSync(root, { recursive: true, force: true });
});

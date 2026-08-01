#!/usr/bin/env node
"use strict";

/**
 * Diagnose: Findet die Zeitfenster-Excel eine bestimmte Transportnummer und
 * welche Entlade-/Ladezeit steht dort? Rein lokal, keine Sixfold/Token noetig.
 *
 * Aufruf (PowerShell):
 *   node server/tools/pruefeZeitfenster.js "<Pfad zur .xlsx>" "61_20260724_0006655499"
 */

const path = require("path");
const { loadZeitfenster } = require("./readZeitfensterExcel");
const { transportNumberToLadenummer } = require("../normalize/ladenummer");
const { windowStartForStop } = require("../normalize/zeitfenster");

function main() {
  const file = process.argv[2];
  const transport = process.argv[3];
  if (!file || !transport) {
    console.log(
      'Aufruf: node server/tools/pruefeZeitfenster.js "<Pfad.xlsx>" "<Transportnummer>"',
    );
    process.exit(1);
  }

  const { windows, index } = loadZeitfenster(path.resolve(file));
  const ladenummer = transportNumberToLadenummer(transport);

  console.log("Datei:            ", path.resolve(file));
  console.log("Zeilen erkannt:   ", windows.length);
  console.log("Index-Groesse:    ", index.size);
  console.log("Transportnummer:  ", transport);
  console.log("-> Ladenummer:    ", ladenummer);

  const row = ladenummer ? index.get(ladenummer) : null;
  if (!row) {
    console.log("\nERGEBNIS: KEINE passende Zeile in der Excel gefunden.");
    console.log(
      "Beispiel-Ladenummern in der Excel:",
      [...index.keys()].slice(0, 10).join(", "),
    );
    return;
  }

  console.log("\nERGEBNIS: Zeile gefunden:");
  console.log(JSON.stringify(row, null, 2));
  console.log(
    "\nEntladezeit-Start (UNLOADING):",
    windowStartForStop(row, "UNLOADING"),
  );
  console.log(
    "Ladezeit-Start (LOADING):     ",
    windowStartForStop(row, "LOADING"),
  );
}

main();

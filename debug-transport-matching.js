#!/usr/bin/env node
"use strict";

/**
 * Debug-Script: Vergleiche Excel-Transport-Numbers mit Sixfold-Transport-Numbers.
 * Finde heraus, warum die GPS-Daten nicht gemapped werden.
 */

const {
  loadTransporeonExport,
} = require("./server/tools/readTransporeonExport");
const fs = require("fs");

const EXPORT_XLSX_PATH = "./data/captures/transporeon_export.xlsx";

function main() {
  console.log("=== Transport-Number Matching Debug ===\n");

  // Lade Excel-Export
  console.log("1. Excel-Transport-Numbers (aus Transporeon-Export):");
  const transports = loadTransporeonExport(EXPORT_XLSX_PATH);

  const excelNumbers = new Set();
  transports.forEach((t) => {
    excelNumbers.add(t.transport_number);
  });

  console.log(`   Geladen: ${transports.length} Transporte`);
  console.log(`   Unique Transport-Numbers: ${excelNumbers.size}`);
  console.log(`   Beispiele (erste 5):`);
  Array.from(excelNumbers)
    .slice(0, 5)
    .forEach((tn) => console.log(`     - ${tn}`));

  // Sixfold-Beispiele
  console.log("\n2. Sixfold-Transport-Numbers (Erwartung):");
  console.log(
    "   Format wahrscheinlich: shipper_transport_number oder ähnlich",
  );
  console.log("   Bitte folgende Fragen beantworten:");
  console.log("   - Welche Trucks sind in Sixfold eingetragen?");
  console.log("   - Welches Format haben die Transporter-Nummern dort?");
  console.log("   - Beispiel eines Excel-TN: " + Array.from(excelNumbers)[0]);

  // Speichere Liste in Datei
  const listPath = "./debug-excel-transports.txt";
  const list = Array.from(excelNumbers).sort().join("\n");
  fs.writeFileSync(listPath, list);
  console.log(`\n   ✓ Vollständige Liste gespeichert in: ${listPath}`);

  // Analyse
  console.log("\n3. Analyse:");
  const patterns = {
    hasPrefixPattern: 0, // 2Z_20260714_00066363
    onlyNumber: 0, // 00066363
    other: 0,
  };

  excelNumbers.forEach((tn) => {
    if (/^[A-Z0-9]{2}_\d{8}_\d{10}$/.test(tn)) {
      patterns.hasPrefixPattern++;
    } else if (/^\d{10}$/.test(tn)) {
      patterns.onlyNumber++;
    } else {
      patterns.other++;
    }
  });

  console.log(
    `   Format "XX_YYYYMMDD_NNNNNNNNN": ${patterns.hasPrefixPattern}`,
  );
  console.log(`   Format "NNNNNNNNN" (nur Nummer): ${patterns.onlyNumber}`);
  console.log(`   Andere Format: ${patterns.other}`);

  // Vermutung
  console.log("\n4. Vermutung (warum GPS nicht gemappt wird):");
  if (patterns.hasPrefixPattern === excelNumbers.size) {
    console.log("   ⚠ Excel hat das Format 'XX_YYYYMMDD_NNNNNNNNN'.");
    console.log(
      "   ⚠ Sixfold wahrscheinlich ein ANDERES Format (z.B. nur Nummer).",
    );
    console.log(
      "   ⚠ buildGpsIndex matcht diese NICHT → GPS wird nie gefunden!\n",
    );
    console.log("   LÖSUNG: Transport-Number in buildGpsIndex normalisieren");
    console.log("   z.B. nur die Nummer extrahieren: TN.split('_').pop()");
  }
}

main();

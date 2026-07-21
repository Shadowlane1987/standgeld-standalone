#!/usr/bin/env node
"use strict";

/**
 * Debug: Vergleiche Excel-TN mit Sixfold-TN
 */

const {
  loadTransporeonExport,
} = require("./server/tools/readTransporeonExport");

// Excel-Transport-Numbers
const transports = loadTransporeonExport(
  "./data/captures/transporeon_export.xlsx",
);
const excelTn = transports.map((t) => t.transport_number);

console.log("=== Excel-Transport-Numbers (Beispiele) ===\n");
excelTn.slice(0, 10).forEach((tn, i) => {
  console.log(`${i + 1}. "${tn}"`);
});

// Sixfold wird vom Server geladen, daher hier die Beispiele vom Test:
const sixfoldTn = [
  "32700609808", // 11-stellig (von test-sixfold-minimal.js)
  "B2_20260723_0006654477", // Mit Präfix
  "3019634", // 7-stellig
];

console.log("\n=== Sixfold-Transport-Numbers (Beispiele vom Test) ===\n");
sixfoldTn.forEach((tn, i) => {
  console.log(`${i + 1}. "${tn}"`);
});

console.log("\n=== ANALYSE ===\n");
console.log("Format Unterschiede:");
console.log(
  "  Excel:   'XX_YYYYMMDD_NNNNNNNNN' (z.B. '2M_20260715_0006638489')",
);
console.log(
  "  Sixfold: Mixed (z.B. '32700609808', 'B2_20260723_0006654477', '3019634')",
);

console.log("\nMatches prüfen:");
let found = 0;
sixfoldTn.forEach((stn) => {
  if (excelTn.includes(stn)) {
    console.log(`  ✓ "${stn}" GEFUNDEN in Excel`);
    found++;
  } else {
    console.log(`  ✗ "${stn}" NICHT in Excel`);
  }
});

if (found === 0) {
  console.log("\n⚠️  PROBLEM: KEINE Transport-Numbers matchen!");
  console.log("\nLösungsansätze:");
  console.log("1. Vielleicht matchen Sixfold-Nummern mit den LETZTEN Digits");

  console.log("\n   Versuchen: Sixfold am Ende mit Excel am Ende:");
  sixfoldTn.forEach((stn) => {
    const lastDigits = stn.replace(/\\D/g, "").slice(-10);
    const excelWithEndingMatch = excelTn.find((etn) =>
      etn.endsWith(lastDigits),
    );
    if (excelWithEndingMatch) {
      console.log(
        `   ✓ "${stn}" → "${lastDigits}" → MATCH: "${excelWithEndingMatch}"`,
      );
    } else {
      console.log(`   ✗ "${stn}" → "${lastDigits}" → keine Matches`);
    }
  });
}

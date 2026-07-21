#!/usr/bin/env node
"use strict";

/**
 * Test: Normalisierung von Transport-Numbers
 */

function normalizeTransportNumber(tn) {
  if (!tn) return "";
  const str = String(tn).trim();
  // Suche nach 10-stelligen Nummern am Ende (üblicherweise die Transport-ID)
  const match = str.match(/(\d{10})$/);
  return match ? match[1] : str;
}

console.log("=== Test: normalizeTransportNumber ===\n");

const testCases = [
  // Excel-Format
  {
    input: "2M_20260715_0006638489",
    expected: "0006638489",
    label: "Excel-Format mit Präfix",
  },
  {
    input: "3K_20260715_0006638456",
    expected: "0006638456",
    label: "Excel-Format 3K-Präfix",
  },
  {
    input: "61_20260715_0006638454",
    expected: "0006638454",
    label: "Excel-Format 61-Präfix",
  },

  // Sixfold-Format (Vermutung)
  { input: "0006638489", expected: "0006638489", label: "Sixfold: nur Nummer" },

  // Edge Cases
  {
    input: "TN_2026_0006638489_suffix",
    expected: "0006638489",
    label: "Suffix nach Nummer",
  },
  {
    input: "2M_20260715_00066384",
    expected: "00066384",
    label: "Zu kurz (8 Digits)",
  },
  { input: "", expected: "", label: "Leere Nummer" },
];

let passed = 0;
let failed = 0;

testCases.forEach(({ input, expected, label }) => {
  const result = normalizeTransportNumber(input);
  const isPass = result === expected;
  const status = isPass ? "✓" : "✗";

  if (isPass) passed++;
  else failed++;

  console.log(`${status} ${label}`);
  console.log(`    Input:    "${input}"`);
  console.log(`    Expected: "${expected}"`);
  console.log(`    Got:      "${result}"`);

  if (!isPass) {
    console.log(`    ⚠ MISMATCH!`);
  }
  console.log("");
});

console.log(`\n=== Ergebnis: ${passed} passed, ${failed} failed ===`);

if (failed === 0) {
  console.log("\n✓ Normalisierung funktioniert korrekt!");
  console.log(
    "\nWenn GPS immernoch nicht gemappt wird, liegt es wahrscheinlich daran, dass:",
  );
  console.log("1. Sixfold-Transport-Numbers ein ANDERES Format haben");
  console.log("2. Z.B. nicht mit 10 Digits enden");
  console.log("3. Oder komplett andere Nummern sind als Excel");
} else {
  console.log("\n✗ Fehler in der Normalisierung!");
}

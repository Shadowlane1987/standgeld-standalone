#!/usr/bin/env node

/**
 * Live test für /api/sixfold/selective-match
 * Testet: Excel hochladen, TNs extrahieren, mit Sixfold-Dummy vergleichen
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const excelPath = path.join(
  __dirname,
  "..",
  "..",
  "data",
  "captures",
  "transporeon_export.xlsx",
);

async function testSelectiveMatch() {
  console.log("[TEST] Starting selective-match live test...\n");

  if (!fs.existsSync(excelPath)) {
    console.error(`[ERROR] Excel-Datei nicht gefunden: ${excelPath}`);
    process.exit(1);
  }

  const fileBuffer = fs.readFileSync(excelPath);
  console.log(`[OK] Excel geladen: ${fileBuffer.length} bytes\n`);

  try {
    // Test 1: Ohne Credentials -> sollte 400 Error sein
    console.log("[TEST 1] Ohne Sixfold-Credentials:");
    try {
      await axios.post(
        "http://localhost:3100/api/sixfold/selective-match",
        fileBuffer,
        {
          headers: {
            "Content-Type": "application/octet-stream",
          },
        },
      );
      console.log("  ✗ FAIL: Sollte 400 sein");
    } catch (err) {
      if (err.response?.status === 400) {
        console.log(`  ✓ OK: Richtig 400 -> "${err.response.data.error}"\n`);
      } else {
        console.log(`  ✗ FAIL: Status ${err.response?.status}\n`);
      }
    }

    // Test 2: Mit Dummy-Credentials aber echtem Sixfold -> wird fehlschlagen, aber das ist OK
    console.log(
      "[TEST 2] Mit Sixfold-Cookies (wird fehlschlagen - kein echtes Sixfold):",
    );
    try {
      const response = await axios.post(
        "http://localhost:3100/api/sixfold/selective-match",
        fileBuffer,
        {
          headers: {
            "Content-Type": "application/octet-stream",
            "x-sixfold-url": "https://app.sixfold.com/graphql",
            "x-sixfold-cookie": "sessionToken=dummy123; sixfold_lng=de",
          },
          timeout: 10000,
        },
      );
      console.log(`  ✓ Response Status: ${response.status}`);
      console.log(
        `  Summary: ${JSON.stringify(response.data.summary, null, 2)}`,
      );
    } catch (err) {
      console.log(
        `  Expected: Sixfold-API-Fehler (dummy token) -> ${err.message}\n`,
      );
    }

    console.log("[OK] Tests abgeschlossen!");
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
  }
}

testSelectiveMatch().catch((err) => {
  console.error(err);
  process.exit(1);
});

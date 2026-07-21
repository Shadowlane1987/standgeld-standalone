#!/usr/bin/env node
"use strict";

/**
 * Debug: Zeige echte Sixfold-Daten zum Vergleich mit Excel.
 */

const https = require("https");
const { URL } = require("url");

const SIXFOLD_URL = "https://app.sixfold.com/companies/799/fleet/all/timeline";
const TOKEN = "P0jKkIFx3HPT4cHdnLK8k715eZ-qC2ofe4zGj88UZMk";

async function fetchSixfoldToursRaw() {
  return new Promise((resolve, reject) => {
    const graphqlQuery = `
      query ToursQuery($first: Int!, $after: String, $role: [TourRole!]!) {
        tours(first: $first, after: $after, role: $role) {
          edges { 
            node { 
              id 
              shipper_transport_number
              stops { 
                position { lat lng }
                type
                arrival_time 
                departure_time
              }
            }
          }
        }
      }
    `;

    const payload = JSON.stringify({
      query: graphqlQuery,
      variables: {
        first: 10,
        role: ["CARRIER"],
      },
    });

    const url = new URL(SIXFOLD_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname + "?query=" + encodeURIComponent(graphqlQuery),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `sessionToken=${TOKEN}; sixfold_lng=de`,
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });

    req.write(payload);
    req.end();
  });
}

(async () => {
  console.log("Lade Sixfold-Daten...\n");
  try {
    const result = await fetchSixfoldToursRaw();
    if (result.errors) {
      console.log("GraphQL Error:", result.errors);
      return;
    }

    const tours = result?.data?.tours?.edges || [];
    console.log(`Geladen: ${tours.length} Tours\n`);
    console.log("Erste 5 Transport-Numbers aus Sixfold:");
    tours.slice(0, 5).forEach((edge, i) => {
      const tn = edge.node?.shipper_transport_number || "NULL";
      console.log(`  ${i + 1}. "${tn}"`);
    });

    console.log("\nAnalyse:");
    const allTn = tours.map((e) => e.node?.shipper_transport_number || "");
    const samples = allTn.slice(0, 10);
    console.log("Muster:");
    samples.forEach((tn) => {
      if (!tn) return;
      console.log(`  "${tn}" (länge: ${tn.length})`);
    });

    // Check ob Nummern mit Excel-Prefix übereinstimmen
    console.log("\nVergleich mit Excel-Format (2M_20260715_0006638489):");
    console.log(
      "  - Excel: 2M_20260715_0006638489 (format: XX_YYYYMMDD_NNNNNNNNN)",
    );
    console.log(`  - Sixfold scheint zu haben: "${allTn[0] || "NULL"}"`);

    if (allTn[0] && allTn[0].includes("_")) {
      console.log("  ✓ Sixfold hat auch Unterstriche!");
    } else if (allTn[0] && /^\d{10}$/.test(allTn[0])) {
      console.log("  ⚠ Sixfold hat nur 10-stellige Nummern!");
      console.log("  ⚠ Das ist die Nummer OHNE Präfix! Das ist das Problem!");
      console.log("  LÖSUNG: Last 10 Digits aus Excel extrahieren");
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
})();

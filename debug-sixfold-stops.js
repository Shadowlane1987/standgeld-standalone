#!/usr/bin/env node
"use strict";

/**
 * Debug-Script: Logge echte Sixfold-Daten, um zu sehen,
 * warum GPS nicht gemappt wird.
 *
 * Kopiert die exacte Logik aus server/index.js, aber mit Debug-Output.
 */

const https = require("https");
const { URL } = require("url");

const SIXFOLD_URL = "https://app.sixfold.com/companies/799/fleet/all/timeline";
const TOKEN = "P0jKkIFx3HPT4cHdnLK8k715eZ-qC2ofe4zGj88UZMk";

// Normalisierungs-Helper (wie in exportBilling.js)
function normalizeTransportNumber(tn) {
  if (!tn) return "";
  const str = String(tn).trim();
  const match = str.match(/(\d{10})$/);
  return match ? match[1] : str;
}

async function queryGraphql(url, query, variables = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ query, variables });
    const parsedUrl = new URL(url);

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: `sessionToken=${TOKEN}; sixfold_lng=de`,
      },
      timeout: 20000,
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const result = JSON.parse(body);
          resolve(result);
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

    req.write(data);
    req.end();
  });
}

async function main() {
  console.log("=== Debug: Sixfold-Daten ===\n");

  try {
    // Dieser Query ist aus server/index.js (shipperToursCarrier)
    const query = `
      query ShipperTourCarrier(
        $first: Int!
        $after: String
        $fromTime: DateTime
        $toTime: DateTime
      ) {
        shipperToursCarrier(
          first: $first
          after: $after
          fromTime: $fromTime
          toTime: $toTime
        ) {
          edges {
            node {
              id
              tour_id
              shipper_transport_number
              stops(first: 50) {
                edges {
                  node {
                    id
                    type
                    arrival_time
                    departure_time
                    position {
                      lat
                      lng
                    }
                    status_events(first: 100) {
                      edges {
                        node {
                          event_name
                          event_time
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    console.log("Querying Sixfold GraphQL...");
    const result = await queryGraphql(
      "https://app.sixfold.com/graphql",
      query,
      {
        first: 5, // Nur 5 zum schnellen Test
        fromTime: "2026-07-10T00:00:00Z",
        toTime: "2026-07-20T23:59:59Z",
      },
    );

    if (result.errors) {
      console.log("✗ GraphQL Errors:");
      result.errors.forEach((e) => console.log(`  - ${e.message}`));
      return;
    }

    const edges = result?.data?.shipperToursCarrier?.edges || [];
    console.log(`✓ Geladen: ${edges.length} Tours\n`);

    // Logge jede Tour + ihre Stopps
    edges.forEach((edge, idx) => {
      const tour = edge.node;
      const tn = tour.shipper_transport_number || "NULL";
      const stops = tour.stops?.edges || [];

      console.log(`Tour ${idx + 1}:`);
      console.log(`  Transport-Number: "${tn}"`);
      console.log(`  Normalisiert: "${normalizeTransportNumber(tn)}"`);
      console.log(`  Stopps: ${stops.length}`);

      stops.forEach((stopEdge, sIdx) => {
        const stop = stopEdge.node;
        const coords = stop.position || {};
        const events = (stop.status_events?.edges || []).map(
          (e) => e.node.event_name,
        );

        console.log(
          `    Stop ${sIdx + 1}: ${stop.type} | Coords: (${coords.lat}, ${coords.lng}) | Events: [${events.join(", ")}]`,
        );
      });
      console.log("");
    });

    console.log("=== ANALYSE ===\n");
    if (edges.length === 0) {
      console.log("⚠ KEINE Tours geladen!");
      console.log("   Mögliche Gründe:");
      console.log("   1. Token ist ungültig/abgelaufen");
      console.log("   2. Query hat keine Daten im Zeitfenster");
      console.log("   3. API-Endpunkt hat sich geändert");
    } else {
      const allTn = edges.map((e) => e.node.shipper_transport_number);
      const allNormalized = allTn.map(normalizeTransportNumber);

      console.log("Transport-Numbers (Sixfold):");
      allTn.forEach((tn) => console.log(`  "${tn}"`));

      console.log("\nNormalisiert:");
      allNormalized.forEach((tn) => console.log(`  "${tn}"`));

      console.log("\nVergleich mit Excel-Transport (2M_20260715_0006638489):");
      console.log(`  Excel-Nummer: "2M_20260715_0006638489"`);
      console.log(`  Excel-normalisiert: "0006638489"`);
      console.log(
        `  Sixfold hat diese? ${allTn.includes("2M_20260715_0006638489") ? "JA" : "NEIN"}`,
      );
      console.log(
        `  Sixfold-normalisiert hat diese? ${allNormalized.includes("0006638489") ? "JA" : "NEIN"}`,
      );
    }
  } catch (err) {
    console.error("✗ Error:", err.message);
  }
}

main();

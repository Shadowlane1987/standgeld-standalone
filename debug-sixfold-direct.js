#!/usr/bin/env node
"use strict";

/**
 * Debug: Nutze die gleiche Sixfold-Fetch-Logik wie server/index.js,
 * um die echten Transport-Numbers zu sehen.
 */

const { fetchFleetTimelineStops } = require("./server/index.js") || {};

// Nicht möglich, da fetchFleetTimelineStops nicht exportiert ist!
// Stattdessen: Copy der Logik aus index.js oder direkter HTTP-Call

const https = require("https");

async function testSixfoldMatch() {
  console.log(
    "Testing Sixfold GraphQL - nutze den gleichen Query wie server/index.js\n",
  );

  const url = "https://app.sixfold.com/graphql";
  const token = "P0jKkIFx3HPT4cHdnLK8k715eZ-qC2ofe4zGj88UZMk";

  // Der Query aus server/index.js (shipperToursCarrier oder companyToursCarrier)
  const query = `
    query CompanyToursCarrier($first: Int!, $after: String) {
      companyToursCarrier(first: $first, after: $after) {
        edges {
          node {
            id
            shipper_transport_number
            stops(first: 20) {
              edges {
                node {
                  id
                  type
                  arrival_time
                  departure_time
                  position { lat lng }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  return new Promise((resolve) => {
    const data = JSON.stringify({
      query,
      variables: { first: 3 }, // Nur 3 zum schnell testen
    });

    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: `sessionToken=${token}; sixfold_lng=de`,
      },
      timeout: 15000,
    };

    const req = https.request(url, options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const result = JSON.parse(body);
          if (result.errors) {
            console.log("GraphQL Errors:", result.errors);
            resolve(null);
            return;
          }

          const tours = result?.data?.companyToursCarrier?.edges || [];
          console.log(`Geladen: ${tours.length} Tours\n`);

          if (tours.length === 0) {
            console.log(
              "⚠ Keine Tours geladen. API möglicherweise nicht erreichbar.",
            );
            resolve(null);
            return;
          }

          console.log("Erste 3 Tours - Transport-Numbers:\n");
          tours.slice(0, 3).forEach((edge, i) => {
            const tn = edge?.node?.shipper_transport_number || "NULL";
            const stopCount = edge?.node?.stops?.edges?.length || 0;
            console.log(`  ${i + 1}. Transport: "${tn}" (${stopCount} Stopps)`);
          });

          console.log("\n=== ANALYSE ===\n");

          const firstTn = tours[0]?.node?.shipper_transport_number;
          console.log("Format Sixfold: " + (firstTn ? `"${firstTn}"` : "NULL"));
          console.log('Format Excel:   "2M_20260715_0006638489"');

          if (firstTn && firstTn.includes("_")) {
            console.log(
              "\n✓ Sixfold hat auch Präfix + Underscores (Format OK)",
            );
          } else if (firstTn && /^\d{10}$/.test(firstTn)) {
            console.log(
              "\n⚠ PROBLEM: Sixfold hat NUR 10-stellige Nummer ohne Präfix!",
            );
            console.log("\nLösung:");
            console.log(
              "  1. buildGpsIndex: Extrahiere last-10-digits aus Excel-TN",
            );
            console.log(
              "  2. Match mit Sixfold last-10-digits (die sind schon ohne Präfix)",
            );
            console.log(
              '  3. Beispiel: "2M_20260715_0006638489".split("_").pop() = "0006638489"',
            );
          }

          resolve(true);
        } catch (e) {
          console.error("Parse error:", e.message);
          resolve(null);
        }
      });
    });

    req.on("error", (err) => {
      console.error("Request error:", err.message);
      resolve(null);
    });

    req.write(data);
    req.end();
  });
}

testSixfoldMatch().then(() => process.exit(0));

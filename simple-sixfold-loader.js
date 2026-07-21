#!/usr/bin/env node
"use strict";

/**
 * Simplified Sixfold GPS Loader - nur Transport-Nummer + GPS-Zeiten abrufen.
 * Nutzt die ECHTE Query-Struktur aus server/index.js
 */

const axios = require("axios");

async function fetchSixfoldGpsSimple(sessionCookie) {
  const companyId = "799";

  console.log(`Lade Sixfold GPS für Company ${companyId}...\n`);

  // Query: Echte Struktur aus server/index.js
  const query = `
    query FleetAllViaCompanyTours(
      $companyId: String!
      $after: String
    ) {
      viewer {
        company(company_id: $companyId) {
          tours(role: CARRIER) {
            tours(first: 500, after: $after) {
              edges {
                node {
                  tour_id
                  shipper_transport_number
                  stops {
                    stop_id
                    type
                    arrival_time
                    departure_time
                    position {
                      lat
                      lng
                    }
                    status_events {
                      event_name
                      event_time
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
        }
      }
    }
  `;

  const headers = {
    "Content-Type": "application/json",
    Cookie: sessionCookie,
  };

  const allStops = [];
  let after = null;
  let page = 0;

  try {
    while (true) {
      page++;
      console.log(`  [Seite ${page}] Abrufen...`);

      const response = await axios.post(
        "https://app.sixfold.com/graphql",
        {
          query,
          variables: { companyId, after },
        },
        { timeout: 45000, headers },
      );

      if (response?.data?.errors) {
        console.error("  GraphQL Error:", response.data.errors[0]?.message);
        throw new Error(response.data.errors[0]?.message || "GraphQL Error");
      }

      const tours =
        response?.data?.data?.viewer?.company?.tours?.tours?.edges || [];
      console.log(`    → ${tours.length} Tours gefunden`);

      let pageStops = 0;
      tours.forEach((edge) => {
        const tour = edge?.node;
        const tn = String(tour?.shipper_transport_number || "").trim();
        if (!tn) return;

        const stops = Array.isArray(tour?.stops) ? tour.stops : [];
        stops.forEach((stop) => {
          const coords = stop?.position || {};
          const events = Array.isArray(stop?.status_events)
            ? stop.status_events
            : [];

          // GPS-Verifikation: APPROACH + DEPART Events
          const eventNames = events.map((e) => String(e?.event_name || ""));
          const hasApproach = eventNames.includes("APPROACH");
          const hasDepart = eventNames.includes("DEPART");

          const storeStop = {
            transport_number: tn,
            type: String(stop?.type || "").toUpperCase(),
            arrival_time: stop?.arrival_time || null,
            departure_time: stop?.departure_time || null,
            position: {
              lat: Number(coords?.lat) || 0,
              lng: Number(coords?.lng) || 0,
            },
            gps: {
              arrival_verified: hasApproach,
              departure_verified: hasDepart,
            },
          };

          allStops.push(storeStop);
          pageStops++;
        });
      });

      console.log(`    → ${pageStops} Stopps geladen`);

      const hasMore =
        response?.data?.data?.viewer?.company?.tours?.tours?.pageInfo
          ?.hasNextPage;
      after =
        response?.data?.data?.viewer?.company?.tours?.tours?.pageInfo
          ?.endCursor;

      if (!hasMore || !after) {
        console.log(`    → Fertig (keine weiteren Seiten)`);
        break;
      }

      console.log(
        `    → Nächste Seite mit Cursor: ${after.substring(0, 20)}...\n`,
      );
      await new Promise((r) => setTimeout(r, 200));
    }

    console.log(`\n✓ Insgesamt ${allStops.length} Stopps geladen.\n`);
    return allStops;
  } catch (err) {
    console.error("\n✗ Error:", err.message);
    throw err;
  }
}

// Test
(async () => {
  try {
    const stops = await fetchSixfoldGpsSimple(
      `sessionToken=P0jKkIFx3HPT4cHdnLK8k715eZ-qC2ofe4zGj88UZMk; sixfold_lng=de`,
    );

    console.log("=== Erste 5 Stopps ===\n");
    stops.slice(0, 5).forEach((stop, i) => {
      const hasGps =
        stop.gps.arrival_verified || stop.gps.departure_verified
          ? "✓ GPS"
          : "✗ kein GPS";
      console.log(
        `${i + 1}. TN="${stop.transport_number}" | ${stop.type} | Coords=(${stop.position.lat},${stop.position.lng}) | ${hasGps}`,
      );
    });

    // Statistik
    const uniqueTn = new Set(stops.map((s) => s.transport_number)).size;
    const gpsStops = stops.filter(
      (s) => s.gps.arrival_verified || s.gps.departure_verified,
    ).length;
    const zeroCoords = stops.filter(
      (s) => s.position.lat === 0 && s.position.lng === 0,
    ).length;

    console.log(`\n=== Statistik ===`);
    console.log(`  Unique Transport-Numbers: ${uniqueTn}`);
    console.log(`  Stopps mit GPS-Verifikation: ${gpsStops}/${stops.length}`);
    console.log(`  Stopps mit 0/0-Koordinaten: ${zeroCoords}`);
  } catch (err) {
    console.error("Failed:", err.message);
    process.exit(1);
  }
})();

#!/usr/bin/env node
const axios = require("axios");

// Teste verschiedene Datums-Filter um completed Transporte zu finden
const testRanges = [
  { from: "2026-07-01", to: "2026-07-10" },
  { from: "2026-07-10", to: "2026-07-15" },
  { from: "2026-07-15", to: "2026-07-20" },
  { from: "2026-06-01", to: "2026-06-30" },
  { from: "2026-05-01", to: "2026-05-31" },
];

const FLEET_STOP_FIELDS = `
  stop_id
  type
  status
  arrival_time
  departure_time
`;

async function testRange(from, to) {
  const query = `{
    viewer {
      company(company_id: "799") {
        tours(role: CARRIER) {
          tours(first: 10) {
            edges {
              node {
                shipper_transport_number
                stops {
                  ${FLEET_STOP_FIELDS}
                }
              }
            }
          }
        }
      }
    }
  }`;

  const headers = {
    "Content-Type": "application/json",
    Cookie:
      "sessionToken=P0jKkIFx3HPT4cHdnLK8k715eZ-qC2ofe4zGj88UZMk; sixfold_lng=de",
  };

  try {
    const response = await axios.post(
      "https://app.sixfold.com/graphql",
      { query },
      { timeout: 10000, headers },
    );

    if (response?.data?.errors) {
      console.log(`❌ [${from} - ${to}] GraphQL Error`);
      return;
    }

    const tours =
      response?.data?.data?.viewer?.company?.tours?.tours?.edges || [];

    let completedCount = 0;
    let withTimesCount = 0;

    tours.forEach((edge) => {
      const stops = edge?.node?.stops || [];
      stops.forEach((stop) => {
        if (stop.status === "completed") completedCount++;
        if (stop.arrival_time || stop.departure_time) withTimesCount++;
      });
    });

    console.log(
      `[${from} - ${to}] Tours: ${tours.length}, Completed Stops: ${completedCount}, With Times: ${withTimesCount}`,
    );

    if (completedCount > 0 && tours.length > 0) {
      const firstCompleted = tours[0]?.node?.stops?.find(
        (s) => s.status === "completed",
      );
      if (firstCompleted) {
        console.log(
          `  ✓ SAMPLE: status=${firstCompleted.status}, arrival=${firstCompleted.arrival_time}, departure=${firstCompleted.departure_time}`,
        );
      }
    }
  } catch (error) {
    console.log(`❌ [${from} - ${to}] Error: ${error.message}`);
  }
}

async function run() {
  console.log("Suche nach abgeschlossenen Transporten mit echten Zeiten...\n");
  for (const range of testRanges) {
    await testRange(range.from, range.to);
    await new Promise((r) => setTimeout(r, 200));
  }
}

run();

#!/usr/bin/env node
const axios = require("axios");

const query = `query FetchTours($fromTime: DateTime, $toTime: DateTime) {
  viewer {
    company(company_id: "799") {
      tours(role: CARRIER) {
        tours(first: 2, fromTime: $fromTime, toTime: $toTime) {
          edges {
            node {
              shipper_transport_number
              stops {
                stop_id
                type
                arrival_time
                departure_time
                status
              }
            }
          }
        }
      }
    }
  }
}`;

const variables = {
  fromTime: "2026-07-15T00:00:00Z",
  toTime: "2026-07-19T23:59:59Z",
};

async function test() {
  const headers = {
    "Content-Type": "application/json",
    Cookie:
      "sessionToken=P0jKkIFx3HPT4cHdnLK8k715eZ-qC2ofe4zGj88UZMk; sixfold_lng=de",
  };

  try {
    console.log("Query mit Datums-Filtern...");
    console.log("fromTime:", variables.fromTime);
    console.log("toTime:", variables.toTime);

    const response = await axios.post(
      "https://app.sixfold.com/graphql",
      { query, variables },
      { timeout: 15000, headers },
    );

    if (response?.data?.errors) {
      console.log(
        "❌ GraphQL Error:",
        JSON.stringify(response.data.errors, null, 2),
      );
      return;
    }

    const tours =
      response?.data?.data?.viewer?.company?.tours?.tours?.edges || [];
    console.log("✅ Tours mit Datums-Filter:", tours.length);

    if (tours.length > 0) {
      tours.forEach((edge, idx) => {
        const tn = edge?.node?.shipper_transport_number;
        const stops = edge?.node?.stops || [];
        console.log(`  Tour ${idx}: ${tn}, ${stops.length} stops`);

        stops.slice(0, 2).forEach((stop, stopIdx) => {
          console.log(
            `    Stop ${stopIdx}: type=${stop.type}, status=${stop.status}, arrival=${stop.arrival_time}, departure=${stop.departure_time}`,
          );
        });
      });
    }
  } catch (error) {
    console.log("❌ Error:", error.message);
    if (error.response?.data?.errors) {
      console.log(
        "GraphQL Errors:",
        JSON.stringify(error.response.data.errors, null, 2),
      );
    }
  }
}

test();

#!/usr/bin/env node
const axios = require("axios");

const FLEET_STOP_FIELDS = `
  stop_id
  type
  status
  arrival_time
  departure_time
  estimated_arrival
  deadline
  timeslot {
    begin
    end
    timezone
  }
  location {
    name
    bookingLocationName
    gate
    address {
      full_address
    }
    customerProvidedAddress {
      full_address
    }
    position {
      lat
      lng
    }
  }
  status_events {
    event_name
    event_time
    created_at
  }
`;

const query = `{
  viewer {
    company(company_id: "799") {
      tours(role: CARRIER) {
        tours(first: 2) {
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

async function test() {
  const headers = {
    "Content-Type": "application/json",
    Cookie:
      "sessionToken=P0jKkIFx3HPT4cHdnLK8k715eZ-qC2ofe4zGj88UZMk; sixfold_lng=de",
  };

  try {
    console.log("Query an Sixfold GraphQL...");
    const response = await axios.post(
      "https://app.sixfold.com/graphql",
      { query },
      { timeout: 15000, headers },
    );

    if (response?.data?.errors) {
      console.log("❌ GraphQL Error:", response.data.errors[0]?.message);
      return;
    }

    const tours =
      response?.data?.data?.viewer?.company?.tours?.tours?.edges || [];
    console.log("✅ Tours gefunden:", tours.length);

    // Suche nach Stops mit echten Zeiten
    let completedFound = false;
    tours.forEach((edge, tourIdx) => {
      const stops = edge?.node?.stops || [];
      stops.forEach((stop, stopIdx) => {
        if (
          stop.arrival_time ||
          stop.departure_time ||
          stop.status === "completed" ||
          stop.status === "in_progress"
        ) {
          if (!completedFound) {
            console.log(
              `\n🔍 FIRST COMPLETED STOP (Tour ${tourIdx}, Stop ${stopIdx}):`,
            );
            console.log(JSON.stringify(stop, null, 2));
            completedFound = true;
          }
        }
      });
    });

    if (!completedFound) {
      console.log("\n⚠️ Keine Stops mit echten Zeiten gefunden!");
      console.log("Alle Stops sind 'unvisited'");
      if (tours.length > 0 && tours[0]?.node?.stops?.length > 0) {
        console.log("\n(Zeige ersten Stop trotzdem zum Vergleich)");
        console.log(JSON.stringify(tours[0].node.stops[0], null, 2));
      }
    }
  } catch (error) {
    console.log("❌ Error:", error.message);
  }
}

test();

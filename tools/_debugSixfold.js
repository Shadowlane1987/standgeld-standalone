#!/usr/bin/env node
/**
 * DEBUG: Sixfold GraphQL Response inspizieren
 * Zeigt: Welche Felder liefert Sixfold wirklich?
 */

const axios = require("axios");

async function debugSixfold() {
  const companyId = "799";
  const sessionToken = "P0jKkIFx3HPT4cHdnLK8k715eZ-qC2ofe4zGj88UZMk";

  // Versuche verschiedene Feld-Varianten
  const queries = [
    {
      name: "VERSUCH 1: arrival_time & departure_time (baseline)",
      query: `{
        viewer {
          company(company_id: "${companyId}") {
            tours(role: CARRIER) {
              tours(first: 2) {
                edges {
                  node {
                    shipper_transport_number
                    stops {
                      type
                      arrival_time
                      departure_time
                    }
                  }
                }
              }
            }
          }
        }
      }`,
    },
    {
      name: "VERSUCH 2: planned_arrival + planned_departure",
      query: `{
        viewer {
          company(company_id: "${companyId}") {
            tours(role: CARRIER) {
              tours(first: 2) {
                edges {
                  node {
                    shipper_transport_number
                    stops {
                      type
                      planned_arrival
                      planned_departure
                    }
                  }
                }
              }
            }
          }
        }
      }`,
    },
    {
      name: "VERSUCH 3: status_events mit created_at",
      query: `{
        viewer {
          company(company_id: "${companyId}") {
            tours(role: CARRIER) {
              tours(first: 2) {
                edges {
                  node {
                    shipper_transport_number
                    stops {
                      type
                      status_events {
                        event_name
                        created_at
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
    },
    {
      name: "VERSUCH 4: ALLE verfügbaren Stop-Felder",
      query: `{
        viewer {
          company(company_id: "${companyId}") {
            tours(role: CARRIER) {
              tours(first: 1) {
                edges {
                  node {
                    shipper_transport_number
                    stops {
                      type
                      id
                      sequence
                      status
                      address {
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
    },
  ];

  const headers = {
    "Content-Type": "application/json",
    Cookie: `sessionToken=${sessionToken}; sixfold_lng=de`,
  };

  for (const { name, query } of queries) {
    console.log("\n" + "=".repeat(80));
    console.log("🔍", name);
    console.log("=".repeat(80));

    try {
      const response = await axios.post(
        "https://app.sixfold.com/graphql",
        { query },
        { timeout: 10000, headers },
      );

      if (response?.data?.errors) {
        console.log("❌ GraphQL Error:", response.data.errors[0]?.message);
        continue;
      }

      const data = response?.data?.data;
      console.log("✅ Response (formatiert):");
      console.log(JSON.stringify(data, null, 2).substring(0, 2000));
    } catch (error) {
      console.log("❌ HTTP Error:", error.message);
      if (error.response?.data?.errors) {
        console.log("   GraphQL:", error.response.data.errors);
      }
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("FERTIG");
  process.exit(0);
}

debugSixfold();

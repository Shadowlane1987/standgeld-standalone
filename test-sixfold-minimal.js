#!/usr/bin/env node
"use strict";

const axios = require("axios");

async function testSimpleQuery() {
  console.log("Testing simplest possible Sixfold query...\n");

  // Super minimal Query - keine Variablen
  const query = `{
    viewer {
      company(company_id: "799") {
        tours(role: CARRIER) {
          tours(first: 10) {
            edges {
              node {
                shipper_transport_number
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
    console.log("Query:", query.substring(0, 100) + "...\n");
    console.log("Sending to: https://app.sixfold.com/graphql\n");

    const response = await axios.post(
      "https://app.sixfold.com/graphql",
      { query },
      { timeout: 15000, headers },
    );

    console.log("Status:", response.status);
    console.log(
      "Response:",
      JSON.stringify(response.data, null, 2).substring(0, 500),
    );

    if (response?.data?.data?.viewer?.company?.tours?.tours?.edges) {
      const tours = response.data.data.viewer.company.tours.tours.edges;
      console.log(`\n✓ Success! Got ${tours.length} tours`);
      tours.slice(0, 3).forEach((edge, i) => {
        console.log(`  ${i + 1}. "${edge.node.shipper_transport_number}"`);
      });
    } else if (response?.data?.errors) {
      console.log("\n✗ GraphQL Errors:");
      response.data.errors.forEach((e) => console.log(`  - ${e.message}`));
    }
  } catch (err) {
    console.error("✗ Request failed:", err.message);
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error(
        "Data:",
        JSON.stringify(err.response.data).substring(0, 300),
      );
    }
  }
}

testSimpleQuery();

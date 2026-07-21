#!/usr/bin/env node

const axios = require("axios");

async function test() {
  try {
    console.log("[TEST] Checking route availability...\n");

    // Test 1: /api/billing/export (known to work)
    console.log("[1] GET /api/billing/export");
    try {
      const res1 = await axios.get("http://localhost:3100/api/billing/export", {
        timeout: 3000,
      });
      console.log(`    ✓ Status ${res1.status}\n`);
    } catch (err) {
      console.log(`    ✗ ${err.response?.status || err.code}\n`);
    }

    // Test 2: POST /api/sixfold/selective-match (new route)
    console.log("[2] POST /api/sixfold/selective-match (no body)");
    try {
      const res2 = await axios.post(
        "http://localhost:3100/api/sixfold/selective-match",
        Buffer.alloc(0),
        { timeout: 3000 },
      );
      console.log(`    ✓ Status ${res2.status}\n`);
    } catch (err) {
      console.log(`    Status: ${err.response?.status}`);
      console.log(`    Error: ${err.response?.data?.error || err.message}\n`);
    }

    // Test 3: Show all registered routes (if possible)
    console.log("[3] Server is running at http://localhost:3100");
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
  }
}

test().catch(console.error);

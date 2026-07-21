const axios = require("axios");
const {
  loadTransporeonExport,
} = require("../server/tools/readTransporeonExport");

function normalizeTransportNumber(tn) {
  if (!tn) return "";
  const str = String(tn).trim();
  const m = str.match(/(\d{10})$/);
  return m ? m[1] : str;
}

async function fetchRole(role) {
  const query = `{
    viewer {
      company(company_id: "799") {
        tours(role: ${role}) {
          tours(first: 500) {
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

  const res = await axios.post(
    "https://app.sixfold.com/graphql",
    { query },
    {
      timeout: 45000,
      headers: {
        "Content-Type": "application/json",
        Cookie:
          "sessionToken=P0jKkIFx3HPT4cHdnLK8k715eZ-qC2ofe4zGj88UZMk; sixfold_lng=de",
      },
    },
  );

  const edges = res?.data?.data?.viewer?.company?.tours?.tours?.edges || [];
  return edges
    .map((e) => normalizeTransportNumber(e?.node?.shipper_transport_number))
    .filter(Boolean);
}

(async () => {
  const transports = loadTransporeonExport(
    "data/captures/transporeon_export.xlsx",
  );
  const exportSet = new Set(
    transports
      .map((t) => normalizeTransportNumber(t.transport_number))
      .filter(Boolean),
  );

  for (const role of ["CARRIER", "SHIPPER"]) {
    try {
      const sixfold = await fetchRole(role);
      const sixSet = new Set(sixfold);
      let overlap = 0;
      for (const tn of sixSet) if (exportSet.has(tn)) overlap++;
      console.log(`${role}: sixfold=${sixSet.size}, overlap=${overlap}`);
      console.log(`${role} sample:`, Array.from(sixSet).slice(0, 12));
    } catch (e) {
      console.log(`${role}: error=${e.message}`);
    }
  }

  console.log("export sample:", Array.from(exportSet).slice(0, 12));
})();

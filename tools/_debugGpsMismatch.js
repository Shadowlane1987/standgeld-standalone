const axios = require("axios");
const {
  loadTransporeonExport,
} = require("../server/tools/readTransporeonExport");
const {
  buildGpsIndex,
  chooseArrival,
  chooseDeparture,
} = require("../server/normalize/exportBilling");
const { toUtcIso } = require("../server/normalize/datetime");

function normalizeTransportNumber(tn) {
  if (!tn) return "";
  const str = String(tn).trim();
  const match = str.match(/(\d{10})$/);
  return match ? match[1] : str;
}

const FLEET_STOP_FIELDS = `
  stop_id
  type
  status
  arrival_time
  departure_time
  estimated_arrival
  deadline
  timeslot { begin end timezone }
  location {
    position { lat lng }
  }
  status_events { event_name event_time created_at }
`;

function parseMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

async function fetchSixfoldStops() {
  const query = `{
    viewer {
      company(company_id: "799") {
        tours(role: CARRIER) {
          tours(first: 500) {
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

  const response = await axios.post(
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

  const tours =
    response?.data?.data?.viewer?.company?.tours?.tours?.edges || [];
  const out = [];
  for (const edge of tours) {
    const tn = String(edge?.node?.shipper_transport_number || "").trim();
    if (!tn) continue;
    const stops = Array.isArray(edge?.node?.stops) ? edge.node.stops : [];
    for (const stop of stops) {
      const events = Array.isArray(stop?.status_events)
        ? stop.status_events.map((e) => String(e?.event_name || ""))
        : [];
      out.push({
        transport_number: tn,
        type: String(stop?.type || "").toUpperCase(),
        arrival_time: stop?.arrival_time || null,
        departure_time: stop?.departure_time || null,
        position: {
          lat: Number(stop?.location?.position?.lat) || 0,
          lng: Number(stop?.location?.position?.lng) || 0,
        },
        gps: {
          arrival_verified: events.includes("APPROACH"),
          departure_verified: events.includes("DEPART"),
        },
      });
    }
  }
  return out;
}

(async () => {
  const transports = loadTransporeonExport(
    "data/captures/transporeon_export.xlsx",
  );
  const sixfoldStops = await fetchSixfoldStops();
  const gpsIndex = buildGpsIndex(sixfoldStops, { debug: false });

  console.log("sixfold_stops:", sixfoldStops.length);
  console.log("gps_index_size:", gpsIndex.size);

  const keys = Array.from(gpsIndex.keys());
  console.log("gps_keys_sample:", keys.slice(0, 10));

  let gpsEntryFound = 0;
  let gpsUsedWouldBe = 0;
  let missingXpTime = 0;

  for (const t of transports) {
    for (const [field, stopType] of [
      ["loading", "LOADING"],
      ["unloading", "UNLOADING"],
    ]) {
      const stop = t[field];
      if (!stop) continue;
      const normalizedTn = normalizeTransportNumber(t.transport_number);
      const gpsEntry = gpsIndex.get(`${normalizedTn}|${stopType}`);
      if (!gpsEntry) continue;
      gpsEntryFound++;

      const xpArrivalIso = toUtcIso(stop.arrival_local, "Europe/Berlin");
      const xpDepartureIso = toUtcIso(stop.departure_local, "Europe/Berlin");
      const gpsArrivalIso = gpsEntry.arrival_iso;
      const gpsDepartureIso = gpsEntry.departure_iso;

      const arrival = chooseArrival(xpArrivalIso, gpsArrivalIso);
      const departure = chooseDeparture(xpDepartureIso, gpsDepartureIso);

      if (!arrival.iso || !departure.iso) {
        missingXpTime++;
      }

      if (arrival.source === "GPS" || departure.source === "GPS") {
        gpsUsedWouldBe++;
      }
    }
  }

  console.log("gpsEntryFoundOnExportStops:", gpsEntryFound);
  console.log("gpsUsedWouldBe:", gpsUsedWouldBe);
  console.log("missingXpTimeOnMatched:", missingXpTime);

  // Show first mismatches by TN set overlap
  const exportSet = new Set(
    transports.map((t) => normalizeTransportNumber(t.transport_number)),
  );
  const sixfoldSet = new Set(
    sixfoldStops
      .map((s) => normalizeTransportNumber(s.transport_number))
      .filter(Boolean),
  );
  let overlap = 0;
  for (const tn of sixfoldSet) if (exportSet.has(tn)) overlap++;
  console.log("export_tn_count:", exportSet.size);
  console.log("sixfold_tn_count:", sixfoldSet.size);
  console.log("tn_overlap_count:", overlap);
})();

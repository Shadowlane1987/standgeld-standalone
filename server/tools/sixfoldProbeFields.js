"use strict";

/**
 * Sixfold-Feldproben OHNE Introspection (Apollo hat Introspection gesperrt).
 *
 * Trick: Man fragt viele Kandidaten-Felder gleichzeitig ab. Apollo validiert die
 * Query und liefert fuer JEDES unbekannte Feld einen Fehler
 *   'Cannot query field "X" on type "Stop". Did you mean "Y"?'
 * Die Kandidaten, die NICHT im Fehlerstrom auftauchen, existieren wirklich.
 * Zusaetzlich sammeln wir die "Did you mean"-Vorschlaege ein -- die verraten die
 * echten Nachbarfelder (z.B. Koordinaten-/Quell-Feld fuer die Fake-Erkennung).
 *
 * Es werden KEINE Daten gespeichert; nur Feld-Metadaten aus Fehlermeldungen.
 *
 * Nutzung (Session als Umgebungsvariable, nichts wird persistiert):
 *   $env:SIXFOLD_URL = "https://app.sixfold.com/companies/799/fleet/all/timeline"
 *   $env:SIXFOLD_SESSION_TOKEN = "<sessionToken-Wert>"
 *   node server/tools/sixfoldProbeFields.js
 */

const axios = require("axios");

// Runde 1 fand: Stop.status_events und location.position. Runde 2 bohrt in deren
// Unterfelder (Koordinaten + Zeit-Quelle fuer die Fake-Erkennung).
const POSITION_CANDIDATES = [
  "lat",
  "lon",
  "lng",
  "latitude",
  "longitude",
  "coordinates",
  "accuracy",
  "timestamp",
  "time",
  "heading",
  "speed",
  "source",
];

const STATUS_EVENT_CANDIDATES = [
  "event_time",
  "created_at",
  // Typ/Status des Events
  "event_type",
  "event_name",
  "event_code",
  "event_status",
  "status_type",
  "status_code",
  "code",
  "label",
  "title",
  "description",
  "message",
  "value",
  // Quelle/Methode (Fake-Signal)
  "source_name",
  "source_type",
  "origin",
  "origin_type",
  "producer",
  "reported_by",
  "created_by",
  "author",
  "trigger",
  "trigger_type",
  "detection",
  "is_actual",
  "actual",
  "is_automatic",
  "is_gps",
  "geofence",
  "within_geofence",
  "is_within_geofence",
  "distance",
  "distance_to_stop",
  "radius",
  "metadata",
  "payload",
  "data",
];

const METADATA_CANDIDATES = [
  "__typename",
  "event_source",
  "gps_source",
  "source_system",
  "system",
  "integration",
  "integration_id",
  "provider_name",
  "telematic",
  "telematics_provider",
  "device_id",
  "vehicle_id",
  "driver_id",
  "speed",
  "heading",
  "bearing",
  "altitude",
  "satellites",
  "gps_time",
  "gps_timestamp",
  "recorded_at",
  "received_at",
  "position_lat",
  "position_lng",
  "geo_lat",
  "geo_lng",
  "distance_meters",
  "distance_m",
  "distance_from_geofence_meters",
  "in_geofence",
  "geofence_status",
  "is_inside_geofence",
  "geofence_event",
  "trigger_source",
  "triggered_by",
  "input_method",
  "manual_reason",
  "manual_source",
  "edited",
  "is_edited",
  "is_estimated",
  "estimated",
  "predicted",
  "is_predicted",
  "confidence_score",
  "quality_score",
  "accuracy_meters",
  "user",
  "username",
  "user_email",
];

function originFromUrl(rawUrl) {
  return new URL(String(rawUrl || "").trim()).origin;
}

function companyIdFromUrl(rawUrl) {
  const m = String(rawUrl || "").match(/\/companies\/(\d+)\//);
  return m ? m[1] : null;
}

function stopsQuery(innerSelection) {
  return `
    query FieldProbe($companyId: String!) {
      viewer {
        company(company_id: $companyId) {
          tours(role: CARRIER) {
            tours(first: 1) {
              edges { node { stops { ${innerSelection} } } }
            }
          }
        }
      }
    }
  `;
}

function parseUnknown(errors) {
  const unknown = new Set();
  const suggestions = new Set();
  const leaf = [];
  const FIELD_RE = /Cannot query field "([^"]+)" on type "([^"]+)"/;
  const SUGGEST_RE = /Did you mean ([^?]+)\?/;
  const NEED_RE = /Field "([^"]+)" of type "([^"]+)" must have a sel/;
  for (const err of errors) {
    const msg = String(err?.message || "");
    const fm = msg.match(FIELD_RE);
    if (fm) unknown.add(fm[1]);
    const sm = msg.match(SUGGEST_RE);
    if (sm) {
      sm[1]
        .split(/,|\bor\b/)
        .map((s) => s.replace(/["'\s]/g, ""))
        .filter(Boolean)
        .forEach((s) => suggestions.add(s));
    }
    const nm = msg.match(NEED_RE);
    if (nm) leaf.push(`${nm[1]}: ${nm[2]} (Objekt -> Unterfelder noetig)`);
  }
  return { unknown, suggestions, leaf };
}

async function runProbe(post, candidates, wrap, label) {
  const query = stopsQuery(wrap(candidates.join(" ")));
  let response;
  try {
    response = await post(query);
  } catch (error) {
    console.log(
      `\n=== ${label}: Anfrage fehlgeschlagen (${error.message}) ===`,
    );
    return;
  }
  const errors = Array.isArray(response?.data?.errors)
    ? response.data.errors
    : [];
  const { unknown, suggestions, leaf } = parseUnknown(errors);
  const valid = candidates.filter((f) => !unknown.has(f));

  console.log(`\n=== ${label}: gueltige Felder ===`);
  console.log(valid.length ? "  " + valid.join("\n  ") : "  (keine)");
  if (leaf.length) {
    console.log(`--- ${label}: Objekt-Felder (brauchen Unterauswahl) ---`);
    leaf.forEach((l) => console.log("  " + l));
  }
  if (suggestions.size) {
    console.log(`--- ${label}: Apollo-Vorschlaege ---`);
    console.log("  " + Array.from(suggestions).join("\n  "));
  }
}

async function main() {
  const url = String(process.env.SIXFOLD_URL || "").trim();
  const sessionToken = String(process.env.SIXFOLD_SESSION_TOKEN || "").trim();
  const cookie =
    String(process.env.SIXFOLD_COOKIE || "").trim() ||
    (sessionToken ? `sessionToken=${sessionToken}; sixfold_lng=de` : "");
  const token = String(process.env.SIXFOLD_TOKEN || "").trim();

  if (!url || (!cookie && !token)) {
    console.error("Fehlt: SIXFOLD_URL und/oder SIXFOLD_SESSION_TOKEN.");
    process.exitCode = 1;
    return;
  }
  const companyId = companyIdFromUrl(url);
  if (!companyId) {
    console.error("Konnte company_id nicht aus der URL lesen.");
    process.exitCode = 1;
    return;
  }

  const origin = originFromUrl(url);
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;

  const post = (query) =>
    axios.post(
      `${origin}/graphql`,
      { query, variables: { companyId } },
      { timeout: 45000, headers, validateStatus: () => true },
    );
  const post2 = (query, variables) =>
    axios.post(
      `${origin}/graphql`,
      { query, variables },
      { timeout: 45000, headers, validateStatus: () => true },
    );

  console.log(`Feldprobe gegen ${origin}/graphql (company ${companyId}) ...`);

  await runProbe(
    post,
    POSITION_CANDIDATES,
    (inner) => `location { position { ${inner} } }`,
    "location.position",
  );
  await runProbe(
    post,
    STATUS_EVENT_CANDIDATES,
    (inner) => `status_events { ${inner} }`,
    "status_events",
  );
  await runProbe(
    post,
    METADATA_CANDIDATES,
    (inner) => `status_events { metadata { ${inner} } }`,
    "status_events.metadata",
  );

  // Echte Datenprobe mit den bestaetigten Feldern: zeigt die realen event_name-
  // Werte (GPS vs. manuell) und ob Koordinaten pro Stop vorliegen.
  const sampleQuery = `
    query Sample($companyId: String!) {
      viewer {
        company(company_id: $companyId) {
          tours(role: CARRIER) {
            tours(first: 500) {
              edges { node {
                shipper_transport_number
                stops {
                  type
                  status
                  arrival_time
                  departure_time
                  location { name position { lat lng } }
                  status_events { event_name event_time created_at }
                }
              } }
            }
          }
        }
      }
    }
  `;
  try {
    const res = await post(sampleQuery);
    if (Array.isArray(res?.data?.errors) && res.data.errors.length) {
      console.log("\nDatenprobe-Fehler:");
      res.data.errors.slice(0, 5).forEach((e) => console.log("  " + e.message));
    }
    const edges = res?.data?.data?.viewer?.company?.tours?.tours?.edges || [];
    const tours = edges.map((e) => e.node).filter(Boolean);
    let totalStops = 0;
    let stopsWithEvents = 0;
    let stopsWithArrival = 0;
    let stopsWithPos = 0;
    console.log(`\n=== Echte Datenprobe: ${tours.length} Touren ===`);
    const eventNames = new Set();
    const statusValues = new Set();
    let shown = 0;
    for (const tour of tours) {
      for (const stop of tour?.stops || []) {
        totalStops += 1;
        const evs = stop.status_events || [];
        if (evs.length) stopsWithEvents += 1;
        if (stop.arrival_time) stopsWithArrival += 1;
        const pos = stop.location?.position;
        if (pos && (pos.lat || pos.lng)) stopsWithPos += 1;
        statusValues.add(stop.status);
        evs.forEach((e) => eventNames.add(e.event_name));
        if (shown < 4 && (evs.length || stop.arrival_time)) {
          console.log(
            JSON.stringify(
              { tn: tour.shipper_transport_number, ...stop },
              null,
              2,
            ),
          );
          shown += 1;
        }
      }
    }
    console.log(
      `\nStopps: ${totalStops} | mit arrival_time: ${stopsWithArrival} | mit Position: ${stopsWithPos} | mit status_events: ${stopsWithEvents}`,
    );
    console.log("Status-Werte: " + Array.from(statusValues).join(", "));
    console.log("\n=== Alle vorkommenden event_name-Werte ===");
    console.log(
      eventNames.size
        ? "  " + Array.from(eventNames).join("\n  ")
        : "  (keine)",
    );
  } catch (error) {
    console.log(`\nDatenprobe fehlgeschlagen: ${error.message}`);
  }

  console.log("\nFertig. Es wurden keine Transportdaten gespeichert.");
}

main();

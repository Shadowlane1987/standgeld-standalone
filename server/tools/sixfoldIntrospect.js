"use strict";

/**
 * Sixfold-GraphQL-Schema-Probe (§ klein/testbar, keine Secrets im Repo).
 *
 * Zweck: Herausfinden, ob die Sixfold-API pro Stop doch Felder fuer
 * Koordinaten, Event-Quelle oder Lieferungs-/Referenznummer bereitstellt,
 * BEVOR irgendein Feldname in die produktive Query aufgenommen wird.
 *
 * Nutzung (Session NUR ueber Umgebungsvariablen, nichts wird gespeichert):
 *   $env:SIXFOLD_URL   = "https://.../companies/<id>/fleet/<group>/timeline"
 *   $env:SIXFOLD_COOKIE = "sessionToken=...; sixfold_lng=de"   # ODER
 *   $env:SIXFOLD_TOKEN  = "<bearer-token>"
 *   node server/tools/sixfoldIntrospect.js
 *
 * Es werden KEINE echten Transportdaten geladen, nur die Schema-Metadaten.
 */

const axios = require("axios");

const INTERESTING_FIELD =
  /(lat|lon|lng|geo|coord|position|point|address|delivery|reference|consignment|source|actor|user|event|status|timezone|arrival|departure|manual|provider|origin|telematic|telemetry|confidence|quality|accuracy|precision|method|automatic|tracking|carrier|connect|verified|gps|reported|detect)/i;
const INTERESTING_TYPE =
  /(stop|location|timeslot|geo|coordinate|address|event|delivery|reference|position|source|provider|method|quality|tracking|telematic)/i;

// Enum-Werte, die die Datenquelle (echtes GPS vs. manuell gesetzt) verraten.
// Genau hier steckt das Fake-Erkennungs-Signal am wahrscheinlichsten.
const SOURCE_ENUM =
  /(source|provider|method|origin|manual|automatic|gps|telematic|telemetry|quality|tracking|detect|reported)/i;

function originFromUrl(rawUrl) {
  const parsed = new URL(String(rawUrl || "").trim());
  return parsed.origin;
}

function unwrapTypeName(typeRef) {
  let current = typeRef;
  while (current && !current.name && current.ofType) {
    current = current.ofType;
  }
  return current?.name || current?.kind || "?";
}

const TYPE_REF_FRAGMENT = `
  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType { kind name }
      }
    }
  }
`;

const INTROSPECTION_QUERY = `
  query SchemaProbe {
    __schema {
      types {
        kind
        name
        fields(includeDeprecated: true) {
          name
          type { ...TypeRef }
        }
        enumValues(includeDeprecated: true) {
          name
          description
        }
      }
    }
  }
  ${TYPE_REF_FRAGMENT}
`;

async function main() {
  const url = String(process.env.SIXFOLD_URL || "").trim();
  const sessionToken = String(process.env.SIXFOLD_SESSION_TOKEN || "").trim();
  // Bequemlichkeit: aus dem reinen sessionToken denselben Cookie bauen wie die
  // App (public/app.js -> "sessionToken=...; sixfold_lng=de").
  const cookie =
    String(process.env.SIXFOLD_COOKIE || "").trim() ||
    (sessionToken ? `sessionToken=${sessionToken}; sixfold_lng=de` : "");
  const token = String(process.env.SIXFOLD_TOKEN || "").trim();

  if (!url) {
    console.error("Fehlt: SIXFOLD_URL (Fleet-Timeline-URL).");
    process.exitCode = 1;
    return;
  }
  if (!cookie && !token) {
    console.error(
      "Fehlt: SIXFOLD_SESSION_TOKEN (oder SIXFOLD_COOKIE / SIXFOLD_TOKEN).",
    );
    process.exitCode = 1;
    return;
  }

  let origin;
  try {
    origin = originFromUrl(url);
  } catch (_error) {
    console.error("SIXFOLD_URL ist keine gueltige URL.");
    process.exitCode = 1;
    return;
  }

  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;

  console.log(`Schema-Probe gegen ${origin}/graphql ...`);

  let response;
  try {
    response = await axios.post(
      `${origin}/graphql`,
      { query: INTROSPECTION_QUERY },
      { timeout: 25000, headers },
    );
  } catch (error) {
    const message =
      error?.response?.data?.errors?.[0]?.message ||
      error?.response?.data?.error ||
      error?.message ||
      "Unbekannter Fehler";
    console.error(`Anfrage fehlgeschlagen: ${message}`);
    if (error?.response?.status) {
      console.error(`HTTP-Status: ${error.response.status}`);
    }
    process.exitCode = 1;
    return;
  }

  if (Array.isArray(response?.data?.errors) && response.data.errors.length) {
    console.error("GraphQL-Fehler (Introspection evtl. deaktiviert):");
    response.data.errors.forEach((e) => console.error(`  - ${e?.message}`));
    process.exitCode = 1;
    return;
  }

  const types = response?.data?.data?.__schema?.types || [];
  if (!types.length) {
    console.error(
      "Keine Typen erhalten. Introspection wahrscheinlich gesperrt.",
    );
    process.exitCode = 1;
    return;
  }

  // 1) Relevante Objekt-Typen komplett auflisten.
  console.log("\n=== Relevante Typen und Felder ===");
  let printedType = false;
  for (const type of types) {
    if (type.kind !== "OBJECT") continue;
    if (!type.name || type.name.startsWith("__")) continue;
    if (!INTERESTING_TYPE.test(type.name)) continue;
    const fields = type.fields || [];
    if (!fields.length) continue;
    printedType = true;
    console.log(`\n${type.name}`);
    for (const field of fields) {
      console.log(`  ${field.name}: ${unwrapTypeName(field.type)}`);
    }
  }
  if (!printedType) {
    console.log("  (keine Typen mit passenden Namen gefunden)");
  }

  // 2) Alle Felder, deren Name auf gesuchte Daten hindeutet.
  console.log("\n=== Felder mit interessantem Namen (typweit) ===");
  let printedField = false;
  for (const type of types) {
    if (type.kind !== "OBJECT") continue;
    if (!type.name || type.name.startsWith("__")) continue;
    for (const field of type.fields || []) {
      if (!INTERESTING_FIELD.test(field.name)) continue;
      printedField = true;
      console.log(
        `  ${type.name}.${field.name}: ${unwrapTypeName(field.type)}`,
      );
    }
  }
  if (!printedField) {
    console.log("  (keine passenden Feldnamen gefunden)");
  }

  // 3) ENUMs mit ihren Werten - hier steckt das Signal manuell vs. GPS.
  //    Zuerst die verdaechtigen (Name deutet auf Quelle/Methode/Qualitaet),
  //    dann alle uebrigen Enums, deren WERTE nach MANUAL/GPS/TELEMATICS aussehen.
  const enums = types.filter(
    (t) =>
      t.kind === "ENUM" &&
      t.name &&
      !t.name.startsWith("__") &&
      Array.isArray(t.enumValues) &&
      t.enumValues.length,
  );

  console.log(
    "\n=== Enums, die die Datenquelle (GPS vs. manuell) verraten ===",
  );
  let printedEnum = false;
  for (const type of enums) {
    const values = type.enumValues.map((v) => v.name);
    const nameHit = SOURCE_ENUM.test(type.name);
    const valueHit = values.some((v) => SOURCE_ENUM.test(v));
    if (!nameHit && !valueHit) continue;
    printedEnum = true;
    console.log(`\n${type.name}`);
    for (const v of type.enumValues) {
      const mark = SOURCE_ENUM.test(v.name) ? " <==" : "";
      const desc = v.description ? `  // ${v.description}` : "";
      console.log(`  ${v.name}${mark}${desc}`);
    }
  }
  if (!printedEnum) {
    console.log("  (keine quellenbezogenen Enums gefunden)");
  }

  console.log("\nFertig. Es wurden keine Transportdaten geladen/gespeichert.");
}

main();

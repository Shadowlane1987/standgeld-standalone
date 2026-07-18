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
  /(lat|lon|lng|geo|coord|position|point|address|delivery|reference|consignment|source|actor|user|event|status|timezone|arrival|departure)/i;
const INTERESTING_TYPE =
  /(stop|location|timeslot|geo|coordinate|address|event|delivery|reference|position)/i;

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
      }
    }
  }
  ${TYPE_REF_FRAGMENT}
`;

async function main() {
  const url = String(process.env.SIXFOLD_URL || "").trim();
  const cookie = String(process.env.SIXFOLD_COOKIE || "").trim();
  const token = String(process.env.SIXFOLD_TOKEN || "").trim();

  if (!url) {
    console.error("Fehlt: SIXFOLD_URL (Fleet-Timeline-URL).");
    process.exitCode = 1;
    return;
  }
  if (!cookie && !token) {
    console.error("Fehlt: SIXFOLD_COOKIE oder SIXFOLD_TOKEN (Session).");
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

  console.log("\nFertig. Es wurden keine Transportdaten geladen/gespeichert.");
}

main();

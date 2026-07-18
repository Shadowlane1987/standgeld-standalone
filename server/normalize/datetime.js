"use strict";

/**
 * Zeitzonenbewusste UTC-Umrechnung fuer Standgeld (§7, §9).
 *
 * Problem: Das Event-Grid liefert Zeiten als naive Wanduhr-Strings
 * ("2026-07-16 09:30") MIT separater IANA-Zeitzone (Europe/Berlin, Etc/UTC,
 * Europe/Amsterdam). Ohne Beruecksichtigung der Zeitzone wuerde new Date(str)
 * die Zeit in der MASCHINEN-Zeitzone interpretieren -> auf Render (UTC) falsch.
 *
 * Diese Datei nutzt ausschliesslich die native Intl-API (Node 24 hat volles
 * ICU) -- keine externe Abhaengigkeit. Reine, unit-testbare Funktionen.
 */

/**
 * Ermittelt den Offset (ms) einer IANA-Zeitzone fuer einen konkreten UTC-Moment.
 * offset = (Wanduhrzeit in tz) - (UTC-Zeit). Fuer CEST z.B. +7200000.
 *
 * @param {number} utcMs
 * @param {string} timeZone - IANA-Zone
 * @returns {number} Offset in Millisekunden
 */
function zoneOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    parts[part.type] = part.value;
  }
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtc - utcMs;
}

/**
 * Rechnet eine Wanduhrzeit (Datum/Zeit-Komponenten) in einer IANA-Zeitzone in
 * einen UTC-Zeitpunkt (ms) um. Zwei Durchlaeufe fuer korrekte DST-Randfaelle.
 *
 * @param {{y:number, mo:number, d:number, h:number, mi:number, s:number}} c
 * @param {string} timeZone
 * @returns {number} UTC-Millisekunden
 */
function zonedWallTimeToUtcMs(c, timeZone) {
  const guess = Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi, c.s);
  const offset1 = zoneOffsetMs(guess, timeZone);
  // Verfeinerung: Offset am geschaetzten UTC-Moment erneut bestimmen (DST).
  const offset2 = zoneOffsetMs(guess - offset1, timeZone);
  return guess - offset2;
}

/**
 * Parst einen naiven Wanduhr-String "YYYY-MM-DD[ T]HH:MM[:SS]".
 * Gibt null zurueck, wenn das Format nicht passt.
 *
 * @param {string} text
 * @returns {{y:number, mo:number, d:number, h:number, mi:number, s:number}|null}
 */
function parseWallClock(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    String(text || "").trim(),
  );
  if (!m) return null;
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: m[6] ? Number(m[6]) : 0,
  };
}

/**
 * Prueft, ob ein String bereits eine explizite Zeitzonenangabe traegt
 * (endstaendiges Z oder +HH:MM / -HH:MM Offset nach der Uhrzeit).
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasExplicitOffset(text) {
  return /\d[Tt ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(
    String(text || "").trim(),
  );
}

/**
 * Prueft, ob eine IANA-Zeitzone gueltig ist.
 *
 * @param {unknown} timeZone
 * @returns {boolean}
 */
function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== "string") return false;
  try {
    // Wirft RangeError bei ungueltiger Zone.
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Hauptfunktion: wandelt einen beliebigen Zeitwert in einen UTC-ISO-String um.
 *
 * Regeln:
 * - Date/endliche Zahl/epoch-millis-String -> direkt.
 * - String mit explizitem Offset/Z -> new Date().
 * - Naiver Wanduhr-String + gueltige timeZone -> zeitzonenbewusste Umrechnung.
 * - Naiver Wanduhr-String OHNE timeZone -> als UTC interpretiert (deterministisch,
 *   keine Maschinen-Abhaengigkeit).
 * - Sonst -> null (nichts wird erfunden).
 *
 * @param {unknown} value
 * @param {string|null} [timeZone]
 * @returns {string|null} ISO-8601 in UTC oder null
 */
function toUtcIso(value, timeZone = null) {
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const text = String(value).trim();
  if (!text) return null;

  // Rein numerische Strings als epoch-millis behandeln.
  if (/^\d{10,}$/.test(text)) {
    const d = new Date(Number(text));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Bereits mit Offset/Z -> direkt interpretierbar.
  if (hasExplicitOffset(text)) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Naive Wanduhrzeit.
  const wall = parseWallClock(text);
  if (wall) {
    if (isValidTimeZone(timeZone)) {
      const ms = zonedWallTimeToUtcMs(wall, timeZone);
      return new Date(ms).toISOString();
    }
    // Ohne (gueltige) Zone: deterministisch als UTC interpretieren.
    const ms = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s);
    return new Date(ms).toISOString();
  }

  // Letzter Versuch: nativer Parser (z.B. RFC-Datumsformate).
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

module.exports = {
  zoneOffsetMs,
  zonedWallTimeToUtcMs,
  parseWallClock,
  hasExplicitOffset,
  isValidTimeZone,
  toUtcIso,
};

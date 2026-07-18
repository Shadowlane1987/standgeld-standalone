"use strict";

/**
 * Parser fuer die Transporeon-Transportliste
 * (POST /UiService/GetBookingsWithoutOccupiedForCarrier).
 *
 * Zweck: Die verifizierte JSON-Antwort in eine schlanke, stabile Struktur
 * ueberfuehren. Reine Funktionen, keine Netzwerkzugriffe, gut testbar.
 *
 * WICHTIG (Kern der App): Diese Liste liefert die GEPLANTEN Zeitfenster und die
 * von der Ladestelle gesetzten (TP-XP) Stammdaten. Sie enthaelt NICHT die
 * VisibilityHubUser-Ist-Zeiten oder GPS-Koordinaten pro Event. Diese kommen aus
 * der Event-/Detail-Ansicht und werden separat verarbeitet.
 */

// Reihenfolge nach fachlicher Prioritaet: SAP-/Lieferungsnummer zuerst.
const DELIVERY_KEYS = [
  "sapDeliveryNumber",
  "SapCode",
  "DeliveryNo",
  "DeliveryNos",
  "deliveryNumber",
];

const ORDER_KEYS = ["OrderNumber", "sapOrderNumber", "customerOrderNumber"];

function toStringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

/**
 * Wandelt das .NET-Datumsformat "/Date(1784268000000+0200)/" in Bestandteile um.
 * Gibt { epochMs, offsetMinutes, iso } zurueck oder null.
 */
function parseDotNetDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
  if (!match) return null;

  const epochMs = Number(match[1]);
  if (!Number.isFinite(epochMs)) return null;

  let offsetMinutes = null;
  if (match[2]) {
    const sign = match[2][0] === "-" ? -1 : 1;
    const hours = Number(match[2].slice(1, 3));
    const mins = Number(match[2].slice(3, 5));
    offsetMinutes = sign * (hours * 60 + mins);
  }

  return {
    epochMs,
    offsetMinutes,
    iso: new Date(epochMs).toISOString(),
  };
}

/**
 * Baut eine Map aus BookingExtension.BookingExtensionEntries ({Key,Value}[]).
 */
function extensionToMap(booking) {
  const entries = booking?.BookingExtension?.BookingExtensionEntries;
  const map = new Map();
  if (!Array.isArray(entries)) return map;
  for (const entry of entries) {
    const key = toStringOrNull(entry?.Key);
    if (!key) continue;
    // Erste Belegung gewinnt (Transporeon liefert Keys i.d.R. eindeutig).
    if (!map.has(key)) map.set(key, entry?.Value ?? null);
  }
  return map;
}

/**
 * Waehlt den ersten nicht-leeren Wert aus einer Prioritaetsliste von Keys.
 */
function pickFromMap(map, keys) {
  for (const key of keys) {
    if (!map.has(key)) continue;
    const value = toStringOrNull(map.get(key));
    if (value) return value;
  }
  return null;
}

/**
 * Normalisiert eine einzelne Buchung (= ein Stopp an einem Standort/Gate).
 */
function normalizeBooking(booking) {
  const ext = extensionToMap(booking);

  const from = parseDotNetDate(booking?.From);
  const to = parseDotNetDate(booking?.To);

  const latitude = toStringOrNull(booking?.LatitudeForExport);
  const longitude = toStringOrNull(booking?.LongitudeForExport);

  return Object.freeze({
    tour_id: toStringOrNull(booking?.TourId),
    tour_number: toStringOrNull(booking?.TourNumber),
    transport_number:
      toStringOrNull(booking?.TransportNumber) ||
      toStringOrNull(ext.get("TransportNumber")) ||
      toStringOrNull(booking?.TourNumber),
    booking_id: toStringOrNull(booking?.Id),
    open_booking_id: toStringOrNull(booking?.OpenBookingId),

    // Geplantes Zeitfenster (Ladestelle). Ist-Zeiten kommen NICHT aus der Liste.
    window_from_iso: from?.iso || null,
    window_to_iso: to?.iso || null,
    window_from_local: toStringOrNull(booking?.StrFrom),
    window_to_local: toStringOrNull(booking?.StrTo),
    window_offset_minutes: from?.offsetMinutes ?? to?.offsetMinutes ?? null,

    location_id: toStringOrNull(booking?.LocationId),
    gate_id: toStringOrNull(booking?.GateId),
    // Aus der Liste meist leer; wenn vorhanden, nur Rohwert (keine GPS-Pruefung hier).
    location_latitude: latitude,
    location_longitude: longitude,
    location_timezone: toStringOrNull(booking?.TimezoneForExport),

    // Fahrer-/Fahrzeugstammdaten (in der Liste oft leer).
    vehicle_plate: toStringOrNull(booking?.VehicleLicencePlate),
    trailer_plate: toStringOrNull(booking?.VehicleTrailerLicencePlate),
    driver_name:
      toStringOrNull(booking?.VehicleDriverName) ||
      toStringOrNull(ext.get("DriverName")),

    // Fachlich wichtige Zusatzfelder.
    delivery_number: pickFromMap(ext, DELIVERY_KEYS),
    order_number: pickFromMap(ext, ORDER_KEYS),
    consignee: toStringOrNull(ext.get("Consignee")),
    consignee_number: toStringOrNull(ext.get("ConsigneeNumber")),
    weight: toStringOrNull(ext.get("Weight")),
    comment: toStringOrNull(ext.get("Comment")),

    loading_address: toStringOrNull(ext.get("loadingAddress")),
    loading_city: toStringOrNull(ext.get("loadingCity")),
    loading_zip: toStringOrNull(ext.get("loadingZIP")),
    loading_country: toStringOrNull(ext.get("loadingCountry")),
    unloading_address: toStringOrNull(ext.get("unloadingAddress")),
    unloading_city: toStringOrNull(ext.get("unloadingCity")),
    unloading_zip: toStringOrNull(ext.get("unloadingZIP")),
    unloading_country: toStringOrNull(ext.get("unloadingCountry")),

    is_completed: Boolean(booking?.IsCompleted),
  });
}

/**
 * Parst die komplette Listen-Antwort (Objekt ODER JSON-String).
 * Gibt { status, bookings } zurueck.
 */
function parseBookingsResponse(input) {
  let data = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch (_error) {
      return { status: null, bookings: [] };
    }
  }

  const rawBookings = Array.isArray(data?.Bookings) ? data.Bookings : [];
  return {
    status: data?.Status ?? null,
    bookings: rawBookings.map((booking) => normalizeBooking(booking)),
  };
}

module.exports = {
  DELIVERY_KEYS,
  ORDER_KEYS,
  parseDotNetDate,
  extensionToMap,
  normalizeBooking,
  parseBookingsResponse,
};

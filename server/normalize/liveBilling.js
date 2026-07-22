"use strict";

const { computeStandgeld } = require("./standgeld");
const {
  chooseArrival,
  chooseDeparture,
  normalizeLicensePlate,
  normalizeTransportNumber,
} = require("./exportBilling");
const { EVENT_CATEGORY, SOURCE_TYPE } = require("./events");
const { toUtcIso } = require("./datetime");

const DEFAULT_TZ = "Europe/Berlin";
const STOP_TYPES = Object.freeze([
  ["loading", "LOADING"],
  ["unloading", "UNLOADING"],
]);

function eventStopType(category) {
  if (
    category === EVENT_CATEGORY.LOAD_ARRIVAL ||
    category === EVENT_CATEGORY.LOAD_DEPARTURE
  ) {
    return "LOADING";
  }
  if (
    category === EVENT_CATEGORY.UNLOAD_ARRIVAL ||
    category === EVENT_CATEGORY.UNLOAD_DEPARTURE
  ) {
    return "UNLOADING";
  }
  return null;
}

function isArrivalCategory(category) {
  return (
    category === EVENT_CATEGORY.LOAD_ARRIVAL ||
    category === EVENT_CATEGORY.UNLOAD_ARRIVAL
  );
}

function parseMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function formatLocalWall(iso, timeZone = DEFAULT_TZ) {
  const ms = Date.parse(String(iso || ""));
  if (Number.isNaN(ms)) return null;

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(ms))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  if (
    !parts.year ||
    !parts.month ||
    !parts.day ||
    !parts.hour ||
    !parts.minute
  ) {
    return null;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function mergeEventChoice(prev, event, mode) {
  if (!event?.event_time) return prev;
  if (!prev) {
    return {
      iso: event.event_time,
      local: formatLocalWall(event.event_time, event.timezone || DEFAULT_TZ),
      timezone: event.timezone || DEFAULT_TZ,
    };
  }

  const chosen =
    mode === "arrival"
      ? chooseArrival(prev.iso, event.event_time)
      : chooseDeparture(prev.iso, event.event_time);

  if (chosen.iso === prev.iso) return prev;
  return {
    iso: event.event_time,
    local: formatLocalWall(event.event_time, event.timezone || DEFAULT_TZ),
    timezone: event.timezone || DEFAULT_TZ,
  };
}

function buildXpIndex(events) {
  const index = new Map();

  for (const event of events || []) {
    if (event?.source_type !== SOURCE_TYPE.TP_XP) continue;

    const tn = String(event?.transport_number || "").trim();
    const stopType = eventStopType(event?.event_category);
    if (!tn || !stopType) continue;

    const exactKey = `EXACT:${tn}|${stopType}`;
    const normalizedTn = normalizeTransportNumber(tn);
    const normKey = `NORM:${normalizedTn}|${stopType}`;
    const mode = isArrivalCategory(event.event_category)
      ? "arrival"
      : "departure";

    const merge = (prev) => {
      const next = {
        arrival: prev?.arrival || null,
        departure: prev?.departure || null,
      };
      if (mode === "arrival") {
        next.arrival = mergeEventChoice(next.arrival, event, mode);
      } else {
        next.departure = mergeEventChoice(next.departure, event, mode);
      }
      return next;
    };

    index.set(exactKey, merge(index.get(exactKey)));
    index.set(normKey, merge(index.get(normKey)));
  }

  return index;
}

function lookupXpEntry(xpIndex, transportNumber, stopType) {
  if (!(xpIndex instanceof Map)) return null;

  const exactTn = String(transportNumber || "").trim();
  const normalizedTn = normalizeTransportNumber(transportNumber);

  return (
    xpIndex.get(`EXACT:${exactTn}|${stopType}`) ||
    xpIndex.get(`NORM:${normalizedTn}|${stopType}`) ||
    null
  );
}

function billFromLiveData(transports, xpEvents, options = {}) {
  const tz = options.timezone || DEFAULT_TZ;
  const config = options.config || {};
  const gpsIndex = options.gpsIndex instanceof Map ? options.gpsIndex : null;
  const gpsChecked = gpsIndex !== null;
  const xpIndex = buildXpIndex(xpEvents);
  const stops = [];

  for (const transport of transports || []) {
    for (const [field, stopType] of STOP_TYPES) {
      const stop = transport?.[field];
      if (!stop) continue;

      const windowIso = toUtcIso(stop.window_local, tz);
      const xpEntry = lookupXpEntry(
        xpIndex,
        transport.transport_number,
        stopType,
      );
      const xpArrivalIso = xpEntry?.arrival?.iso || null;
      const xpDepartureIso = xpEntry?.departure?.iso || null;

      const exactTn = String(transport.transport_number || "").trim();
      const normalizedTn = normalizeTransportNumber(transport.transport_number);
      let gpsEntry = null;
      if (gpsIndex) {
        gpsEntry = gpsIndex.get(`EXACT:${exactTn}|${stopType}`) || null;
        if (!gpsEntry) {
          const fallback =
            gpsIndex.get(`NORM:${normalizedTn}|${stopType}`) || null;
          gpsEntry = fallback && !fallback.ambiguous_match ? fallback : null;
        }
      }

      const excelLicensePlate =
        (transport.vehicle_registration || "").trim() || null;
      const sixfoldLicensePlate = gpsEntry?.license_plate || null;
      const hasExcelPlate = Boolean(excelLicensePlate);
      const hasSixfoldPlate = Boolean(sixfoldLicensePlate);
      const licensePlateValid =
        hasExcelPlate &&
        hasSixfoldPlate &&
        normalizeLicensePlate(sixfoldLicensePlate) ===
          normalizeLicensePlate(excelLicensePlate);

      const gpsAvailable = Boolean(
        gpsEntry && gpsEntry.present && licensePlateValid,
      );
      const gpsArrivalIso = gpsAvailable ? gpsEntry?.arrival_iso : null;
      const gpsDepartureIso = gpsAvailable ? gpsEntry?.departure_iso : null;

      const arrivalChoice = chooseArrival(xpArrivalIso, gpsArrivalIso);
      const departureChoice = chooseDeparture(xpDepartureIso, gpsDepartureIso);

      const fee = computeStandgeld(
        {
          arrival_time: arrivalChoice.iso,
          departure_time: departureChoice.iso,
          window_start: windowIso,
          transport_number: transport.transport_number,
          stop_type: stopType,
          arrival_gps_verified: arrivalChoice.source === "GPS",
        },
        config,
      );

      stops.push(
        Object.freeze({
          ...fee,
          window_local: stop.window_local,
          unload_window_fallback_applied:
            stopType === "UNLOADING"
              ? Boolean(stop.unload_window_fallback_applied)
              : false,
          unload_window_fallback_reason:
            stopType === "UNLOADING"
              ? String(stop.unload_window_fallback_reason || "") || null
              : null,
          arrival_local: xpEntry?.arrival?.local || null,
          departure_local: xpEntry?.departure?.local || null,
          timezone:
            xpEntry?.arrival?.timezone || xpEntry?.departure?.timezone || tz,
          excel_license_plate: excelLicensePlate,
          gps_license_plate: sixfoldLicensePlate,
          gps_plate_match: licensePlateValid,
          gps_checked: gpsChecked,
          gps_available: gpsAvailable,
          gps_missing: gpsChecked && !gpsAvailable,
          arrival_source: arrivalChoice.source,
          departure_source: departureChoice.source,
          arrival_time_used: arrivalChoice.iso,
          departure_time_used: departureChoice.iso,
          xp_arrival_time: xpArrivalIso,
          xp_departure_time: xpDepartureIso,
          gps_arrival_time: gpsArrivalIso,
          gps_departure_time: gpsDepartureIso,
          xp_missing: !xpArrivalIso && !xpDepartureIso,
        }),
      );
    }
  }

  const chargeable = stops.filter((stop) => stop.fee_eur > 0);
  const review = stops.filter((stop) => stop.needs_review);
  const gpsUsed = stops.filter(
    (stop) => stop.arrival_source === "GPS" || stop.departure_source === "GPS",
  );
  const mixedSourceCount = stops.filter(
    (stop) => stop.arrival_source !== stop.departure_source,
  ).length;
  const gpsMissing = stops.filter((stop) => stop.gps_missing);
  const xpMissing = stops.filter((stop) => stop.xp_missing).length;
  const rebookingSuspectedCount = stops.filter(
    (stop) => stop.rebooking_suspected,
  ).length;
  // Prueffaelle bleiben sichtbar/abrechenbar markiert, gehen aber nicht in die Gesamtsumme.
  const totalFee = stops.reduce(
    (sum, stop) => sum + (stop.needs_review ? 0 : stop.fee_eur || 0),
    0,
  );

  return {
    stops,
    summary: {
      transport_count: (transports || []).length,
      stop_count: stops.length,
      chargeable_count: chargeable.length,
      review_count: review.length,
      gps_checked: gpsChecked,
      gps_used_count: gpsUsed.length,
      gps_missing_count: gpsMissing.length,
      mixed_source_count: mixedSourceCount,
      xp_missing_count: xpMissing,
      rebooking_suspected_count: rebookingSuspectedCount,
      total_fee_eur: totalFee,
    },
  };
}

module.exports = {
  buildXpIndex,
  billFromLiveData,
};

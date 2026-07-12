const path = require("path");
const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3100);

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const MAX_EFFECTIVE_MINUTES = 14 * 60;

function toDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatEuro(value) {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : toDate(value);
  if (!date || Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function canonicalStopType(value) {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  if (["load", "loading", "beladung"].includes(normalized)) return "load";
  if (["unload", "unloading", "entladung"].includes(normalized))
    return "unload";
  return normalized;
}

function last7Digits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 7) return "";
  return digits.slice(-7);
}

function extractFleetTimelineContextFromUrl(urlValue) {
  try {
    const parsedUrl = new URL(String(urlValue || "").trim());
    const match = parsedUrl.pathname.match(
      /\/companies\/(\d+)\/fleet\/(\d+)\/timeline/i,
    );
    if (!match) return null;
    return {
      origin: parsedUrl.origin,
      companyId: String(match[1] || "").trim(),
      vehicleGroupId: String(match[2] || "").trim(),
    };
  } catch (_error) {
    return null;
  }
}

function buildEvaluationWindow(period, referenceDateValue) {
  const normalizedPeriod =
    String(period || "day").toLowerCase() === "week" ? "week" : "day";
  const raw = String(referenceDateValue || "").trim();
  const parsed = raw ? new Date(`${raw}T00:00:00`) : new Date();
  const ref = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  ref.setHours(0, 0, 0, 0);

  const from = new Date(ref);
  const to = new Date(ref);
  to.setDate(to.getDate() + (normalizedPeriod === "week" ? 7 : 1));

  return {
    period: normalizedPeriod,
    referenceDate: `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, "0")}-${String(ref.getDate()).padStart(2, "0")}`,
    fromTime: from.toISOString(),
    toTime: to.toISOString(),
  };
}

function normalizeFleetStops(tour) {
  const stops = Array.isArray(tour?.stops) ? tour.stops : [];
  return stops.map((stop, index) => ({
    order: index + 1,
    stop_id: stop?.stop_id || null,
    type: stop?.type || null,
    status: stop?.status || null,
    booking_location:
      stop?.location?.bookingLocationName || stop?.location?.name || null,
    address:
      stop?.location?.address?.full_address ||
      stop?.location?.customerProvidedAddress?.full_address ||
      null,
    timeslot_begin: stop?.timeslot?.begin || null,
    timeslot_end: stop?.timeslot?.end || null,
    arrival_time: stop?.arrival_time || null,
    departure_time: stop?.departure_time || null,
    transport_number: tour?.shipper_transport_number || null,
    tour_id: tour?.tour_id || null,
    plate: tour?.plate || null,
  }));
}

async function fetchFleetTimelineStops(url, options = {}) {
  const context = extractFleetTimelineContextFromUrl(url);
  if (!context?.companyId || !context?.vehicleGroupId) {
    throw new Error("Fleet-Timeline-Kontext konnte nicht gelesen werden.");
  }

  const headers = { "Content-Type": "application/json" };
  const cookie = String(options.sessionCookie || "").trim();
  const token = String(options.authToken || "").trim();
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;

  const fleetQuery = `
    query FleetGroupStandgeldBatch(
      $companyId: String!
      $vehicleGroupId: String!
      $fromTime: DateTime!
      $toTime: DateTime!
    ) {
      viewer {
        company(company_id: $companyId) {
          companyVehicleGroup(companyVehicleGroupId: $vehicleGroupId) {
            vehiclesConnection {
              vehicles(first: 250) {
                edges {
                  node {
                    license_plate_number
                    tours(fromTime: $fromTime, toTime: $toTime) {
                      tour_id
                      shipper_transport_number
                      status
                      working_stop_id
                      stops {
                        stop_id
                        type
                        status
                        arrival_time
                        departure_time
                        estimated_arrival
                        deadline
                        timeslot {
                          begin
                          end
                          timezone
                        }
                        location {
                          name
                          bookingLocationName
                          gate
                          address {
                            full_address
                          }
                          customerProvidedAddress {
                            full_address
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await axios.post(
    `${context.origin}/graphql`,
    {
      query: fleetQuery,
      variables: {
        companyId: context.companyId,
        vehicleGroupId: context.vehicleGroupId,
        fromTime: options.fromTime,
        toTime: options.toTime,
      },
    },
    { timeout: 25000, headers },
  );

  const edges =
    response?.data?.data?.viewer?.company?.companyVehicleGroup
      ?.vehiclesConnection?.vehicles?.edges || [];

  const tours = [];
  edges.forEach((edge) => {
    const node = edge?.node || null;
    (node?.tours || []).forEach((tour) => {
      tours.push({
        ...tour,
        plate: node?.license_plate_number || null,
      });
    });
  });

  return {
    source: {
      url,
      company_id: context.companyId,
      vehicle_group_id: context.vehicleGroupId,
    },
    tours,
    stops: tours.flatMap((tour) => normalizeFleetStops(tour)),
  };
}

function parseTimeToken(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{1,2}:\d{2}$/.test(text)) return text;
  if (/^\d{1,2}\.\d{2}$/.test(text)) return text.replace(".", ":");
  if (/^0[\.,]\d+$/.test(text)) {
    const normalized = text.replace(",", ".");
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1) return "";
    const totalMinutes = Math.round(numeric * 24 * 60);
    const hh = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
    const mm = String(totalMinutes % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  return "";
}

function resolveWindowDateTime(value, anchorDate) {
  const text = String(value || "").trim();
  if (!text) return null;

  const direct = toDate(text);
  if (direct) return direct;

  const hm = parseTimeToken(text);
  if (!hm) return null;

  const [h, m] = hm.split(":").map(Number);
  const anchor = anchorDate instanceof Date ? new Date(anchorDate) : new Date();
  anchor.setHours(h, m, 0, 0);
  return anchor;
}

function matchTimeWindow(windowRow, stop) {
  const rowType = canonicalStopType(windowRow?.stop_type);
  const stopType = canonicalStopType(stop?.type);
  if (!rowType) return -1;
  if (rowType !== "any" && rowType !== stopType) return -1;

  const stopKeys = [stop.transport_number, stop.tour_id]
    .map((value) => last7Digits(value))
    .filter(Boolean);
  const rowKeys = [
    windowRow?.cola_number,
    windowRow?.load_number,
    windowRow?.route_key,
    windowRow?.transport_number,
    windowRow?.tour_id,
  ]
    .map((value) => last7Digits(value))
    .filter(Boolean);

  if (!stopKeys.length || !rowKeys.length) return -1;
  if (!rowKeys.some((key) => stopKeys.includes(key))) return -1;

  let score = 80;
  const stopLocation = normalizeText(
    [stop.booking_location, stop.address].filter(Boolean).join(" "),
  );
  const rowLocation = normalizeText(windowRow?.location || "");
  if (rowLocation) {
    const ok =
      stopLocation.includes(rowLocation) || rowLocation.includes(stopLocation);
    score += ok ? 4 : -2;
  }
  return score;
}

function applyTimeWindowOverride(stop, windows) {
  const rows = Array.isArray(windows) ? windows : [];
  if (!rows.length) return stop;

  let best = null;
  let bestScore = -1;
  rows.forEach((row) => {
    const score = matchTimeWindow(row, stop);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  });

  if (!best || bestScore < 0) return stop;

  const anchor =
    toDate(stop.arrival_time) || toDate(stop.departure_time) || new Date();
  const start = resolveWindowDateTime(best.window_start, anchor);
  const end = resolveWindowDateTime(best.window_end, anchor);
  if (!start && !end) return stop;

  return {
    ...stop,
    timeslot_begin: start ? start.toISOString() : stop.timeslot_begin || null,
    timeslot_end: end ? end.toISOString() : stop.timeslot_end || null,
    window_override_applied: true,
    matched_window_key:
      best.cola_number ||
      best.load_number ||
      best.route_key ||
      best.transport_number ||
      best.tour_id ||
      null,
  };
}

function calculateWithSafeOverride(stop, rules, windows) {
  const base = calcStop(stop, rules);
  const overriddenStop = applyTimeWindowOverride(stop, windows);
  const overridden = calcStop(overriddenStop, rules);

  const baseBillable = Number(base.billable_minutes || 0);
  const overrideBillable = Number(overridden.billable_minutes || 0);

  if (overrideBillable <= baseBillable) {
    return overridden;
  }

  return {
    ...base,
    window_override_applied: false,
    matched_window_key: null,
    override_rejected_increase: true,
  };
}

function calcStop(stop, rules) {
  const arrival = toDate(stop.arrival_time);
  const departure = toDate(stop.departure_time);
  const slotBegin = toDate(stop.timeslot_begin);

  if (!arrival || !departure) {
    return {
      ...stop,
      effective_minutes: 0,
      billable_minutes: 0,
      billed_units: 0,
      amount_eur: 0,
    };
  }

  const billableStart = slotBegin && slotBegin > arrival ? slotBegin : arrival;
  const effectiveMinutes = Math.max(
    0,
    Math.round((departure - arrival) / 60000),
  );
  const rawBillableMinutes = Math.max(
    0,
    Math.round((departure - billableStart) / 60000),
  );

  const billableAfterFree = Math.max(0, rawBillableMinutes - rules.freeMinutes);
  const billedUnits = Math.ceil(billableAfterFree / rules.unitMinutes);
  const rawAmount = billedUnits * rules.unitPrice;
  const amount = Math.min(rules.capEur, rawAmount);

  return {
    ...stop,
    effective_minutes: effectiveMinutes,
    billable_minutes: billableAfterFree,
    billed_units: billedUnits,
    amount_eur: amount,
    threshold_reached: amount >= rules.thresholdEur,
    arrival_display: formatDateTime(arrival),
    departure_display: formatDateTime(departure),
    slot_begin_display: formatDateTime(stop.timeslot_begin),
    slot_end_display: formatDateTime(stop.timeslot_end),
    rule_start_display: formatDateTime(billableStart),
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, app: "standgeld-standalone" });
});

app.post("/api/sixfold/standgeld", async (req, res) => {
  try {
    const rulesRaw = req.body?.rules || {};
    const intervalMinutes =
      Number(rulesRaw.intervalMinutes ?? rulesRaw.unitMinutes ?? 30) || 30;
    const rules = {
      freeMinutes: Math.max(0, Number(rulesRaw.freeMinutes ?? 120) || 120),
      unitMinutes: Math.max(1, intervalMinutes),
      unitPrice: Math.max(0, Number(rulesRaw.unitPrice ?? 30) || 30),
      thresholdEur: Math.max(0, Number(rulesRaw.thresholdEur ?? 30) || 30),
      capEur: Math.max(0, Number(rulesRaw.capEur ?? 650) || 650),
    };

    const url = String(req.body?.url || "").trim();
    const sessionToken = String(req.body?.sessionToken || "").trim();
    const sessionCookieRaw = String(req.body?.sessionCookie || "").trim();
    const authToken = String(req.body?.authToken || "").trim();
    const period = String(req.body?.period || "day").trim();
    const referenceDate = String(req.body?.referenceDate || "").trim();
    const transportNumberFilter = String(
      req.body?.transportNumber || "",
    ).trim();
    const tourIdFilter = String(req.body?.tourId || "").trim();
    const timeWindows = Array.isArray(req.body?.timeWindows)
      ? req.body.timeWindows
      : [];

    const sessionCookie =
      sessionCookieRaw ||
      (sessionToken ? `sessionToken=${sessionToken}; sixfold_lng=de` : "");

    let source = {
      url: url || null,
      mode: "empty",
    };

    let stops = Array.isArray(req.body?.stops) ? req.body.stops : [];

    if (!stops.length && /\/companies\/\d+\/fleet\/\d+\/timeline/i.test(url)) {
      if (!sessionCookie && !authToken) {
        return res.status(400).json({
          error:
            "Fleet-URL erkannt: SessionToken/Session-Cookie oder Auth-Token fehlt.",
        });
      }
      const window = buildEvaluationWindow(period, referenceDate);
      const fleet = await fetchFleetTimelineStops(url, {
        sessionCookie,
        authToken,
        fromTime: window.fromTime,
        toTime: window.toTime,
      });
      source = {
        ...fleet.source,
        mode: "fleet",
        period: window.period,
        reference_date: window.referenceDate,
      };
      stops = fleet.stops;
    } else if (stops.length) {
      source.mode = "manual-stops";
    }

    if (transportNumberFilter) {
      stops = stops.filter(
        (s) =>
          String(s.transport_number || "").trim() === transportNumberFilter,
      );
    }
    if (tourIdFilter) {
      stops = stops.filter(
        (s) => String(s.tour_id || "").trim() === tourIdFilter,
      );
    }

    const recalculated = stops.map((stop) =>
      calculateWithSafeOverride(stop, rules, timeWindows),
    );

    const removedLongStand = recalculated.filter(
      (s) => Number(s.effective_minutes || 0) > MAX_EFFECTIVE_MINUTES,
    );
    const filteredByDuration = recalculated.filter(
      (s) => Number(s.effective_minutes || 0) <= MAX_EFFECTIVE_MINUTES,
    );
    const calculated = filteredByDuration.filter(
      (s) => Number(s.billable_minutes || 0) > 0,
    );

    const summary = calculated.reduce(
      (acc, item) => {
        acc.amount += Number(item.amount_eur || 0);
        acc.units += Number(item.billed_units || 0);
        return acc;
      },
      { amount: 0, units: 0 },
    );

    const windowMatches = filteredByDuration.filter(
      (s) => s.window_override_applied,
    ).length;

    res.json({
      source,
      rules,
      summary: {
        amount: summary.amount,
        amount_display: formatEuro(summary.amount),
        units: summary.units,
        billed_positions: calculated.length,
        recalculated_positions: recalculated.length,
        time_window_rows: timeWindows.length,
        time_window_matches: windowMatches,
        removed_long_stand_positions: removedLongStand.length,
        max_effective_hours: 14,
      },
      stops: calculated,
      note: null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Unbekannter Fehler" });
  }
});

app.listen(PORT, () => {
  console.log(`Standgeld Standalone läuft auf http://localhost:${PORT}`);
});

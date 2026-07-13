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
const EXCLUDE_FROM_TOTAL_AMOUNT_EUR = 450;

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
      /\/companies\/(\d+)\/fleet\/([^/]+)\/timeline/i,
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
    tour_status: tour?.status || null,
    working_stop_id: tour?.working_stop_id || null,
    plate: tour?.plate || null,
  }));
}

function isStopInWindow(stop, fromTime, toTime) {
  const fromDate = toDate(fromTime);
  const toDateValue = toDate(toTime);
  if (!fromDate || !toDateValue) return true;

  const slotBegin = toDate(stop?.timeslot?.begin || stop?.timeslot_begin);
  const slotEnd = toDate(stop?.timeslot?.end || stop?.timeslot_end);
  if (slotBegin && slotEnd) {
    if (slotBegin < toDateValue && slotEnd >= fromDate) return true;
  }

  return [
    stop?.arrival_time,
    stop?.departure_time,
    stop?.estimated_arrival,
    stop?.deadline,
    stop?.timeslot?.begin,
    stop?.timeslot?.end,
    stop?.timeslot_begin,
    stop?.timeslot_end,
  ].some((value) => {
    const date = toDate(value);
    return date && date >= fromDate && date < toDateValue;
  });
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

  async function runGraphql(query, variables) {
    try {
      const response = await axios.post(
        `${context.origin}/graphql`,
        { query, variables },
        { timeout: 25000, headers },
      );
      if (
        Array.isArray(response?.data?.errors) &&
        response.data.errors.length
      ) {
        const firstError = response.data.errors[0]?.message || "GraphQL Fehler";
        throw new Error(firstError);
      }
      return response?.data?.data || null;
    } catch (error) {
      const gqlError =
        error?.response?.data?.errors?.[0]?.message ||
        error?.response?.data?.error ||
        error?.message ||
        "Unbekannter GraphQL Fehler";
      throw new Error(gqlError);
    }
  }

  async function runGraphqlAllowPartial(query, variables) {
    try {
      const response = await axios.post(
        `${context.origin}/graphql`,
        { query, variables },
        { timeout: 25000, headers },
      );
      return {
        data: response?.data?.data || null,
        errors: Array.isArray(response?.data?.errors)
          ? response.data.errors
          : [],
      };
    } catch (error) {
      const gqlError =
        error?.response?.data?.errors?.[0]?.message ||
        error?.response?.data?.error ||
        error?.message ||
        "Unbekannter GraphQL Fehler";
      throw new Error(gqlError);
    }
  }

  function collectToursFromVehicleEdges(edges) {
    const tours = [];
    (edges || []).forEach((edge) => {
      const node = edge?.node || null;
      (node?.tours || []).forEach((tour) => {
        tours.push({
          ...tour,
          plate: node?.license_plate_number || null,
        });
      });
    });
    return tours;
  }

  function mapFleetResultFromTours(tours) {
    return {
      source: {
        url,
        company_id: context.companyId,
        vehicle_group_id: "all",
      },
      tours,
      stops: tours.flatMap((tour) => normalizeFleetStops(tour)),
    };
  }

  function dedupeToursById(tours) {
    const byKey = new Map();
    (Array.isArray(tours) ? tours : []).forEach((tour, index) => {
      const tourId = String(tour?.tour_id || "").trim();
      const transport = String(tour?.shipper_transport_number || "").trim();
      const key =
        tourId || transport ? `${tourId}|${transport}` : `idx:${index}`;

      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, tour);
        return;
      }

      byKey.set(key, {
        ...existing,
        ...tour,
        plate: String(existing?.plate || tour?.plate || "").trim() || null,
        stops:
          Array.isArray(existing?.stops) && existing.stops.length
            ? existing.stops
            : tour?.stops,
      });
    });

    return Array.from(byKey.values());
  }

  function filterToursByWindow(tours) {
    const fromTime = options.fromTime;
    const toTime = options.toTime;
    if (!fromTime || !toTime) return tours;

    return (Array.isArray(tours) ? tours : []).filter((tour) => {
      const stops = Array.isArray(tour?.stops) ? tour.stops : [];
      return stops.some((stop) => isStopInWindow(stop, fromTime, toTime));
    });
  }

  async function fetchVehicleGroupIds() {
    const query = `
      query FleetGroupIds($companyId: String!) {
        viewer {
          company(company_id: $companyId) {
            companyVehicleGroups {
              companyVehicleGroupId
            }
          }
        }
      }
    `;

    const data = await runGraphql(query, {
      companyId: context.companyId,
    });

    return (data?.viewer?.company?.companyVehicleGroups || [])
      .map((group) => String(group?.companyVehicleGroupId || "").trim())
      .filter(Boolean);
  }

  async function fetchTourPlateMapByVehicleGroups() {
    const query = `
      query FleetAllPlateMap(
        $companyId: String!
        $fromTime: DateTime!
        $toTime: DateTime!
      ) {
        viewer {
          company(company_id: $companyId) {
            companyVehicleGroups {
              vehiclesConnection {
                vehicles(first: 250) {
                  edges {
                    node {
                      license_plate_number
                      tours(fromTime: $fromTime, toTime: $toTime) {
                        tour_id
                        shipper_transport_number
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

    const plateByKey = new Map();
    const result = await runGraphqlAllowPartial(query, {
      companyId: context.companyId,
      fromTime: options.fromTime,
      toTime: options.toTime,
    });

    const groups = result?.data?.viewer?.company?.companyVehicleGroups || [];
    groups.forEach((group) => {
      const vehicleEdges = group?.vehiclesConnection?.vehicles?.edges || [];
      vehicleEdges.forEach((edge) => {
        const vehicle = edge?.node || null;
        const plate = String(vehicle?.license_plate_number || "").trim();
        if (!plate) return;
        (vehicle?.tours || []).forEach((tour) => {
          const tourId = String(tour?.tour_id || "").trim();
          const transport = String(tour?.shipper_transport_number || "").trim();
          if (tourId && !plateByKey.has(`tour:${tourId}`)) {
            plateByKey.set(`tour:${tourId}`, plate);
          }
          if (transport && !plateByKey.has(`transport:${transport}`)) {
            plateByKey.set(`transport:${transport}`, plate);
          }
        });
      });
    });

    return {
      map: plateByKey,
      hadPartialErrors: (result?.errors || []).length > 0,
    };
  }

  async function fetchAllFleetTimelineToursByCompanyRole(role, plateMap) {
    const query = `
      query FleetAllViaCompanyTours(
        $companyId: String!
        $after: String
      ) {
        viewer {
          company(company_id: $companyId) {
            tours(role: ${role}) {
              count
              tours(first: 5000, after: $after) {
                edges {
                  node {
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
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      }
    `;

    const tours = [];
    let after = null;
    let pageCount = 0;

    while (pageCount < 200) {
      const data = await runGraphql(query, {
        companyId: context.companyId,
        after,
      });

      const toursConnection = data?.viewer?.company?.tours?.tours || null;
      const edges = toursConnection?.edges || [];
      edges.forEach((edge) => {
        if (edge?.node) tours.push(edge.node);
      });

      const pageInfo = toursConnection?.pageInfo || {};
      if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;

      after = pageInfo.endCursor;
      pageCount += 1;
    }

    const enrichedTours = tours.map((tour) => {
      const tourId = String(tour?.tour_id || "").trim();
      const transport = String(tour?.shipper_transport_number || "").trim();
      const plateFromMap =
        (tourId ? plateMap?.get(`tour:${tourId}`) : "") ||
        (transport ? plateMap?.get(`transport:${transport}`) : "");
      return {
        ...tour,
        plate: String(tour?.plate || plateFromMap || "").trim() || null,
      };
    });

    return dedupeToursById(filterToursByWindow(enrichedTours));
  }

  async function fetchAllFleetTimelineStops() {
    const errors = [];
    let plateMap = new Map();
    const collectedTours = [];

    try {
      const groupIds = await fetchVehicleGroupIds();
      const groupTours = [];

      for (const groupId of groupIds) {
        try {
          const groupResult = await fetchByVehicleGroupId(groupId);
          groupTours.push(...(groupResult?.tours || []));
        } catch (error) {
          errors.push(`groupId(${groupId}): ${error.message}`);
        }
      }

      collectedTours.push(...groupTours);
    } catch (error) {
      errors.push(`groupIdList: ${error.message}`);
    }

    try {
      const plateMapResult = await fetchTourPlateMapByVehicleGroups();
      plateMap = plateMapResult.map;
      if (plateMapResult.hadPartialErrors) {
        errors.push(
          "plateMap: Teilantwort mit Resolver-Fehlern, nutze verfuegbare Kennzeichen",
        );
      }
    } catch (error) {
      errors.push(`plateMap: ${error.message}`);
    }

    try {
      const tours = await fetchAllFleetTimelineToursByCompanyRole(
        "CARRIER",
        plateMap,
      );
      collectedTours.push(...tours);
    } catch (error) {
      errors.push(`companyToursCarrier: ${error.message}`);
    }

    try {
      const tours = await fetchAllFleetTimelineToursByCompanyRole(
        "SHIPPER",
        plateMap,
      );
      collectedTours.push(...tours);
    } catch (error) {
      errors.push(`companyToursShipper: ${error.message}`);
    }

    const mergedTours = filterToursByWindow(dedupeToursById(collectedTours));
    if (mergedTours.length) {
      return mapFleetResultFromTours(mergedTours);
    }

    const allVehiclesQuery = `
      query FleetAllStandgeldBatch(
        $companyId: String!
        $fromTime: DateTime!
        $toTime: DateTime!
      ) {
        viewer {
          company(company_id: $companyId) {
            vehiclesConnection {
              vehicles(first: 1000) {
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
    `;

    try {
      const allVehiclesData = await runGraphql(allVehiclesQuery, {
        companyId: context.companyId,
        fromTime: options.fromTime,
        toTime: options.toTime,
      });

      const directEdges =
        allVehiclesData?.viewer?.company?.vehiclesConnection?.vehicles?.edges ||
        [];
      if (directEdges.length) {
        const tours = dedupeToursById(
          collectToursFromVehicleEdges(directEdges),
        );
        if (tours.length) return mapFleetResultFromTours(tours);
      }
    } catch (error) {
      errors.push(`allVehiclesQuery: ${error.message}`);
    }

    const groupsQuery = `
      query FleetAllViaGroups(
        $companyId: String!
        $fromTime: DateTime!
        $toTime: DateTime!
      ) {
        viewer {
          company(company_id: $companyId) {
            companyVehicleGroupsConnection {
              companyVehicleGroups(first: 100) {
                edges {
                  node {
                    companyVehicleGroupId
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
          }
        }
      }
    `;

    try {
      const groupsData = await runGraphql(groupsQuery, {
        companyId: context.companyId,
        fromTime: options.fromTime,
        toTime: options.toTime,
      });

      const groupEdges =
        groupsData?.viewer?.company?.companyVehicleGroupsConnection
          ?.companyVehicleGroups?.edges || [];

      const tours = [];
      groupEdges.forEach((groupEdge) => {
        const vehicleEdges =
          groupEdge?.node?.vehiclesConnection?.vehicles?.edges || [];
        tours.push(...collectToursFromVehicleEdges(vehicleEdges));
      });

      const dedupedTours = dedupeToursById(tours);
      if (dedupedTours.length) return mapFleetResultFromTours(dedupedTours);
    } catch (error) {
      errors.push(`groupsConnectionQuery: ${error.message}`);
    }

    const groupsListQuery = `
      query FleetAllViaGroupsList(
        $companyId: String!
        $fromTime: DateTime!
        $toTime: DateTime!
      ) {
        viewer {
          company(company_id: $companyId) {
            companyVehicleGroups {
              companyVehicleGroupId
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

    try {
      const groupsListData = await runGraphql(groupsListQuery, {
        companyId: context.companyId,
        fromTime: options.fromTime,
        toTime: options.toTime,
      });

      const groupList =
        groupsListData?.viewer?.company?.companyVehicleGroups || [];
      const tours = [];
      groupList.forEach((group) => {
        const vehicleEdges = group?.vehiclesConnection?.vehicles?.edges || [];
        tours.push(...collectToursFromVehicleEdges(vehicleEdges));
      });

      const dedupedTours = dedupeToursById(tours);
      if (dedupedTours.length) return mapFleetResultFromTours(dedupedTours);
    } catch (error) {
      errors.push(`groupsListQuery: ${error.message}`);
    }

    throw new Error(
      `fleet/all konnte nicht ausgewertet werden: keine Fahrzeuge oder Touren im Zeitraum gefunden. ${errors.join(" | ")}`,
    );
  }
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

  async function fetchByVehicleGroupId(vehicleGroupId) {
    const data = await runGraphql(fleetQuery, {
      companyId: context.companyId,
      vehicleGroupId,
      fromTime: options.fromTime,
      toTime: options.toTime,
    });

    const edges =
      data?.viewer?.company?.companyVehicleGroup?.vehiclesConnection?.vehicles
        ?.edges || [];

    const tours = collectToursFromVehicleEdges(edges);
    return {
      source: {
        url,
        company_id: context.companyId,
        vehicle_group_id: vehicleGroupId,
      },
      tours,
      stops: tours.flatMap((tour) => normalizeFleetStops(tour)),
    };
  }

  if (String(context.vehicleGroupId).toLowerCase() === "all") {
    const errors = [];

    try {
      const byAllGroup = await fetchByVehicleGroupId("all");
      if (byAllGroup.tours.length) return byAllGroup;
    } catch (error) {
      errors.push(`companyVehicleGroup(all): ${error.message}`);
    }

    try {
      return await fetchAllFleetTimelineStops();
    } catch (error) {
      errors.push(`all-vehicles fallback: ${error.message}`);
    }

    throw new Error(
      `fleet/all konnte nicht geladen werden. ${errors.join(" | ")}`,
    );
  }

  return fetchByVehicleGroupId(context.vehicleGroupId);
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
    excel_window_start_raw: best.window_start || null,
    excel_window_end_raw: best.window_end || null,
    excel_window_display: best.window_start || best.window_end || null,
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
  const stopType = canonicalStopType(stop?.type);
  const isUnloadStop = stopType === "unload";

  // Prioritaet: Lade-Stellen behalten Sixfold, Entlade-Stellen nutzen Excel.
  if (isUnloadStop) {
    const overriddenStop = applyTimeWindowOverride(stop, windows);
    if (overriddenStop !== stop) {
      return calcStop(overriddenStop, rules);
    }

    const hasSixfoldWindow =
      toDate(stop?.timeslot_begin) || toDate(stop?.timeslot_end);
    if (hasSixfoldWindow) {
      return {
        ...base,
        window_override_applied: false,
        matched_window_key: null,
      };
    }

    return {
      ...base,
      window_override_applied: false,
      matched_window_key: null,
    };
  }

  // Prioritaet fuer Lade-Stellen: Sixfold-Zeitfenster vor Excel.
  const hasSixfoldWindow =
    toDate(stop?.timeslot_begin) || toDate(stop?.timeslot_end);
  if (hasSixfoldWindow) {
    return {
      ...base,
      window_override_applied: false,
      matched_window_key: null,
    };
  }

  const overriddenStop = applyTimeWindowOverride(stop, windows);
  if (overriddenStop === stop) {
    return {
      ...base,
      window_override_applied: false,
      matched_window_key: null,
    };
  }

  const overridden = calcStop(overriddenStop, rules);
  return overridden;
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

    if (
      !stops.length &&
      /\/companies\/\d+\/fleet\/[^/]+\/timeline/i.test(url)
    ) {
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

    const excludedFromTotal = calculated.filter(
      (s) => Number(s.amount_eur || 0) >= EXCLUDE_FROM_TOTAL_AMOUNT_EUR,
    );
    const countedForTotal = calculated.filter(
      (s) => Number(s.amount_eur || 0) < EXCLUDE_FROM_TOTAL_AMOUNT_EUR,
    );

    const summary = countedForTotal.reduce(
      (acc, item) => {
        acc.amount += Number(item.amount_eur || 0);
        acc.units += Number(item.billed_units || 0);
        return acc;
      },
      { amount: 0, units: 0 },
    );

    const excludedSummary = excludedFromTotal.reduce(
      (acc, item) => {
        acc.amount += Number(item.amount_eur || 0);
        return acc;
      },
      { amount: 0 },
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
        excluded_from_total_threshold_eur: EXCLUDE_FROM_TOTAL_AMOUNT_EUR,
        excluded_from_total_positions: excludedFromTotal.length,
        excluded_from_total_amount: excludedSummary.amount,
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

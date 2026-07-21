const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");

const { loadTransporeonExport } = require("./tools/readTransporeonExport");
const {
  billFromExport,
  buildGpsIndex,
  normalizeTransportNumber,
  normalizeLicensePlate,
} = require("./normalize/exportBilling");
const { classifySixfoldStop } = require("./normalize/sixfoldGps");
const {
  loadTransporeonExportFromBuffer,
} = require("./tools/readTransporeonExport");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3100);

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

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

const FLEET_STOP_FIELDS = `
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
    position {
      lat
      lng
    }
  }
  status_events {
    event_name
    event_time
    created_at
  }
`;

function normalizeFleetStops(tour) {
  const stops = Array.isArray(tour?.stops) ? tour.stops : [];
  return stops.map((stop, index) => {
    const gps = classifySixfoldStop(stop);
    return {
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
      timeslot_timezone: stop?.timeslot?.timezone || null,
      arrival_time: stop?.arrival_time || null,
      departure_time: stop?.departure_time || null,
      transport_number: tour?.shipper_transport_number || null,
      tour_id: tour?.tour_id || null,
      tour_status: tour?.status || null,
      working_stop_id: tour?.working_stop_id || null,
      plate: tour?.plate || null,
      position: stop?.location?.position
        ? {
            lat: stop.location.position.lat ?? null,
            lng: stop.location.position.lng ?? null,
          }
        : null,
      status_events: Array.isArray(stop?.status_events)
        ? stop.status_events.map((event) => ({
            event_name: event?.event_name || null,
            event_time: event?.event_time || null,
            created_at: event?.created_at || null,
          }))
        : [],
      gps,
    };
  });
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

async function fetchSixfoldGpsSimple(url, sessionCookie, timeWindow = {}) {
  /**
   * VEREINFACHTE GPS-Loader: Nur Transport-Nummer + Stopps abrufen.
   * Datums-Filter wird CLIENT-SEITIG nach der Abfrage angewendet
   * (Sixfold akzeptiert fromTime/toTime Parameter nicht auf diesem Endpunkt)
   */
  const companyId = "799";

  // WICHTIG: Verwende ALLE Felder aus FLEET_STOP_FIELDS, nicht nur Minimal!
  // Mit Cursor-Pagination, damit nicht nur die ersten 500 Touren verarbeitet werden.
  const query = `
    query FetchCarrierTours($after: String) {
      viewer {
        company(company_id: "${companyId}") {
          tours(role: CARRIER) {
            tours(first: 500, after: $after) {
              edges {
                node {
                  tour_id
                  shipper_transport_number
                  stops {
                    ${FLEET_STOP_FIELDS}
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

  const headers = {
    "Content-Type": "application/json",
    Cookie: sessionCookie,
  };

  async function runSimpleGraphql(query, variables = {}, timeoutMs = 45000) {
    const response = await axios.post(
      "https://app.sixfold.com/graphql",
      { query, variables },
      { timeout: timeoutMs, headers },
    );

    if (response?.data?.errors?.length) {
      throw new Error(response.data.errors[0]?.message || "GraphQL Error");
    }

    return response?.data?.data || null;
  }

  async function runSimpleGraphqlAllowPartial(
    query,
    variables = {},
    timeoutMs = 45000,
  ) {
    const response = await axios.post(
      "https://app.sixfold.com/graphql",
      { query, variables },
      { timeout: timeoutMs, headers },
    );

    return {
      data: response?.data?.data || null,
      errors: Array.isArray(response?.data?.errors) ? response.data.errors : [],
    };
  }

  async function fetchTourPlateMap() {
    const fromTimeIso = timeWindow?.fromTime
      ? new Date(timeWindow.fromTime).toISOString()
      : null;
    const toTimeIso = timeWindow?.toTime
      ? new Date(timeWindow.toTime).toISOString()
      : null;

    if (!fromTimeIso || !toTimeIso) {
      return new Map();
    }

    const plateByKey = new Map();

    const groupsConnectionQuery = `
      query FetchSimplePlateMapConnection(
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
          }
        }
      }
    `;

    try {
      const variables = {
        companyId,
        fromTime: fromTimeIso,
        toTime: toTimeIso,
      };

      const connectionResult = await runSimpleGraphqlAllowPartial(
        groupsConnectionQuery,
        variables,
      );
      if (connectionResult.errors.length) {
        console.warn(
          `[Sixfold] Kennzeichen-Mapping Teilfehler (Connection): ${connectionResult.errors[0]?.message || "unbekannt"}`,
        );
      }
      const groups = (
        connectionResult?.data?.viewer?.company?.companyVehicleGroupsConnection
          ?.companyVehicleGroups?.edges || []
      ).map((edge) => edge?.node || null);

      groups.forEach((group) => {
        const edges = group?.vehiclesConnection?.vehicles?.edges || [];
        edges.forEach((edge) => {
          const vehicle = edge?.node || null;
          const plate = String(vehicle?.license_plate_number || "").trim();
          if (!plate) return;

          (vehicle?.tours || []).forEach((tour) => {
            const tourId = String(tour?.tour_id || "").trim();
            const transport = String(
              tour?.shipper_transport_number || "",
            ).trim();

            if (tourId && !plateByKey.has(`tour:${tourId}`)) {
              plateByKey.set(`tour:${tourId}`, plate);
            }
            if (transport && !plateByKey.has(`transport:${transport}`)) {
              plateByKey.set(`transport:${transport}`, plate);
            }
          });
        });
      });
    } catch (error) {
      console.warn(
        `[Sixfold] Kennzeichen-Mapping nicht verfuegbar: ${error.message}`,
      );
    }

    return plateByKey;
  }

  const allStops = [];

  try {
    const tours = [];
    const plateByKey = new Map();
    let after = null;
    let pageCount = 0;

    while (pageCount < 200) {
      const data = await runSimpleGraphql(query, { after });
      const connection = data?.viewer?.company?.tours?.tours || null;
      const edges = connection?.edges || [];
      tours.push(...edges);

      const pageInfo = connection?.pageInfo || {};
      if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;

      after = pageInfo.endCursor;
      pageCount += 1;
    }

    // Datums-Filter: CLIENT-SEITIG anwenden
    const fromTime = timeWindow?.fromTime
      ? new Date(timeWindow.fromTime)
      : null;
    const toTime = timeWindow?.toTime ? new Date(timeWindow.toTime) : null;

    tours.forEach((edge) => {
      const tour = edge?.node;
      const tn = String(tour?.shipper_transport_number || "").trim();
      const tourId = String(tour?.tour_id || "").trim();
      if (!tn) return;

      const mappedPlate =
        (tourId ? plateByKey.get(`tour:${tourId}`) : "") ||
        (tn ? plateByKey.get(`transport:${tn}`) : "") ||
        null;

      const stops = Array.isArray(tour?.stops) ? tour.stops : [];
      stops.forEach((stop) => {
        // Datums-Filter robust auf allen Zeitfeldern anwenden
        // (arrival/departure/estimated/deadline/timeslot).
        if ((fromTime || toTime) && !isStopInWindow(stop, fromTime, toTime)) {
          return;
        }

        const coords = stop?.location?.position || {};
        const events = Array.isArray(stop?.status_events)
          ? stop.status_events.map((e) => String(e?.event_name || ""))
          : [];

        // GPS-Verifikation
        const hasApproach = events.includes("APPROACH");
        const hasDepart = events.includes("DEPART");

        allStops.push({
          transport_number: tn,
          license_plate: mappedPlate,
          type: String(stop?.type || "").toUpperCase(),
          arrival_time: stop?.arrival_time || null,
          departure_time: stop?.departure_time || null,
          position: {
            lat: Number(coords?.lat) || 0,
            lng: Number(coords?.lng) || 0,
          },
          gps: {
            arrival_verified: hasApproach,
            departure_verified: hasDepart,
          },
        });
      });
    });

    return allStops;
  } catch (err) {
    // Besseres Error-Logging
    if (err.response?.status) {
      console.error(
        `[Sixfold] HTTP ${err.response.status}: ${err.response.statusText}`,
      );
      if (err.response?.data?.errors) {
        console.error(`[Sixfold] GraphQL Errors:`, err.response.data.errors);
      } else if (err.response?.data) {
        console.error(
          `[Sixfold] Response:`,
          JSON.stringify(err.response.data).substring(0, 500),
        );
      }
    } else {
      console.error(`[Sixfold] Fehler beim Laden: ${err.message}`);
    }
    throw err;
  }
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

  async function runGraphql(query, variables, timeoutMs = 25000) {
    try {
      const response = await axios.post(
        `${context.origin}/graphql`,
        { query, variables },
        { timeout: timeoutMs, headers },
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
              tours(first: 500, after: $after) {
                edges {
                  node {
                    tour_id
                    shipper_transport_number
                    status
                    working_stop_id
                    stops {${FLEET_STOP_FIELDS}}
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
      const data = await runGraphql(
        query,
        {
          companyId: context.companyId,
          after,
        },
        45000,
      );

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
                      stops {${FLEET_STOP_FIELDS}}
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
                              stops {${FLEET_STOP_FIELDS}}
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
                        stops {${FLEET_STOP_FIELDS}}
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
                      stops {${FLEET_STOP_FIELDS}}
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
    // Ohne Ankunft ODER Abfahrt gibt es keine Dauer zum Zaehlen -> 0 EUR.
    return {
      ...stop,
      effective_minutes: 0,
      billable_minutes: 0,
      billed_units: 0,
      amount_eur: 0,
      gps_verified: Boolean(stop?.gps?.gps_connected),
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
    // GPS ist nur Zusatz-Info. Die gesetzten (XP-)Zeiten werden IMMER abgerechnet.
    gps_verified: Boolean(stop?.gps?.gps_connected),
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

// Batch-Abrechnung aller Transporte aus dem Transporeon-Excel-Export.
// Liefert Zeitfenster + Standgeld je Stopp (Laden/Entladen) fuer ALLE Transporte.
const EXPORT_XLSX_PATH = path.join(
  process.cwd(),
  "data",
  "captures",
  "transporeon_export.xlsx",
);

// Leitet aus den Export-Transporten ein GPS-Abfragefenster ab. Die lokalen
// Zeitfelder haben das Format "YYYY-MM-DD HH:MM" (Europe/Berlin). Wir nehmen die
// frueheste und spaeteste erkennbare Zeit und puffern grosszuegig (+/- 2 Tage),
// damit Sixfold alle relevanten Touren liefert.
function computeTransportsWindow(transports) {
  let minMs = null;
  let maxMs = null;
  const consider = (local) => {
    if (!local) return;
    const ms = Date.parse(String(local).replace(" ", "T"));
    if (Number.isNaN(ms)) return;
    if (minMs === null || ms < minMs) minMs = ms;
    if (maxMs === null || ms > maxMs) maxMs = ms;
  };
  for (const t of Array.isArray(transports) ? transports : []) {
    for (const stop of [t?.loading, t?.unloading]) {
      if (!stop) continue;
      consider(stop.window_local);
      consider(stop.arrival_local);
      consider(stop.departure_local);
    }
  }
  const DAY = 24 * 60 * 60 * 1000;
  if (minMs === null || maxMs === null) {
    const now = Date.now();
    return {
      fromTime: new Date(now - 90 * DAY).toISOString(),
      toTime: new Date(now + 30 * DAY).toISOString(),
    };
  }
  return {
    fromTime: new Date(minMs - 2 * DAY).toISOString(),
    toTime: new Date(maxMs + 2 * DAY).toISOString(),
  };
}

function extractLocalDate(value) {
  const text = String(value || "").trim();
  const m = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Filtert Transporte nach Entladedatum (aus dem Entlade-Stopp).
// Bereich ist inklusiv: from <= datum <= to.
function filterTransportsByUnloadDate(transports, fromDate, toDate) {
  if (!fromDate && !toDate) return Array.isArray(transports) ? transports : [];

  const list = Array.isArray(transports) ? transports : [];
  return list.filter((t) => {
    const unload = t?.unloading || null;
    const unloadDate =
      extractLocalDate(unload?.window_local) ||
      extractLocalDate(unload?.arrival_local) ||
      extractLocalDate(unload?.departure_local);
    if (!unloadDate) return false;
    if (fromDate && unloadDate < fromDate) return false;
    if (toDate && unloadDate > toDate) return false;
    return true;
  });
}

function buildUnloadDateFilterMeta(transports, fromDate, toDate) {
  const list = Array.isArray(transports) ? transports : [];
  const hasFilter = Boolean(fromDate || toDate);
  if (!hasFilter) {
    return {
      date_filter_applied: false,
      date_filter_from: null,
      date_filter_to: null,
      input_transport_count: list.length,
      filtered_transport_count: list.length,
      excluded_transport_count: 0,
      excluded_missing_unload_date_count: 0,
      excluded_outside_date_range_count: 0,
    };
  }

  let missingUnloadDate = 0;
  let outsideRange = 0;
  for (const t of list) {
    const unload = t?.unloading || null;
    const unloadDate =
      extractLocalDate(unload?.window_local) ||
      extractLocalDate(unload?.arrival_local) ||
      extractLocalDate(unload?.departure_local);

    if (!unloadDate) {
      missingUnloadDate += 1;
      continue;
    }
    if (
      (fromDate && unloadDate < fromDate) ||
      (toDate && unloadDate > toDate)
    ) {
      outsideRange += 1;
    }
  }

  const filtered = filterTransportsByUnloadDate(list, fromDate, toDate);
  return {
    date_filter_applied: true,
    date_filter_from: fromDate || null,
    date_filter_to: toDate || null,
    input_transport_count: list.length,
    filtered_transport_count: filtered.length,
    excluded_transport_count: Math.max(0, list.length - filtered.length),
    excluded_missing_unload_date_count: missingUnloadDate,
    excluded_outside_date_range_count: outsideRange,
  };
}

// Optionaler GPS-Abgleich: Sixfold-Link + Token via Header (NICHT als Query,
// damit keine Zugangsdaten in Server-Logs/History landen). Liefert
// { gpsIndex, gpsInfo } oder { gpsIndex: null, gpsInfo: null } wenn nichts gesetzt.
// `window` = { fromTime, toTime } (ISO) begrenzt die Sixfold-Abfrage.
// `debug` = true zeigt Logging für GPS-Matching (z.B. 0/0-Koordinaten-Filter).
async function resolveGpsIndexFromHeaders(req, window = {}, debug = false) {
  const sixfoldUrl = String(req.get("x-sixfold-url") || "").trim();
  const sixfoldToken = String(req.get("x-sixfold-token") || "").trim();
  const sixfoldCookieRaw = String(req.get("x-sixfold-cookie") || "").trim();

  if (!sixfoldUrl || !(sixfoldToken || sixfoldCookieRaw)) {
    return { gpsIndex: null, gpsInfo: null };
  }

  const sessionCookie = sixfoldCookieRaw
    ? sixfoldCookieRaw
    : `sessionToken=${sixfoldToken}; sixfold_lng=de`;

  // Nutze die VEREINFACHTE fetchSixfoldGpsSimple Funktion (kein Hang!)
  let sixfoldStops = await fetchSixfoldGpsSimple(
    sixfoldUrl,
    sessionCookie,
    window,
  );

  // Fallback: Wenn der Simple-Loader keine Kennzeichen liefert, hole Stops ueber
  // den robusten Fleet-Timeline-Pfad mit Tour-/Vehicle-Mapping.
  const hasMappedPlate = (sixfoldStops || []).some((stop) =>
    Boolean(String(stop?.license_plate || "").trim()),
  );
  if (!hasMappedPlate) {
    try {
      const fleetResult = await fetchFleetTimelineStops(sixfoldUrl, {
        sessionCookie,
        fromTime: window.fromTime,
        toTime: window.toTime,
      });
      const fleetStops = Array.isArray(fleetResult?.stops)
        ? fleetResult.stops
        : [];

      if (fleetStops.length) {
        sixfoldStops = fleetStops.map((stop) => ({
          transport_number: stop?.transport_number || null,
          license_plate: stop?.plate || null,
          type: String(stop?.type || "").toUpperCase(),
          arrival_time: stop?.arrival_time || null,
          departure_time: stop?.departure_time || null,
          position: stop?.position || null,
          gps: stop?.gps || {},
        }));
      }
    } catch (error) {
      console.warn(
        `[Sixfold] Fallback Fleet-Timeline fehlgeschlagen: ${error.message}`,
      );
    }
  }

  const gpsIndex = buildGpsIndex(sixfoldStops, { debug });

  return {
    gpsIndex,
    gpsInfo: {
      fetched: true,
      window_from: window.fromTime || null,
      window_to: window.toTime || null,
      sixfold_stops: sixfoldStops.length,
      gps_index_size: gpsIndex.size,
    },
  };
}

app.get("/api/billing/export", async (req, res) => {
  try {
    const filePath = req.query.file ? String(req.query.file) : EXPORT_XLSX_PATH;
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: `Export-Datei nicht gefunden: ${filePath}`,
      });
    }

    const config = {};
    if (req.query.freeMinutes)
      config.freeMinutes = Number(req.query.freeMinutes);
    if (req.query.blockMinutes)
      config.blockMinutes = Number(req.query.blockMinutes);
    if (req.query.blockRateEur)
      config.blockRateEur = Number(req.query.blockRateEur);
    if (req.query.triggerMinutes)
      config.triggerMinutes = Number(req.query.triggerMinutes);

    const transports = loadTransporeonExport(filePath);

    // Nutze Datums-Filter, falls gesetzt
    let window = computeTransportsWindow(transports);
    const sixfoldDateFrom = req.query.sixfoldDateFrom
      ? String(req.query.sixfoldDateFrom).trim()
      : null;
    const sixfoldDateTo = req.query.sixfoldDateTo
      ? String(req.query.sixfoldDateTo).trim()
      : null;
    if (sixfoldDateFrom || sixfoldDateTo) {
      window = {
        fromTime: sixfoldDateFrom
          ? `${sixfoldDateFrom}T00:00:00Z`
          : window.fromTime,
        toTime: sixfoldDateTo ? `${sixfoldDateTo}T23:59:59Z` : window.toTime,
      };
    }

    const filteredTransports = filterTransportsByUnloadDate(
      transports,
      sixfoldDateFrom,
      sixfoldDateTo,
    );
    const filterMeta = buildUnloadDateFilterMeta(
      transports,
      sixfoldDateFrom,
      sixfoldDateTo,
    );

    const debug = req.query.debug === "1" || req.query.debug === "true";
    const { gpsIndex, gpsInfo } = await resolveGpsIndexFromHeaders(
      req,
      window,
      debug,
    );

    const result = billFromExport(filteredTransports, { config, gpsIndex });

    res.json({
      file: filePath,
      generated_at: new Date().toISOString(),
      gps: gpsInfo,
      summary: {
        ...result.summary,
        ...filterMeta,
        total_fee_display: formatEuro(result.summary.total_fee_eur),
      },
      stops: result.stops,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Unbekannter Fehler" });
  }
});

// Excel-Upload: Transporeon-Export als Datei hochladen und sofort abrechnen.
// Rohbytes der .xlsx im Body (application/octet-stream o.ae.).
app.post(
  "/api/billing/upload",
  express.raw({
    type: () => true,
    limit: "25mb",
  }),
  async (req, res) => {
    try {
      const buffer = req.body;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return res
          .status(400)
          .json({ error: "Keine Datei empfangen (leerer Body)." });
      }

      const config = {};
      if (req.query.freeMinutes)
        config.freeMinutes = Number(req.query.freeMinutes);
      if (req.query.blockMinutes)
        config.blockMinutes = Number(req.query.blockMinutes);
      if (req.query.blockRateEur)
        config.blockRateEur = Number(req.query.blockRateEur);
      if (req.query.triggerMinutes)
        config.triggerMinutes = Number(req.query.triggerMinutes);

      // Optionaler GPS-Abgleich ueber Sixfold (Header, siehe Helper).
      const transports = loadTransporeonExportFromBuffer(buffer);
      const sixfoldDateFrom = req.query.sixfoldDateFrom
        ? String(req.query.sixfoldDateFrom).trim()
        : null;
      const sixfoldDateTo = req.query.sixfoldDateTo
        ? String(req.query.sixfoldDateTo).trim()
        : null;
      const filteredTransports = filterTransportsByUnloadDate(
        transports,
        sixfoldDateFrom,
        sixfoldDateTo,
      );
      const filterMeta = buildUnloadDateFilterMeta(
        transports,
        sixfoldDateFrom,
        sixfoldDateTo,
      );

      let window = computeTransportsWindow(filteredTransports);
      if (sixfoldDateFrom || sixfoldDateTo) {
        window = {
          fromTime: sixfoldDateFrom
            ? `${sixfoldDateFrom}T00:00:00Z`
            : window.fromTime,
          toTime: sixfoldDateTo ? `${sixfoldDateTo}T23:59:59Z` : window.toTime,
        };
      }
      const debug = req.query.debug === "1" || req.query.debug === "true";
      const { gpsIndex, gpsInfo } = await resolveGpsIndexFromHeaders(
        req,
        window,
        debug,
      );

      const result = billFromExport(filteredTransports, { config, gpsIndex });

      res.json({
        file: req.query.name ? String(req.query.name) : "upload.xlsx",
        generated_at: new Date().toISOString(),
        gps: gpsInfo,
        summary: {
          ...result.summary,
          ...filterMeta,
          total_fee_display: formatEuro(result.summary.total_fee_eur),
        },
        stops: result.stops,
      });
    } catch (error) {
      res.status(500).json({ error: error.message || "Unbekannter Fehler" });
    }
  },
);

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

    // 14h-Filter entfernt: lange Standzeiten werden nicht mehr automatisch verworfen.
    const removedLongStand = [];
    const filteredByDuration = recalculated;
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

    const gpsVerifiedPositions = recalculated.filter(
      (s) => s.gps_verified,
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
        max_effective_hours: null,
        gps_verified_positions: gpsVerifiedPositions,
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

/**
 * POST /api/sixfold/selective-match
 * Selektive Sixfold-Abfrage: Nutzer lädt Excel hoch, System sucht GENAU diese TNs
 * in Sixfold und vergleicht mit Kennzeichen-Abgleich.
 *
 * Request:
 *   - Body: Raw Excel-Buffer (application/octet-stream)
 *   - Header: x-sixfold-url, x-sixfold-cookie (oder x-sixfold-token)
 *
 * Response:
 *   - matches: Transporte mit Kennzeichen-Validierung
 *   - only_in_excel: Nur im Upload vorhanden
 *   - only_in_sixfold: Nur in Sixfold vorhanden
 */
app.post(
  "/api/sixfold/selective-match",
  express.raw({
    type: () => true,
    limit: "25mb",
  }),
  async (req, res) => {
    try {
      const buffer = req.body;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return res
          .status(400)
          .json({ error: "Keine Datei empfangen (leerer Body)." });
      }

      // Sixfold Credentials
      const sixfoldUrl = String(req.get("x-sixfold-url") || "").trim();
      const sixfoldCookieRaw = String(req.get("x-sixfold-cookie") || "").trim();
      const sixfoldToken = String(req.get("x-sixfold-token") || "").trim();

      if (!sixfoldUrl || !(sixfoldCookieRaw || sixfoldToken)) {
        return res.status(400).json({
          error:
            "Sixfold Credentials erforderlich: x-sixfold-url und x-sixfold-cookie/token",
        });
      }

      const sessionCookie = sixfoldCookieRaw
        ? sixfoldCookieRaw
        : `sessionToken=${sixfoldToken}; sixfold_lng=de`;

      // 1. TNs aus Excel extrahieren
      const excelTransports = loadTransporeonExportFromBuffer(buffer);
      const excelTnMap = new Map(); // TN -> Excel-Transport
      const excelTnSet = new Set();

      for (const t of excelTransports) {
        const tn = normalizeTransportNumber(t.transport_number);
        if (tn) {
          excelTnSet.add(tn);
          if (!excelTnMap.has(tn)) {
            excelTnMap.set(tn, t);
          }
        }
      }

      if (excelTnSet.size === 0) {
        return res.status(400).json({
          error: "Keine Transport-Nummern in der Excel-Datei gefunden",
        });
      }

      // 2. Sixfold Stopps laden (ALLE, dann filtern)
      const sixfoldStops = await fetchSixfoldGpsSimple(
        sixfoldUrl,
        sessionCookie,
        {},
      );

      // 3. Auf Excel-TNs filtern
      const sixfoldTnMap = new Map(); // TN -> Sixfold-Stop (nimm den ersten)
      const sixfoldTnSet = new Set();

      for (const stop of sixfoldStops) {
        const tn = normalizeTransportNumber(stop.transport_number);
        if (tn && excelTnSet.has(tn)) {
          sixfoldTnSet.add(tn);
          if (!sixfoldTnMap.has(tn)) {
            sixfoldTnMap.set(tn, stop);
          }
        }
      }

      // 4. Kennzeichen-Abgleich mit Regel anwenden:
      //    - Excel-Kennzeichen vorhanden
      //    - Sixfold-Kennzeichen vorhanden
      //    - Kennzeichen identisch (normalisiert)
      const matches = [];
      const onlyInExcel = [];
      const onlyInSixfold = [];

      // Für alle Excel-TNs prüfen
      for (const tn of excelTnSet) {
        const excelT = excelTnMap.get(tn);
        const sixfoldStop = sixfoldTnMap.get(tn);
        const excelPlate = (excelT?.vehicle_registration || "").trim() || null;

        if (sixfoldStop) {
          // Found in both
          const sixfoldPlate =
            String(sixfoldStop.license_plate || "").trim() || null;

          const hasExcelPlate = Boolean(excelPlate);
          const hasSixfoldPlate = Boolean(sixfoldPlate);

          let plateValidationStatus = "no_match"; // Fallback
          if (!hasExcelPlate && !hasSixfoldPlate) {
            plateValidationStatus = "no_plates";
          } else if (!hasExcelPlate) {
            plateValidationStatus = "missing_excel_plate";
          } else if (!hasSixfoldPlate) {
            plateValidationStatus = "missing_sixfold_plate";
          } else {
            // Both have plates
            const excelNorm = normalizeLicensePlate(excelPlate);
            const sixfoldNorm = normalizeLicensePlate(sixfoldPlate);
            plateValidationStatus =
              excelNorm === sixfoldNorm ? "match" : "mismatch";
          }

          matches.push({
            transport_number: tn,
            excel_plate: excelPlate,
            sixfold_plate: sixfoldPlate,
            plate_validation: plateValidationStatus,
            usable_for_comparison: true, // Wenn TNs stimmt, IMMER nutzbar (mismatch -> nur XP)
          });
        } else {
          // Only in Excel
          onlyInExcel.push({
            transport_number: tn,
            excel_plate: excelPlate,
          });
        }
      }

      // Sixfold-TNs die nicht in Excel sind
      for (const tn of sixfoldTnSet) {
        if (!excelTnSet.has(tn)) {
          const sixfoldStop = sixfoldTnMap.get(tn);
          const sixfoldPlate =
            String(sixfoldStop.license_plate || "").trim() || null;
          onlyInSixfold.push({
            transport_number: tn,
            sixfold_plate: sixfoldPlate,
          });
        }
      }

      res.json({
        generated_at: new Date().toISOString(),
        summary: {
          total_excel: excelTnSet.size,
          total_sixfold_filtered: sixfoldTnSet.size,
          matched_count: matches.length,
          only_in_excel_count: onlyInExcel.length,
          only_in_sixfold_count: onlyInSixfold.length,
          plate_matches_count: matches.filter(
            (m) => m.plate_validation === "match",
          ).length,
          plate_mismatches_count: matches.filter(
            (m) => m.plate_validation === "mismatch",
          ).length,
        },
        matches,
        only_in_excel: onlyInExcel,
        only_in_sixfold: onlyInSixfold,
      });
    } catch (error) {
      res.status(500).json({ error: error.message || "Unbekannter Fehler" });
    }
  },
);

app.listen(PORT, () => {
  console.log(`Standgeld Standalone läuft auf http://localhost:${PORT}`);
});

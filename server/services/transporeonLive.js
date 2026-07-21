"use strict";

const path = require("node:path");
const { chromium } = require("playwright");

const { parseVisibilityResponse } = require("../normalize/gwtVisibility");
const { mergeTransportLists } = require("../normalize/gwtTransportList");

const PROFILE_DIR = path.join(process.cwd(), ".pw-profile");
const START_URL =
  "https://login.transporeon.com/?locale=de&return=AssignedTransportsCarrier";
const DISPATCH_RE = /\/taweb\/ta\/dispatch(\?|$)/;
const NUMBER_CELL = 'td[class*="gxColumn-number"] div.taMJE';
const VISIBILITY_TAB = "li.transportTransportVisibilityTab";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTransportId(template, b64Id) {
  return template.replace(
    /(\|7\|)[A-Za-z0-9$_]+(\|8\|\d+\|)/,
    (_, start, end) => start + b64Id + end,
  );
}

async function findListFrame(context) {
  for (const pg of context.pages()) {
    for (const frame of pg.frames()) {
      try {
        const has = await frame.evaluate(
          () => !!document.querySelector('td[class*="gxColumn-number"]'),
        );
        if (has) return { page: pg, frame };
      } catch {
        // ignore cross-origin/inaccessible frames
      }
    }
  }
  return null;
}

async function waitForListFrame(context, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : 90000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const found = await findListFrame(context);
    if (found) return found;
    await sleep(pollMs);
  }

  return null;
}

async function scrollListToLoadAllPages(frame) {
  try {
    await frame.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const grid = Array.from(document.querySelectorAll("div"))
        .filter((node) => node.scrollHeight > node.clientHeight + 40)
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!grid) return;
      let lastTop = -1;
      for (let i = 0; i < 60; i += 1) {
        grid.scrollTop = grid.scrollHeight;
        await wait(350);
        if (grid.scrollTop === lastTop) break;
        lastTop = grid.scrollTop;
      }
      grid.scrollTop = 0;
    });
  } catch {
    // best effort
  }
}

async function ensureVisibilityTemplate(frame, captured) {
  const cell = frame.locator(NUMBER_CELL).first();
  await cell.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await cell.click({ timeout: 5000, force: true }).catch(() => {});
  await sleep(400);

  const tab = frame.locator(VISIBILITY_TAB).first();
  if ((await tab.count()) === 0) {
    await cell.dblclick({ timeout: 5000, force: true }).catch(() => {});
    await sleep(600);
  }

  await frame
    .locator(VISIBILITY_TAB)
    .first()
    .click({ timeout: 5000, force: true })
    .catch(() => {});

  for (let i = 0; i < 20 && !captured.visibility; i += 1) {
    await sleep(300);
  }
}

async function waitForVisibilityTemplate(frame, captured, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : 120000;
  const retryMs = Number.isFinite(options.retryMs) ? options.retryMs : 5000;
  const deadline = Date.now() + timeoutMs;

  // Erst einmal aktiv versuchen, das Template automatisch auszulösen.
  await ensureVisibilityTemplate(frame, captured);

  while (!captured.visibility && Date.now() < deadline) {
    // Nutzer kann parallel manuell einen Transport + Event-Management öffnen.
    await sleep(retryMs);
    if (captured.visibility) break;
    // Best-effort erneut automatisch triggern.
    await ensureVisibilityTemplate(frame, captured);
  }

  return captured.visibility;
}

async function fetchVisibilities(page, api, rows, concurrency) {
  const jobs = rows.map((row) => ({
    transportNumber: row.transportNumber,
    body: withTransportId(api.template, row.transportIdB64),
  }));

  return page.evaluate(
    async ({
      endpoint,
      moduleBase,
      strongName,
      jobs: batch,
      concurrency: max,
    }) => {
      const results = new Array(batch.length);
      let next = 0;

      async function worker() {
        for (;;) {
          const index = next++;
          if (index >= batch.length) return;
          const job = batch[index];
          try {
            const response = await fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "text/x-gwt-rpc; charset=UTF-8",
                "X-GWT-Permutation": strongName,
                "X-GWT-Module-Base": moduleBase,
              },
              body: job.body,
              credentials: "include",
            });
            const text = await response.text();
            results[index] = {
              transportNumber: job.transportNumber,
              ok: response.ok && text.startsWith("//OK"),
              text,
              error: response.ok ? null : `HTTP ${response.status}`,
            };
          } catch (error) {
            results[index] = {
              transportNumber: job.transportNumber,
              ok: false,
              error: String(error && error.message),
            };
          }
        }
      }

      const workerCount = Math.max(1, Math.min(max, batch.length));
      await Promise.all(Array.from({ length: workerCount }, worker));
      return results;
    },
    {
      endpoint: api.endpoint,
      moduleBase: api.moduleBase,
      strongName: api.strongName,
      jobs,
      concurrency,
    },
  );
}

async function fetchLiveVisibilityEvents(transportNumbers, options = {}) {
  const targets = Array.from(
    new Set(
      (transportNumbers || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );

  if (!targets.length) {
    return {
      events: [],
      failures: [],
      matchedTransports: [],
      missingTransportNumbers: [],
      availableTransportCount: 0,
    };
  }

  const context = await chromium.launchPersistentContext(
    options.profileDir || PROFILE_DIR,
    {
      headless: Boolean(options.headless),
      viewport: { width: 1600, height: 950 },
      locale: "de-DE",
    },
  );

  try {
    const captured = { visibility: null };
    const listResponses = [];

    context.on("response", async (response) => {
      const url = response.url();
      if (!DISPATCH_RE.test(url)) return;
      try {
        const request = response.request();
        const requestBody = request.postData() || "";
        const text = await response.text();
        if (requestBody.includes("LoadPagedTransportListItemsAction")) {
          listResponses.push(text);
        } else if (
          requestBody.includes("LoadTransportVisibilityAction") &&
          !captured.visibility
        ) {
          captured.visibility = { url, requestBody };
        }
      } catch {
        // ignore unreadable responses
      }
    });

    const page = context.pages()[0] || (await context.newPage());
    await page.goto(options.startUrl || START_URL, {
      waitUntil: "domcontentloaded",
    });

    const found = await waitForListFrame(context, {
      timeoutMs: options.waitForListTimeoutMs,
      pollMs: options.waitForListPollMs,
    });
    if (!found) {
      throw new Error(
        "Keine Transporeon-Liste gefunden. Bitte im geoeffneten Playwright-Browser bei Transporeon einloggen und 'Zugewiesene Transporte' laden, dann erneut starten.",
      );
    }

    const { page: listPage, frame } = found;
    await scrollListToLoadAllPages(frame);
    for (let i = 0; i < 4; i += 1) await sleep(300);

    const allRows = mergeTransportLists(listResponses);
    if (!allRows.length) {
      throw new Error(
        "Keine Transport-Zuordnung aus der Transporeon-Liste erfasst. Bitte Liste neu laden und erneut versuchen.",
      );
    }

    if (!captured.visibility) {
      await waitForVisibilityTemplate(frame, captured, {
        timeoutMs: options.waitForVisibilityTimeoutMs,
      });
    }
    if (!captured.visibility) {
      throw new Error(
        "Kein Visibility-Template erhalten. Bitte im geoeffneten Playwright-Browser einen Transport anklicken und den Tab 'Event Management' oeffnen.",
      );
    }

    const targetSet = new Set(targets);
    const matchedTransports = allRows.filter((row) =>
      targetSet.has(String(row.transportNumber || "").trim()),
    );
    const matchedNumbers = new Set(
      matchedTransports.map((row) => String(row.transportNumber || "").trim()),
    );
    const missingTransportNumbers = targets.filter(
      (transportNumber) => !matchedNumbers.has(transportNumber),
    );
    const fetchRows = matchedTransports.filter((row) => row.transportIdB64);

    const apiParts = captured.visibility.requestBody.split("|");
    const api = {
      endpoint: captured.visibility.url,
      moduleBase: apiParts[3],
      strongName: apiParts[4],
      template: captured.visibility.requestBody,
    };

    const responses = await fetchVisibilities(
      listPage,
      api,
      fetchRows,
      Number.isFinite(options.concurrency) ? options.concurrency : 8,
    );

    const events = [];
    const failures = [];

    for (const result of responses) {
      if (!result?.ok) {
        failures.push({
          transport_number: result?.transportNumber || null,
          error: result?.error || "Visibility nicht lesbar",
        });
        continue;
      }

      try {
        const parsed = parseVisibilityResponse(result.text, {
          transportNumber: result.transportNumber,
        });
        for (const event of parsed) events.push(event);
      } catch (error) {
        failures.push({
          transport_number: result.transportNumber,
          error: String(error && error.message),
        });
      }
    }

    return {
      events,
      failures,
      matchedTransports,
      missingTransportNumbers,
      availableTransportCount: allRows.length,
    };
  } finally {
    await context.close();
  }
}

module.exports = {
  fetchLiveVisibilityEvents,
};

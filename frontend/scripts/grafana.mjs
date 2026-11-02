// Example dashboard in Grafana: every panel shows data and no error, then a screenshot.
// The legend of "Betriebszustand" names exactly the state texts that /api/series has in the
// range, so a query that shows codes instead of texts fails. Over 30 and 365 days it must name
// every state of `sections`, Abtauen among them, which the rows of the bucketed answer
// leave out.
//
//   node scripts/grafana.mjs <GRAFANA_URL> <DTALUCHS_URL> <OUT_DIR> [<USER:PASSWORD>]
//
// Grafana must run with contrib/grafana (provisioning and dashboard). The range is the last 7, 30 and 365 days
// of the stock, read from DTALUCHS_URL/api/meta. Pictures go to OUT_DIR; the ones
// in docs/bilder/ for docs/anleitung-grafana.md are copied from there.

import { chromium } from "playwright";

const [grafana, dtaluchs, out, user = "admin:admin"] = process.argv.slice(2);
if (!grafana || !dtaluchs || !out) {
  console.error("node scripts/grafana.mjs <GRAFANA_URL> <DTALUCHS_URL> <OUT_DIR> [<USER:PASSWORD>]");
  process.exit(2);
}
const colon = user.indexOf(":");
if (colon < 0) {
  console.error("Anmeldung als <USER:PASSWORD> angeben");
  process.exit(2);
}
const [username, password] = [user.slice(0, colon), user.slice(colon + 1)];
let meta;
try {
  const res = await fetch(`${dtaluchs}/api/meta`);
  if (!res.ok) throw new Error(`Status ${res.status}`);
  meta = await res.json();
} catch (e) {
  console.error(`${dtaluchs}/api/meta: ${e.message}`);
  process.exit(2);
}
if (!meta.range) {
  console.error(`${dtaluchs}: kein Bestand`);
  process.exit(2);
}
const last = (meta.range.last_ts + 1) * 1000;
const DAY = 86400 * 1000;

// Runs per label of a column of the timeline: a label after another label or after a row without value.
function countRuns(labels) {
  const counts = {};
  labels.forEach((l, i) => {
    if (l !== null && labels[i - 1] !== l) counts[l] = (counts[l] ?? 0) + 1;
  });
  return Object.fromEntries(Object.entries(counts).sort());
}

// What the panel "Betriebszustand" must list: the text per section, without sections per row, without
// text the code, as its jq does, with the points of the panel's query. `sections` is null above
// 2 × points sections.
async function states(from, to, points) {
  const res = await fetch(
    `${dtaluchs}/api/series?from=${from / 1000}&to=${to / 1000}&fields=operating_state&points=${points}`,
  );
  if (!res.ok) throw new Error(`/api/series: Status ${res.status}`);
  const s = (await res.json()).series[0];
  const [values, text] = s.sections ? [s.sections.value, s.sections.text] : [s.value, s.text];
  const labels = values.map((v, i) =>
    v === null ? null : text[i] === null ? String(Math.floor(v)) : s.texts[text[i]],
  );
  return {
    labels: [...new Set(labels.filter((l) => l !== null))].sort(),
    sections: s.sections !== null,
    counts: s.sections ? countRuns(labels.flatMap((l) => [l, null])) : null, // each section on its own
  };
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1400, height: 1700 },
  colorScheme: "light",
});
let failed = false;

// Grafana asks for the login in a form, a basic auth header only counts for the HTTP API.
const login = await context.newPage();
await login.goto(`${grafana}/login`);
await login.getByTestId("data-testid Username input field").fill(username);
await login.getByTestId("data-testid Password input field").fill(password);
const answer = login.waitForResponse((r) => r.url().endsWith("/login") && r.request().method() === "POST");
await login.getByTestId("data-testid Login button").click();
if (!(await answer).ok()) {
  console.error("Anmeldung an Grafana gescheitert");
  process.exit(2);
}
await login.close();

// The points of "Betriebszustand" as Grafana has the dashboard, not as the repo has it.
let statePoints;
let stateTarget;
try {
  const res = await context.request.get(`${grafana}/api/dashboards/uid/dtaluchs-uebersicht`);
  if (!res.ok()) throw new Error(`Status ${res.status()}`);
  const panel = (await res.json()).dashboard.panels.find((p) => p.title === "Betriebszustand");
  stateTarget = panel?.targets[0];
  statePoints = panel?.targets[0].url_options.params.find((q) => q.key === "points")?.value;
  if (panel && !/^\d+$/.test(statePoints ?? "")) {
    throw new Error(`Panel „Betriebszustand“ ohne festen Wert für points (${statePoints})`);
  }
} catch (e) {
  console.error(`${grafana}/api/dashboards/uid/dtaluchs-uebersicht: ${e.message}`);
  await browser.close();
  process.exit(2);
}

// The state column of the panel's own query through Grafana, as the state timeline gets it.
async function panelLabels(from, to) {
  const list = await context.request.get(`${grafana}/api/datasources`);
  const source = (await list.json()).find((d) => d.type === stateTarget.datasource.type);
  if (!source) throw new Error(`keine Datasource vom Typ ${stateTarget.datasource.type}`);
  const target = {
    ...stateTarget,
    datasource: { uid: source.uid, type: source.type },
    url_options: {
      ...stateTarget.url_options,
      params: stateTarget.url_options.params.map((q) =>
        q.key === "from" ? { ...q, value: String(from / 1000) } : q.key === "to" ? { ...q, value: String(to / 1000) } : q,
      ),
    },
  };
  const res = await context.request.post(`${grafana}/api/ds/query`, {
    data: { queries: [target], from: String(from), to: String(to) },
  });
  if (!res.ok()) throw new Error(`/api/ds/query: Status ${res.status()}`);
  const frame = (await res.json()).results?.[target.refId]?.frames?.[0];
  const name = target.columns[1].text;
  const column = frame?.schema?.fields?.findIndex((f) => f.name === name) ?? -1;
  if (column < 0) throw new Error(`Spalte „${name}“ fehlt in der Antwort des Panels`);
  return frame.data.values[column];
}

for (const [name, days, period] of [
  ["7-tage", 7, "day"],
  ["30-tage", 30, "week"],
  ["365-tage", 365, "week"],
]) {
  const page = await context.newPage();
  const url =
    `${grafana}/d/dtaluchs-uebersicht/?orgId=1&from=${last - days * DAY}&to=${last}` +
    `&var-period=${period}&var-feld=hot_gas_temp&var-feld=source_in_temp&theme=light&kiosk`;
  await page.goto(url);
  // PanelChrome is a section whose test id carries the title of the panel.
  const panels = page.locator('section[data-testid^="data-testid Panel header "]');
  await panels.first().waitFor();
  await page.waitForLoadState("networkidle");
  const count = await panels.count();
  let stateSeen = false;
  for (let i = 0; i < count; i++) {
    const p = panels.nth(i);
    await p.scrollIntoViewIfNeeded();
    // A panel with data draws a canvas; "No data" and an error state are text.
    await p
      .locator("canvas, [data-testid*='Panel status error']")
      .or(p.getByText("No data"))
      .first()
      .waitFor({ timeout: 30000 });
    const title = (await p.getAttribute("data-testid")).replace("data-testid Panel header ", "");
    const error = await p.locator("[data-testid*='Panel status error']").count();
    // Panels on "-- Dashboard --" show "No data" until the stats panel has its answer.
    const drawn = await p
      .locator("canvas")
      .first()
      .waitFor({ timeout: 5000 })
      .then(() => true, () => false);
    const noData = !drawn && /No data/.test((await p.textContent()) ?? "");
    let legend = "";
    if (title === "Betriebszustand") stateSeen = true;
    if (title === "Betriebszustand" && drawn) {
      const prefix = "data-testid VizLegend series ";
      const shown = (
        await p.locator(`[data-testid^="${prefix}"]`).evaluateAll((es) => es.map((e) => e.getAttribute("data-testid")))
      )
        .map((t) => t.slice(prefix.length))
        .sort();
      let expected;
      let counts;
      try {
        const got = await states(last - days * DAY, last, statePoints);
        expected = got.labels;
        counts = got.counts;
        // Over 30 days and more the panel must have `sections`: without them it would pass on the rows.
        if (days >= 30 && !got.sections) legend = ` (sections null bei points ${statePoints})`;
      } catch (e) {
        console.error(`${dtaluchs}: ${e.message}`);
        await browser.close();
        process.exit(2);
      }
      if (!legend && JSON.stringify(shown) !== JSON.stringify(expected)) {
        legend = ` (Legende ${JSON.stringify(shown)}, erwartet ${JSON.stringify(expected)})`;
      }
      // The legend only names the states; the runs per state tell a panel with every section from one
      // with the most frequent state per interval.
      if (!legend && counts) {
        try {
          const got = countRuns(await panelLabels(last - days * DAY, last));
          if (JSON.stringify(got) !== JSON.stringify(counts)) {
            legend = ` (Abschnitte je Zustand ${JSON.stringify(got)}, erwartet ${JSON.stringify(counts)})`;
          }
        } catch (e) {
          legend = ` (${e.message})`;
        }
      }
    }
    const ok = !error && !noData && !legend;
    if (!ok) failed = true;
    console.log(
      `${name} ${ok ? "ok    " : "FEHLER"} ${title}${error ? " (Fehler)" : ""}${noData ? " (keine Daten)" : ""}${legend}`,
    );
  }
  if (!stateSeen) {
    failed = true;
    console.log(`${name} FEHLER Panel „Betriebszustand“ fehlt`);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${out}/grafana-${name}.png`, fullPage: true });
  await page.close();
}

await browser.close();
process.exit(failed ? 1 : 0);

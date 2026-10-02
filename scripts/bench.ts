// Runs the canvas benchmark (playground/bench.html) in headless Chromium and saves the results.
// Start the playground first (`pnpm dev`), then:
//
//   pnpm bench                                  # n = 70, 200, 500; saves bench/results/<label>.json
//   pnpm bench --label before --cpu 4           # 4x CPU throttling
//   pnpm bench --n 200 --previews --headed
//   pnpm bench --compare bench/results/before.json bench/results/after.json
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: process.env.BENCH_URL ?? "http://localhost:5173" },
    n: { type: "string", multiple: true },
    steps: { type: "string", default: "60" },
    reps: { type: "string", default: "3" },
    cpu: { type: "string", default: "1" },
    previews: { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
    scenarios: { type: "string" },
    label: { type: "string" },
    compare: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const ROOT = resolve(import.meta.dirname, "..");

interface Stats {
  steps: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
  longFrames: number;
}
interface Report {
  impl: string;
  nodes: number;
  edges: number;
  mountMs: number;
  heapMB?: number;
  domNodes: number;
  results: Record<string, Stats>;
}
interface Run {
  label: string;
  cpu: number;
  previews: boolean;
  reports: Report[];
}

if (values.compare) await compare(process.argv.slice(2).filter((a) => a.endsWith(".json")));
else await run();

async function run() {
  const sizes = (values.n ?? ["70", "200", "500"]).map(Number);
  const cpu = Number(values.cpu);
  const browser = await chromium.launch({ headless: !values.headed });
  const reports: Report[] = [];
  try {
    for (const n of sizes) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      page.on("pageerror", (e) => console.error(`[page] ${e.message}`));
      if (cpu > 1) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: cpu });
      const q = new URLSearchParams({ n: String(n), steps: values.steps!, reps: values.reps!, previews: values.previews ? "1" : "0" });
      if (values.scenarios) q.set("scenarios", values.scenarios);
      process.stdout.write(`n=${n} … `);
      await page.goto(`${values.url}/bench.html?${q}`);
      const report = (await page.waitForFunction(() => (window as unknown as { __bench?: unknown }).__bench, null, { timeout: 15 * 60_000, polling: 1000 })).jsonValue() as Promise<Report>;
      const r = await report;
      reports.push(r);
      console.log(`${r.impl}, ${r.nodes} nodes / ${r.edges} edges, mount ${r.mountMs} ms`);
      printTable(r);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  const label = values.label ?? `${reports[0]?.impl ?? "run"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const file = join(ROOT, "bench", "results", `${label}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ label, cpu, previews: values.previews, reports } satisfies Run, null, 2));
  console.log(`\nsaved ${file}`);
}

function printTable(r: Report) {
  console.table(Object.fromEntries(Object.entries(r.results).map(([k, s]) => [k, { median: s.median, p95: s.p95, max: s.max, longFrames: s.longFrames }])));
}

/** Side by side: median and p95 per scenario and size, with the change from the first file. */
async function compare(files: string[]) {
  if (files.length !== 2) throw new Error("--compare takes two result files");
  const [a, b] = (await Promise.all(files.map((f) => readFile(f, "utf8")))).map((t) => JSON.parse(t) as Run);
  const pct = (x: number, y: number) => (x ? `${y >= x ? "+" : ""}${Math.round(((y - x) / x) * 100)}%` : "");
  for (const ra of a.reports) {
    const rb = b.reports.find((r) => r.nodes === ra.nodes);
    if (!rb) continue;
    console.log(`\n${ra.nodes} nodes: ${a.label} (${ra.impl}) → ${b.label} (${rb.impl})`);
    const rows: Record<string, Record<string, string | number>> = {
      mount: { a: ra.mountMs, b: rb.mountMs, change: pct(ra.mountMs, rb.mountMs) },
    };
    for (const [k, sa] of Object.entries(ra.results)) {
      const sb = rb.results[k];
      if (!sb) continue;
      rows[`${k} median`] = { a: sa.median, b: sb.median, change: pct(sa.median, sb.median) };
      rows[`${k} p95`] = { a: sa.p95, b: sb.p95, change: pct(sa.p95, sb.p95) };
    }
    if (ra.heapMB && rb.heapMB) rows.heapMB = { a: ra.heapMB, b: rb.heapMB, change: pct(ra.heapMB, rb.heapMB) };
    rows.domNodes = { a: ra.domNodes, b: rb.domNodes, change: pct(ra.domNodes, rb.domNodes) };
    console.table(rows);
  }
}

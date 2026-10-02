// CPU profile of benchmark scenarios: the functions with the most self time.
//   pnpm tsx scripts/bench-profile.ts --url http://localhost:5173 --n 500 --scenarios connect
//   pnpm tsx scripts/bench-profile.ts --url http://localhost:5173 --n 500 --mount
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:5173" },
    n: { type: "string", default: "500" },
    scenarios: { type: "string", default: "connect" },
    top: { type: "string", default: "25" },
    /** Profile loading and mounting the editor instead of the scenarios. */
    mount: { type: "boolean", default: false },
  },
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
const url = `${values.url}/bench.html?n=${values.n}&reps=1&steps=60&scenarios=${values.scenarios}`;
if (values.mount) {
  await cdp.send("Profiler.start");
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById("status")?.textContent?.startsWith("rep"), null, { timeout: 120_000 });
} else {
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById("status")?.textContent?.startsWith("rep"), null, { timeout: 120_000 });
  await cdp.send("Profiler.start");
  await page.waitForFunction(() => (window as unknown as { __bench?: unknown }).__bench, null, { timeout: 600_000, polling: 500 });
}
const { profile } = await cdp.send("Profiler.stop");
await browser.close();

const dt = new Map<number, number>();
profile.samples!.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas![i] ?? 0)));
const self = new Map<string, number>();
for (const node of profile.nodes) {
  const f = node.callFrame;
  const key = `${f.functionName || "(anon)"}  ${f.url.replace(/^.*\/(node_modules\/\.vite\/deps|src|packages)\//, "$1/").replace(/\?.*$/, "")}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (dt.get(node.id) ?? 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
for (const [k, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(values.top)))
  console.log(`${(us / 1000).toFixed(1).padStart(8)} ms ${((us / total) * 100).toFixed(1).padStart(5)}%  ${k}`);

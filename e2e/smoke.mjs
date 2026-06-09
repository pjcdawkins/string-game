/**
 * End-to-end smoke test: loads the built app in headless Chromium, drives the
 * UI (auto-bow, finger stop, pluck) and checks that the audio engine actually
 * produces a tone at the expected pitch. Run with:
 *
 *   npm run build && node e2e/smoke.mjs
 */
import { chromium } from "playwright";
import { preview } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const server = await preview({ root, preview: { port: 5198, strictPort: true } });
const url = "http://localhost:5198/";

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

await page.goto(url);
await page.click("#closeHelp");
await page.waitForFunction(() => window.__debug !== undefined);

const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};
const ok = (msg) => console.log("ok:", msg);

// median pitch over several samples, so a bow-change transient can't skew it
async function medianPitch(samples = 9, gapMs = 160) {
  const vals = [];
  for (let i = 0; i < samples; i++) {
    vals.push(await page.evaluate(() => window.__debug.state.detectedFreq));
    await page.waitForTimeout(gapMs);
  }
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

// 1. auto-bow the open A string and verify pitch ~440
await page.click("#autobow");
await page.waitForTimeout(1500);
let res = await page.evaluate(() => ({
  rms: window.__debug.state.meter.rms,
  bowing: window.__debug.state.meter.bowing,
  slip: window.__debug.state.meter.slipRatio,
}));
res.freq = await medianPitch();
if (res.rms < 0.003) fail(`auto-bow produced no sound (rms=${res.rms})`);
else ok(`auto-bow sounding, rms=${res.rms.toFixed(4)}, slipRatio=${res.slip.toFixed(2)}`);
if (Math.abs(res.freq - 440) > 440 * 0.04) fail(`open A pitch off: ${res.freq.toFixed(1)} Hz`);
else ok(`open A detected at ${res.freq.toFixed(1)} Hz`);

// 2. stop a perfect fifth (7 semitones -> E5 659.3) via pointer on the fingerboard
const stopPos = 1 - Math.pow(2, -7 / 12);
const pt = await page.evaluate(
  (s) => window.__debug.view.stringToScreen(s, 0),
  stopPos
);
await page.mouse.move(pt.clientX, pt.clientY);
await page.mouse.down();
await page.waitForTimeout(300);
await page.mouse.up(); // finger latches
await page.waitForTimeout(1200);
res = await page.evaluate(() => ({
  fingerOn: window.__debug.state.fingerOn,
}));
res.freq = await medianPitch();
if (!res.fingerOn) fail("finger did not latch");
if (Math.abs(res.freq - 659.3) > 659.3 * 0.04)
  fail(`stopped fifth pitch off: ${res.freq.toFixed(1)} Hz (expected ~659.3)`);
else ok(`stopped fifth detected at ${res.freq.toFixed(1)} Hz`);

await page.screenshot({ path: "e2e/bowing.png" });

// 3. stop bowing, lift finger, pluck with the pick
await page.click("#autobow");
await page.keyboard.press("Escape");
await page.click('[data-tool="pick"]');
const pl = await page.evaluate(() => window.__debug.view.stringToScreen(0.85, 0));
await page.mouse.move(pl.clientX, pl.clientY);
await page.mouse.down();
const bend = await page.evaluate(() => window.__debug.view.stringToScreen(0.85, 0.45));
await page.mouse.move(bend.clientX, bend.clientY, { steps: 8 });
await page.screenshot({ path: "e2e/bend.png" });
await page.mouse.up();
await page.waitForTimeout(400);
res = await page.evaluate(() => ({
  rms: window.__debug.state.meter.rms,
  freq: window.__debug.state.detectedFreq,
}));
if (res.rms < 0.002) fail(`pluck produced no sound (rms=${res.rms})`);
else ok(`pluck sounding, rms=${res.rms.toFixed(4)}`);
if (res.freq > 0 && Math.abs(res.freq - 440) > 440 * 0.04)
  fail(`plucked open A pitch off: ${res.freq.toFixed(1)} Hz`);
else ok(`plucked open A at ${res.freq.toFixed(1)} Hz`);
await page.screenshot({ path: "e2e/pluck.png" });

if (errors.length) {
  fail("page errors:\n" + errors.join("\n"));
} else {
  ok("no page errors");
}

await browser.close();
await server.close();
process.exit(process.exitCode ?? 0);

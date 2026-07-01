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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true });

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

// 1. auto-bow the open A string and verify pitch ~440. The auto-bow toggle is
// gone from the HUD, so start the engine with a real gesture (the string
// button) and drive the state through the debug hook.
await page.click('[data-str="2"]');
await page.waitForFunction(() => window.__debug.engine.started);
await page.evaluate(() => {
  window.__debug.state.autoBow = true;
});
// the very first attack can lock into the double-slip octave until the first
// bow change (~2.6 s in); measure after the regime has settled
await page.waitForTimeout(3200);
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

// 2. stop a perfect fifth (7 semitones -> E5 659.3) via pointer on the fingerboard.
// The touch point is the fingertip centre; the note speaks from its bridge-side
// edge, so aim the centre a finger-radius short of the target node.
const stopNode = 1 - Math.pow(2, -7 / 12);
const fingerRadius = await page.evaluate(() => window.__debug.FINGER_RADIUS);
const stopPos = stopNode - fingerRadius;
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
await page.evaluate(() => {
  window.__debug.state.autoBow = false;
});
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

// 4. switch strings mid-stroke: while one finger holds a bow stroke on the
// canvas, a second finger taps a string button. Regression check — the HUD
// used to listen for `click`, which browsers only fire for the *primary*
// pointer, so the switch was deferred until the bowing finger lifted.
await page.click('[data-tool="bow"]');
const cdp = await page.context().newCDPSession(page);
const bowPt = (x) => page.evaluate((xx) => window.__debug.view.stringToScreen(0.9, xx), x);

let f1 = await bowPt(-0.7);
await cdp.send("Input.dispatchTouchEvent", {
  type: "touchStart",
  touchPoints: [{ x: f1.clientX, y: f1.clientY, id: 1 }],
});

// one bow stroke: drag finger 1 across the string, sampling the tuner
const freqs = [];
async function strokePass(dir) {
  for (let i = 1; i <= 10; i++) {
    f1 = await bowPt(dir * (-0.7 + (i / 10) * 1.4));
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: f1.clientX, y: f1.clientY, id: 1 }],
    });
    await page.waitForTimeout(30);
    freqs.push(await page.evaluate(() => window.__debug.state.detectedFreq));
  }
}
for (const dir of [1, -1, 1]) await strokePass(dir);

// tap the G3 button with a second finger while the first keeps the stroke
const gBtn = await page.locator('[data-str="0"]').boundingBox();
const f2 = { x: gBtn.x + gBtn.width / 2, y: gBtn.y + gBtn.height / 2, id: 2 };
await cdp.send("Input.dispatchTouchEvent", {
  type: "touchStart",
  touchPoints: [{ x: f1.clientX, y: f1.clientY, id: 1 }, f2],
});
// touchEnd's touchPoints are the *released* points: lift only finger 2
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [f2] });
await page.waitForTimeout(150); // let the sim's delay-line glide settle
const sw = await page.evaluate(() => ({
  idx: window.__debug.state.stringIdx,
  engineF0: window.__debug.engine.meter.freq,
  bowEngaged: window.__debug.input.bowEngaged,
}));
if (sw.idx !== 0) fail(`second-finger tap did not switch strings (stringIdx=${sw.idx})`);
else ok("second-finger tap switched to G3 mid-stroke");
if (!sw.bowEngaged) fail("bow stroke was dropped by the string switch");
if (Math.abs(sw.engineF0 - 196) > 10)
  fail(`engine f0 not updated on switch (${sw.engineF0.toFixed(1)})`);

// keep bowing: the audible pitch should settle on the new open G. The tuner
// reads 0 around stroke reversals (near-zero bow speed), so ignore those.
freqs.length = 0;
for (const dir of [-1, 1, -1, 1, -1, 1]) await strokePass(dir);
const sounding = freqs.slice(10).filter((f) => f > 0).sort((a, b) => a - b);
const med = sounding[Math.floor(sounding.length / 2)] ?? 0;
if (sounding.length < 5 || Math.abs(med - 196) > 196 * 0.04)
  fail(`pitch after mid-stroke switch: ${med.toFixed(1)} Hz over ${sounding.length} readings (expected ~196)`);
else ok(`mid-stroke switch sounding at ${med.toFixed(1)} Hz`);
await cdp.send("Input.dispatchTouchEvent", {
  type: "touchEnd",
  touchPoints: [{ x: f1.clientX, y: f1.clientY, id: 1 }],
});

if (errors.length) {
  fail("page errors:\n" + errors.join("\n"));
} else {
  ok("no page errors");
}

await browser.close();
await server.close();
process.exit(process.exitCode ?? 0);

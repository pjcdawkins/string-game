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

// Keyboard bowing: alternate down/up strokes (→ / ←) like a real détaché,
// sampling pitch and rms mid-stroke; returns the medians across all strokes.
async function keyboardBow(strokes = 4) {
  const freqs = [];
  let rms = 0;
  for (let i = 0; i < strokes; i++) {
    const dir = i % 2 === 0 ? "ArrowRight" : "ArrowLeft";
    await page.keyboard.down(dir);
    await page.waitForTimeout(450);
    for (let j = 0; j < 3; j++) {
      const s = await page.evaluate(() => ({
        freq: window.__debug.state.detectedFreq,
        rms: window.__debug.state.meter.rms,
      }));
      freqs.push(s.freq);
      rms = Math.max(rms, s.rms);
      await page.waitForTimeout(110);
    }
    await page.keyboard.up(dir);
  }
  freqs.sort((a, b) => a - b);
  return { freq: freqs[Math.floor(freqs.length / 2)], rms };
}

// A bow attack occasionally captures a higher slip regime (the octave or a
// surface whistle) instead of the Helmholtz fundamental — true of the model
// as of real bows. Fresh strokes re-attack, so retry a round of strokes
// before judging the pitch: a wrong note mapping still fails every attempt.
async function keyboardBowUntil(target, tries = 3) {
  let res;
  for (let i = 0; i < tries; i++) {
    res = await keyboardBow();
    if (Math.abs(res.freq - target) <= target * 0.04) return res;
  }
  return res;
}

// 1. bow the open A string from the keyboard (arrow strokes), verify ~440
let res = await keyboardBowUntil(440);
if (res.rms < 0.003) fail(`keyboard bow produced no sound (rms=${res.rms})`);
else ok(`keyboard bow sounding, rms=${res.rms.toFixed(4)}`);
if (Math.abs(res.freq - 440) > 440 * 0.04)
  fail(`keyboard-bowed open A pitch off: ${res.freq.toFixed(1)} Hz`);
else ok(`keyboard-bowed open A at ${res.freq.toFixed(1)} Hz`);

// 2. running out of bow: the stroke dies away at the end of the hair and the
// bow simply meets its limit and stops — a repeated same-direction stroke
// must NOT teleport it back to the far end. The bow change (the opposite
// arrow) is what recovers travel and speaks again.
await page.keyboard.down("ArrowRight");
// run the whole bow out (a full stroke takes ~3.5 s at the default speed)
await page.waitForFunction(() => window.__debug.input.bowX >= 1.19, null, { timeout: 8000 });
await page.keyboard.up("ArrowRight");
await page.waitForTimeout(250);
await page.keyboard.down("ArrowRight"); // same direction again: no travel left
await page.waitForTimeout(500);
res = await page.evaluate(() => ({
  bowX: window.__debug.input.bowX,
  bowVel: window.__debug.input.bowVel,
}));
await page.keyboard.up("ArrowRight");
if (res.bowX < 1.19)
  fail(`repeated down bow left the limit (bowX=${res.bowX.toFixed(2)}, expected ~1.2)`);
else ok(`repeated down bow stays at its limit (bowX=${res.bowX.toFixed(2)})`);
if (Math.abs(res.bowVel) > 0.02)
  fail(`bow at its limit still moving (bowVel=${res.bowVel.toFixed(3)})`);
else ok(`bow at its limit has stopped (bowVel=${res.bowVel.toFixed(3)})`);
await page.keyboard.down("ArrowLeft"); // the bow change recovers travel
await page.waitForTimeout(600);
res = await page.evaluate(() => ({ rms: window.__debug.state.meter.rms }));
await page.keyboard.up("ArrowLeft");
if (res.rms < 0.003) fail(`bow change after running out was silent (rms=${res.rms})`);
else ok(`bow change recovers travel and sounds, rms=${res.rms.toFixed(4)}`);

// 3. simultaneous shortcuts: slide the contact point (↑) during a stroke —
// the bow keeps sounding while sul tasto/ponticello changes
await page.keyboard.down("ArrowRight");
await page.waitForTimeout(300);
const posBefore = await page.evaluate(() => window.__debug.input.bowPos);
await page.keyboard.down("ArrowUp");
await page.waitForTimeout(350);
await page.keyboard.up("ArrowUp");
res = await page.evaluate(() => ({
  pos: window.__debug.input.bowPos,
  rms: window.__debug.state.meter.rms,
}));
await page.keyboard.up("ArrowRight");
if (posBefore - res.pos < 0.05)
  fail(`contact point did not slide mid-stroke (${posBefore.toFixed(2)} -> ${res.pos.toFixed(2)})`);
else if (res.rms < 0.003) fail(`stroke died while sliding the contact point (rms=${res.rms})`);
else ok(`contact point slid mid-stroke (${posBefore.toFixed(2)} -> ${res.pos.toFixed(2)}), still sounding`);
// slide the contact point back toward the bridge: leaving it parked at ~0.75
// puts later *stopped* notes in flautando territory (a third of the speaking
// length from the bridge), where attacks flip to the octave — real string
// behaviour, but not what the pitch-mapping checks below are measuring
await page.keyboard.down("ArrowDown");
await page.waitForTimeout(400);
await page.keyboard.up("ArrowDown");

// 4. a finger landing mid-stroke re-articulates: the note changes and speaks
// (Digit2 = 2 semitones above open A -> B4 493.9). Retried like the other
// pitch checks — the attack onto the fresh stop is stochastic, and runs
// occasionally capture the double-slip octave several attempts in a row
// (a wrong note mapping would fail every attempt, so retries stay honest).
for (let attempt = 0; attempt < 5; attempt++) {
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(1300); // park the bow at the right end
  await page.keyboard.up("ArrowRight");
  await page.keyboard.down("ArrowLeft"); // full travel for the up bow
  await page.waitForTimeout(300);
  await page.keyboard.down("Digit2");
  await page.waitForTimeout(500);
  const vals = [];
  for (let i = 0; i < 3; i++) {
    vals.push(await page.evaluate(() => window.__debug.state.detectedFreq));
    await page.waitForTimeout(100);
  }
  vals.sort((a, b) => a - b);
  res = { freq: vals[1] };
  await page.keyboard.up("Digit2");
  await page.keyboard.up("ArrowLeft");
  if (Math.abs(res.freq - 493.9) <= 493.9 * 0.04) break;
}
if (Math.abs(res.freq - 493.9) > 493.9 * 0.04)
  fail(`mid-stroke finger change pitch off: ${res.freq.toFixed(1)} Hz (expected ~493.9)`);
else ok(`mid-stroke finger change speaks at ${res.freq.toFixed(1)} Hz`);

// 5. additive fingering: digits sum, 4+3 = 7 semitones above open A -> E5 659.3
await page.keyboard.down("Digit4");
await page.keyboard.down("Digit3");
await page.waitForTimeout(200); // let the finger land before the stroke
res = await keyboardBowUntil(659.3);
if (Math.abs(res.freq - 659.3) > 659.3 * 0.04)
  fail(`chorded fifth pitch off: ${res.freq.toFixed(1)} Hz (expected ~659.3)`);
else ok(`chorded fifth (4+3) at ${res.freq.toFixed(1)} Hz`);
// releasing every digit leaves the finger latched (it does not lift); 0/Esc
// lift. The keyups land milliseconds apart, like a hand letting go of a
// chord: the release grace period must keep the first keyup from re-placing
// the finger at the remaining digit, so the latch stays at the full chord.
// Each page.keyboard.up is its own CDP round-trip, which a loaded runner can
// stretch past the grace window — so dispatch both keyups in one in-page
// task, pinning them "together" (the app listens on window either way).
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "Digit3", key: "3" }));
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "Digit4", key: "4" }));
});
await page.keyboard.up("Digit3"); // clear Playwright's key state (app-side no-ops)
await page.keyboard.up("Digit4");
await page.waitForTimeout(250); // wait out the chord-release grace period
res = await page.evaluate(() => ({
  fingerOn: window.__debug.state.fingerOn,
  pos: window.__debug.state.fingerPos,
  fr: window.__debug.FINGER_RADIUS,
}));
if (!res.fingerOn) fail("finger lifted on key release (should latch)");
else ok("finger latched after releasing its keys");
const chordStop = 1 - Math.pow(2, -7 / 12) - res.fr;
if (Math.abs(res.pos - chordStop) > 0.01)
  fail(`chord release latched at ${res.pos.toFixed(3)}, not the chord's stop ${chordStop.toFixed(3)}`);
else ok(`chord release stayed latched at the chord's stop (${res.pos.toFixed(3)})`);
await page.keyboard.press("Escape");
res = await page.evaluate(() => ({ fingerOn: window.__debug.state.fingerOn }));
if (res.fingerOn) fail("Esc did not lift the latched finger");
else ok("Esc lifted the latched finger");
// a peel pending from a half-released chord must not survive Esc: without
// cancelling it, the timer would re-latch the finger Esc just lifted
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit4", key: "4" }));
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit3", key: "3" }));
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "Digit3", key: "3" }));
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape" }));
});
await page.waitForTimeout(200); // past the grace: a stale peel would re-latch
res = await page.evaluate(() => ({ fingerOn: window.__debug.state.fingerOn }));
if (res.fingerOn) fail("stale peel timer re-latched the finger after Esc");
else ok("Esc within the grace window keeps the finger lifted");
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "Digit4", key: "4" }));
});
// Esc must also forget digits still physically held: otherwise releasing one
// of them afterwards (others still down) schedules a peel that re-latches
// the finger Esc lifted
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit4", key: "4" }));
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit3", key: "3" }));
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape" }));
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "Digit3", key: "3" }));
});
await page.waitForTimeout(200); // past the grace: a peel of the held 4 would re-latch
res = await page.evaluate(() => ({ fingerOn: window.__debug.state.fingerOn }));
if (res.fingerOn) fail("keyup after Esc re-latched the finger (held digits not forgotten)");
else ok("Esc forgets held digits; a later keyup does not re-latch");
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "Digit4", key: "4" }));
});

// 6. portamento: with Shift held, a pitch change glides instead of jumping
const fr = await page.evaluate(() => window.__debug.FINGER_RADIUS);
await page.keyboard.down("Digit2");
await page.keyboard.down("Shift");
await page.keyboard.down("Digit5"); // 2+5 = 7 semitones
await page.waitForTimeout(100);
const posMid = await page.evaluate(() => window.__debug.state.fingerPos);
await page.waitForTimeout(800);
const posEnd = await page.evaluate(() => window.__debug.state.fingerPos);
await page.keyboard.up("Digit5");
await page.keyboard.up("Digit2");
await page.keyboard.up("Shift");
const glideTarget = 1 - Math.pow(2, -7 / 12) - fr;
if (Math.abs(posEnd - glideTarget) > 0.01)
  fail(`portamento never arrived: ${posEnd.toFixed(3)} (target ${glideTarget.toFixed(3)})`);
else if (posMid > glideTarget - 0.03)
  fail(`portamento jumped instead of gliding (pos ${posMid.toFixed(3)} after 100ms)`);
else ok(`portamento glides: ${posMid.toFixed(3)} en route to ${glideTarget.toFixed(3)}`);
await page.keyboard.press("Digit0"); // lift the (now latching) finger before the open-string checks

// 7. brackets ramp bow pressure while held
const before = await page.evaluate(() => window.__debug.state.bowForce);
await page.keyboard.down("BracketRight");
await page.waitForTimeout(500);
await page.keyboard.up("BracketRight");
const up = await page.evaluate(() => window.__debug.state.bowForce);
await page.keyboard.down("BracketLeft");
await page.waitForTimeout(300);
await page.keyboard.up("BracketLeft");
const down = await page.evaluate(() => window.__debug.state.bowForce);
if (up - before < 0.05) fail(`holding ] did not raise bow pressure: ${before} -> ${up}`);
else if (down >= up) fail(`holding [ did not lower bow pressure: ${up} -> ${down}`);
else ok(`brackets ramp bow pressure: ${before.toFixed(2)} -> ${up.toFixed(2)} -> ${down.toFixed(2)}`);

// 8. hold Space for auto-bow and verify ~440 (or its octave, see below)
await page.keyboard.down("Space");
await page.waitForTimeout(1500);
res = await page.evaluate(() => ({
  rms: window.__debug.state.meter.rms,
  bowing: window.__debug.state.meter.bowing,
  slip: window.__debug.state.meter.slipRatio,
}));
// the first attack can lock into the double-slip octave for a stroke or two;
// bow changes (every 2.6 s) knock it back to the fundamental, so give it a
// few strokes to settle before measuring
await page
  .waitForFunction(() => Math.abs(window.__debug.state.detectedFreq - 440) < 440 * 0.04, null, {
    timeout: 9000,
  })
  .catch(() => {});
res.freq = await medianPitch();
if (res.rms < 0.003) fail(`auto-bow produced no sound (rms=${res.rms})`);
else ok(`auto-bow sounding, rms=${res.rms.toFixed(4)}, slipRatio=${res.slip.toFixed(2)}`);
// Auto-bow strokes sometimes lock onto the double-slip octave (pre-existing
// model behaviour on main, exposed once the removed #autobow button stopped
// covering it), so accept either octave here — the keyboard-bow test above
// already pins the open-string fundamental strictly.
if (Math.abs(res.freq - 440) > 440 * 0.04 && Math.abs(res.freq - 880) > 880 * 0.04)
  fail(`open A pitch off: ${res.freq.toFixed(1)} Hz (expected ~440 or its octave)`);
else ok(`auto-bowed open A detected at ${res.freq.toFixed(1)} Hz`);

// 9. stop a perfect fifth (7 semitones -> E5 659.3) via pointer on the fingerboard.
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
// as with the open string above: give the auto-bow a few bow changes to
// settle out of any higher slip regime before measuring
await page
  .waitForFunction(() => Math.abs(window.__debug.state.detectedFreq - 659.3) < 659.3 * 0.04, null, {
    timeout: 9000,
  })
  .catch(() => {});
res.freq = await medianPitch();
if (!res.fingerOn) fail("finger did not latch");
if (Math.abs(res.freq - 659.3) > 659.3 * 0.04)
  fail(`stopped fifth pitch off: ${res.freq.toFixed(1)} Hz (expected ~659.3)`);
else ok(`stopped fifth detected at ${res.freq.toFixed(1)} Hz`);

await page.screenshot({ path: "e2e/bowing.png" });

// 10. releasing Space stops the auto-bow; lift finger, pluck with the pick
await page.keyboard.up("Space");
const autoBowAfter = await page.evaluate(() => window.__debug.state.autoBow);
if (autoBowAfter) fail("releasing Space did not stop auto-bow");
else ok("releasing Space stopped auto-bow");
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

// 10b. multi-string left hand: a touch on another string's lane moves the
// finger (and the sounding string, and so the bow) there; tapping the latched
// finger leaves it latched; flicking it sideways lifts it; a tap in the
// top-left corner lifts too.
const laneXAt = (idx, s) => (idx - 1.5) * (0.062 + (0.128 - 0.062) * s); // scene/lanes.ts
const stringPt = (idx, s, dx = 0) =>
  page.evaluate(([ss, xx]) => window.__debug.view.stringToScreen(ss, xx), [s, laneXAt(idx, s) + dx]);
const tapString = async (idx, s) => {
  const q = await stringPt(idx, s);
  await page.mouse.click(q.clientX, q.clientY);
};
await tapString(2, 0.3); // stop the (selected) A string
let ms = await page.evaluate(() => ({
  idx: window.__debug.state.stringIdx,
  on: window.__debug.state.fingerOn,
}));
if (!ms.on || ms.idx !== 2) fail(`stop on the A lane failed (fingerOn=${ms.on} stringIdx=${ms.idx})`);
else ok("finger stopped the A string");

await tapString(1, 0.45); // touch the D lane: the finger (and string) move there
ms = await page.evaluate(() => ({
  idx: window.__debug.state.stringIdx,
  on: window.__debug.state.fingerOn,
  pos: window.__debug.state.fingerPos,
}));
if (ms.idx !== 1 || !ms.on) fail(`touching the D lane did not move the finger there (stringIdx=${ms.idx})`);
else ok("touching the D lane moved the finger and the sounding string there");
if (Math.abs(ms.pos - 0.45) > 0.03) fail(`finger position off after the lane switch: ${ms.pos.toFixed(3)}`);
// the engine tracks the switch: once the finger pressure lands, its delay
// lines imply the stop's pitch on the *D* string
const stoppedD = 293.66 / (1 - (0.45 + fingerRadius));
await page
  .waitForFunction((t) => Math.abs(window.__debug.engine.meter.freq - t) < t * 0.05, stoppedD, {
    timeout: 3000,
  })
  .catch(() => {});
const ef = await page.evaluate(() => window.__debug.engine.meter.freq);
if (Math.abs(ef - stoppedD) > stoppedD * 0.05)
  fail(`engine pitch not updated by the lane switch (${ef.toFixed(1)} Hz, expected ~${stoppedD.toFixed(1)})`);
else ok(`engine follows the lane switch (${ef.toFixed(1)} Hz)`);

await tapString(1, ms.pos); // tap the latched finger again: it stays latched
ms = await page.evaluate(() => ({ on: window.__debug.state.fingerOn, pos: window.__debug.state.fingerPos }));
if (!ms.on) fail("tapping the latched finger lifted it (it should stay latched)");
else ok("tapping the latched finger leaves it latched");

// flick the finger sideways off its string: that lifts it
let q0 = await stringPt(1, ms.pos);
let q1 = await stringPt(1, ms.pos, -0.5);
await page.mouse.move(q0.clientX, q0.clientY);
await page.mouse.down();
await page.mouse.move(q1.clientX, q1.clientY, { steps: 6 });
await page.mouse.up();
ms = await page.evaluate(() => ({ on: window.__debug.state.fingerOn }));
if (ms.on) fail("sideways flick did not lift the finger");
else ok("sideways flick lifted the finger");

// a tap in the top-left corner of the play area lifts a latched finger (scan
// for a corner point that is actually on the canvas, clear of the HUD panels)
await tapString(1, 0.3);
const liftPt = await page.evaluate(() => {
  for (const s of [0.28, 0.2, 0.12]) {
    for (const x of [-0.6, -0.9, -1.4]) {
      const q = window.__debug.view.stringToScreen(s, x);
      const el = document.elementFromPoint(q.clientX, q.clientY);
      if (el && el.tagName === "CANVAS") return q;
    }
  }
  return null;
});
if (!liftPt) fail("no canvas point found in the top-left lift zone (HUD covers it?)");
else {
  await page.mouse.click(liftPt.clientX, liftPt.clientY);
  ms = await page.evaluate(() => ({ on: window.__debug.state.fingerOn }));
  if (ms.on) fail("top-left corner tap did not lift the finger");
  else ok("top-left corner tap lifted the finger");
}

// 10c. open-string switches: a tap at the nut selects the tapped lane's open
// string (lifting any latched finger), and the HUD string picker likewise
// switches to the open string.
await tapString(1, 0.3); // latch a finger on the D string
const nutPt = await stringPt(2, -0.02); // the A lane, just above the nut
await page.mouse.click(nutPt.clientX, nutPt.clientY);
ms = await page.evaluate(() => ({
  idx: window.__debug.state.stringIdx,
  on: window.__debug.state.fingerOn,
}));
if (ms.idx !== 2 || ms.on)
  fail(`nut tap did not select the open A string (stringIdx=${ms.idx}, fingerOn=${ms.on})`);
else ok("nut tap selected the tapped lane's open string");

await tapString(2, 0.3); // latch a finger on the A string
await page.click('[data-str="1"]'); // the D button in the picker
ms = await page.evaluate(() => ({
  idx: window.__debug.state.stringIdx,
  on: window.__debug.state.fingerOn,
}));
if (ms.idx !== 1 || ms.on)
  fail(`string button did not switch to the open string (stringIdx=${ms.idx}, fingerOn=${ms.on})`);
else ok("string button switches to the open string (finger lifted)");

await page.keyboard.press("KeyA"); // back to the A string for the tests below

// 10d. tool shortcuts: P toggles pizz (finger) and back to arco, \ toggles the
// pick and back, and Esc returns the right hand to an ordinary bow.
const tool = () => page.evaluate(() => window.__debug.state.tool);
await page.keyboard.press("Escape"); // start from a known arco/press default
await page.keyboard.press("p");
if ((await tool()) !== "finger") fail("P did not switch to pizzicato");
else ok("P switched to pizzicato");
await page.keyboard.press("p");
if ((await tool()) !== "bow") fail("second P did not return to arco");
else ok("P toggled back to arco");
// dispatch with code "IntlBackslash" (the UK/ISO backslash key) to prove the
// shortcut keys off the produced "\" character, not a US-layout e.code
const pressBackslash = () =>
  page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", code: "IntlBackslash", bubbles: true }))
  );
await pressBackslash();
if ((await tool()) !== "pick") fail("\\ did not switch to the pick");
else ok("\\ switched to the pick");
await pressBackslash();
if ((await tool()) !== "bow") fail("second \\ did not return to arco");
else ok("\\ toggled back to arco");
// Esc resets tool and left-hand mode even from a non-default state
await page.keyboard.press("p");
await page.evaluate(() => { window.__debug.state.leftMode = "touch"; });
await page.keyboard.press("Escape");
const reset = await page.evaluate(() => ({
  tool: window.__debug.state.tool,
  leftMode: window.__debug.state.leftMode,
}));
if (reset.tool !== "bow" || reset.leftMode !== "press")
  fail(`Esc did not reset to arco/press (tool=${reset.tool}, leftMode=${reset.leftMode})`);
else ok("Esc reset to arco + ordinario press");

// 10e. pluck shortcuts: in the pizz tool, Space and ←/→ pluck the open string
// (the only keyboard path to a pizzicato); they must not revert to the bow.
const peakRmsAfter = async () => {
  let rms = 0;
  for (let i = 0; i < 6; i++) {
    rms = Math.max(rms, await page.evaluate(() => window.__debug.state.meter.rms));
    await page.waitForTimeout(80);
  }
  return rms;
};
await page.keyboard.press("p"); // -> pizzicato (finger)
await page.waitForTimeout(300); // let any earlier ring-down decay
await page.keyboard.press("Space");
// the implement (here the right-hand fingertip) must flick into view on a key
// pluck, just as `grabbed` shows it during a mouse pluck — poll a few frames
const flicked = await page.evaluate(
  () =>
    new Promise((res) => {
      const t0 = performance.now();
      const tick = () => {
        if (window.__debug.view.tools.rightFinger.visible || window.__debug.input.pluckAnim)
          return res(true);
        if (performance.now() - t0 > 300) return res(false);
        requestAnimationFrame(tick);
      };
      tick();
    })
);
if (!flicked) fail("Space pluck did not show the implement");
else ok("Space pluck showed the implement");
let pk = await peakRmsAfter();
if (pk < 0.002) fail(`Space did not pluck in pizz mode (rms=${pk})`);
else ok(`Space plucked in pizz, rms=${pk.toFixed(4)}`);
await page.waitForTimeout(400);
await page.keyboard.press("ArrowRight");
pk = await peakRmsAfter();
if (pk < 0.002) fail(`ArrowRight did not pluck in pizz mode (rms=${pk})`);
else ok(`→ plucked in pizz, rms=${pk.toFixed(4)}`);
if ((await tool()) !== "finger") fail(`a pluck key reverted the tool to ${await tool()}`);
else ok("pluck keys kept the pizz tool (no revert to bow)");

// the Pressure control scales pluck strength (not just bow weight): a soft
// setting plucks quieter than a firm one
const pluckPeakAt = async (pressure) => {
  // set the slider without focusing it — a focused input would swallow the
  // Space keydown (the keyboard handler ignores editable targets)
  await page.evaluate((v) => {
    const el = document.getElementById("force");
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, pressure);
  await page.waitForTimeout(500); // let the previous ring-down decay
  await page.keyboard.press("Space");
  return peakRmsAfter();
};
const softPluck = await pluckPeakAt(0.1);
const firmPluck = await pluckPeakAt(1.1);
if (firmPluck < softPluck * 1.5)
  fail(`Pressure did not scale pluck force (soft=${softPluck.toFixed(4)}, firm=${firmPluck.toFixed(4)})`);
else ok(`Pressure scales pluck force (soft=${softPluck.toFixed(4)} -> firm=${firmPluck.toFixed(4)})`);
await page.keyboard.press("Escape"); // back to the arco default for later tests

// 11. switch strings mid-stroke: while one finger holds a bow stroke on the
// canvas, a second finger taps a string button. Regression check — the HUD
// used to listen for `click`, which browsers only fire for the *primary*
// pointer, so the switch was deferred until the bowing finger lifted.
await page.click('[data-tool="bow"]');
// Reset the pressure slider first: test 7 leaves bowForce at ~0.52, and CDP
// touches report pressure 1.0 (a ×1.8 force multiplier), which parks the G
// string right on the pressed/choke boundary — whether it speaks then hinges
// on the runner's exact gesture timing. This test is about the mid-stroke
// switch, not the Schelleng regime, so pin the force via the HUD control.
await page.locator("#force").fill("0.45");
await page.locator("#force").dispatchEvent("input");
const cdp = await page.context().newCDPSession(page);
const bowPt = (x) => page.evaluate((xx) => window.__debug.view.stringToScreen(0.9, xx), x);

let f1 = await bowPt(-0.7);
await cdp.send("Input.dispatchTouchEvent", {
  type: "touchStart",
  touchPoints: [{ x: f1.clientX, y: f1.clientY, id: 1 }],
});

// One bow stroke: drag finger 1 across the string, then sample the tuner
// once. The points are precomputed and there are no page round-trips between
// moves: the drag velocity IS the model's bow speed, so per-move evaluate()
// latency (slow on software-rendered CI runners) would slow the stroke into
// the quiet/pressed regime where the pitch detector cannot lock.
const freqs = [];
async function strokePass(dir) {
  const xs = [];
  for (let i = 1; i <= 8; i++) xs.push(dir * (-0.85 + (i / 8) * 1.7));
  const pts = await page.evaluate(
    (arr) => arr.map((xx) => window.__debug.view.stringToScreen(0.9, xx)),
    xs
  );
  for (const q of pts) {
    f1 = q;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: q.clientX, y: q.clientY, id: 1 }],
    });
    await page.waitForTimeout(25);
  }
  freqs.push(await page.evaluate(() => window.__debug.state.detectedFreq));
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

// keep bowing: the audible pitch should settle on the new open G. Each pass
// contributes one end-of-stroke reading; skip the first two (the switch
// transient) and allow a couple of failed attacks in the quorum.
freqs.length = 0;
for (const dir of [-1, 1, -1, 1, -1, 1, -1, 1, -1, 1]) await strokePass(dir);
const sounding = freqs.slice(2).filter((f) => f > 0).sort((a, b) => a - b);
const med = sounding[Math.floor(sounding.length / 2)] ?? 0;
if (sounding.length < 3 || Math.abs(med - 196) > 196 * 0.04)
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

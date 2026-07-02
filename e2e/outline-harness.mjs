/**
 * Standalone violin-outline iteration harness: renders OUTLINE_HALF (same
 * cubic-segment structure as src/scene/scene.ts — keep the two in sync) as
 * a filled SVG silhouette with Stradivari station guides, and screenshots
 * it to PNG. Iterating the shape here gives much faster feedback than
 * rebuilding the app: edit the segments, re-run, look at the PNG.
 *
 *   node e2e/outline-harness.mjs [out.png]
 *
 * Guides (body length L, from the top edge):
 *   upper bout widest  0.155 L   half-width 0.236 L
 *   upper corners      0.365 L
 *   waist (narrowest)  0.47  L   half-width 0.157 L
 *   bridge line        0.55  L
 *   lower corners      0.576 L
 *   lower bout widest  0.77  L   half-width 0.292 L
 */
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// right half, cubic segments [c1x,c1y,c2x,c2y,x,y], L = 3.9
// (mirror of OUTLINE_HALF in src/scene/scene.ts)
const OUTLINE_HALF = [
  [0.48, 0.005, 0.94, -0.15, 0.92, -0.55], // shoulder out to the upper bout's widest
  [0.93, -0.92, 0.85, -1.14, 0.71, -1.26], // straight-ish full flank down to the notch
  [0.74, -1.34, 0.77, -1.41, 0.78, -1.46], // corner run flaring out to the tip
  [0.545, -1.52, 0.575, -2.14, 0.78, -2.22], // C-bout, near-horizontal at the tips
  [0.775, -2.3, 0.75, -2.35, 0.7, -2.4], // lower corner run back in
  [0.88, -2.54, 1.12, -2.7, 1.15, -3.0], // lower bout, widest at 0.77 L
  [1.14, -3.5, 0.8, -3.9, 0, -3.9], // broad bottom arc
];

const L = 3.9;
const S = 130; // px per unit
const CX = 350;
const CY = 40;

const px = (x) => CX + x * S;
const py = (y) => CY - y * S;

function pathD() {
  let d = `M ${px(0)} ${py(0)}`;
  for (const [c1x, c1y, c2x, c2y, x, y] of OUTLINE_HALF)
    d += ` C ${px(c1x)} ${py(c1y)}, ${px(c2x)} ${py(c2y)}, ${px(x)} ${py(y)}`;
  for (let i = OUTLINE_HALF.length - 1; i >= 0; i--) {
    const [c1x, c1y, c2x, c2y] = OUTLINE_HALF[i];
    const [ex, ey] = i === 0 ? [0, 0] : [OUTLINE_HALF[i - 1][4], OUTLINE_HALF[i - 1][5]];
    d += ` C ${px(-c2x)} ${py(c2y)}, ${px(-c1x)} ${py(c1y)}, ${px(-ex)} ${py(ey)}`;
  }
  return d + " Z";
}

// guides: [label, yFrac of L, targetHalfWidth (fraction of L) or null]
const GUIDES = [
  ["UB widest", 0.155, 0.236],
  ["U corners", 0.365, null],
  ["waist", 0.47, 0.157],
  ["bridge", 0.55, null],
  ["L corners", 0.576, null],
  ["LB widest", 0.77, 0.292],
];

let g = "";
for (const [label, fy, hw] of GUIDES) {
  const y = py(-fy * L);
  g += `<line x1="60" x2="640" y1="${y}" y2="${y}" stroke="#4a90d9" stroke-width="1" stroke-dasharray="5 4"/>`;
  g += `<text x="62" y="${y - 4}" font-size="13" fill="#4a90d9">${label}</text>`;
  if (hw) {
    for (const s of [-1, 1]) {
      const x = px(s * hw * L);
      g += `<line x1="${x}" x2="${x}" y1="${y - 14}" y2="${y + 14}" stroke="#d94a4a" stroke-width="2"/>`;
    }
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="600" style="background:#f4f1ea">
  <path d="${pathD()}" fill="#8e4d26" stroke="#1f1209" stroke-width="2.5"/>
  <line x1="${px(0)}" x2="${px(0)}" y1="${py(0.1)}" y2="${py(-L - 0.1)}" stroke="#00000030" stroke-width="1"/>
  ${g}
</svg>`;

const out = process.argv[2] ?? "outline.png";
const svgPath = path.join(os.tmpdir(), "outline-view.svg");
fs.writeFileSync(svgPath, svg);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 700, height: 600 }, deviceScaleFactor: 2 });
await p.goto(`file://${svgPath}`);
await p.screenshot({ path: out });
await b.close();
console.log("wrote", out);

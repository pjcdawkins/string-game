/**
 * Standalone violin-outline iteration harness: renders OUTLINE_HALF (same
 * cubic-segment structure as src/scene/scene.ts — keep the two in sync) as
 * a filled SVG silhouette with Stradivari station guides, and screenshots
 * it to PNG. Iterating the shape here gives much faster feedback than
 * rebuilding the app: edit the segments, re-run, look at the PNG.
 *
 *   node e2e/outline-harness.mjs [out.png]
 *
 * The red dots are a per-row edge scan of the reference violin photograph
 * (a canvas luminance scan of its width profile), in design units; the
 * curve is fitted to them. Station guides mark that photo's landmarks.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// right half, cubic segments [c1x,c1y,c2x,c2y,x,y], L = 3.9
// (mirror of OUTLINE_HALF in src/scene/scene.ts)
const OUTLINE_HALF = [
  [0.2, -0.01, 0.4, -0.02, 0.56, -0.04], // top edge, gently bowed
  [0.74, -0.1, 0.92, -0.36, 0.94, -0.64], // shoulder rounding into the widest
  [0.93, -0.92, 0.9, -1.1, 0.87, -1.285], // flank, full, ending at the corner tip
  [0.75, -1.315, 0.71, -1.345, 0.665, -1.37], // concave curl under the corner
  [0.607, -1.55, 0.607, -1.8, 0.66, -1.95], // C-bout upper half through the waist
  [0.7, -2.08, 0.8, -2.25, 1.02, -2.27], // C-bout lower half flaring to the tip
  [0.99, -2.32, 0.975, -2.38, 1.005, -2.43], // concave curl under the lower corner
  [1.06, -2.6, 1.187, -2.82, 1.187, -3.06], // lower bout out to the widest
  [1.185, -3.35, 1.06, -3.58, 0.95, -3.7], // lower bout, broad
  [0.85, -3.84, 0.55, -3.9, 0, -3.9], // bottom
];

// Width profile measured from the reference photo: [y, halfWidth] in design
// units, drawn as red dots on both sides for direct curve fitting.
const MEASURED = [
  [-0.078, 0.713], [-0.195, 0.811], [-0.312, 0.877], [-0.429, 0.916],
  [-0.546, 0.937], [-0.663, 0.943], [-0.78, 0.927], [-0.897, 0.899],
  [-1.014, 0.86], [-1.131, 0.843], [-1.285, 0.87], [-1.331, 0.69],
  [-1.365, 0.665], [-1.482, 0.627], [-1.599, 0.621], [-1.716, 0.623],
  [-1.833, 0.635], [-1.95, 0.66], [-2.067, 0.698], [-2.184, 0.788],
  [-2.274, 1.02], [-2.301, 1.036], [-2.418, 1.008], [-2.535, 1.038],
  [-2.652, 1.094], [-2.769, 1.136], [-2.886, 1.166], [-3.003, 1.183],
  [-3.12, 1.187], [-3.237, 1.181], [-3.354, 1.153], [-3.471, 1.111],
  [-3.588, 1.046], [-3.705, 0.944], [-3.822, 0.79],
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
  ["UB widest", 0.16, 0.241],
  ["U corners", 0.33, null],
  ["waist", 0.41, 0.159],
  ["bridge", 0.54, null],
  ["L corners", 0.58, null],
  ["LB widest", 0.79, 0.304],
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

let dots = "";
for (const [y, hw] of MEASURED) {
  for (const s of [-1, 1]) {
    dots += `<circle cx="${px(s * hw)}" cy="${py(y)}" r="3.5" fill="#e02020"/>`;
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="600" style="background:#f4f1ea">
  <path d="${pathD()}" fill="#8e4d26" stroke="#1f1209" stroke-width="2.5"/>
  <line x1="${px(0)}" x2="${px(0)}" y1="${py(0.1)}" y2="${py(-L - 0.1)}" stroke="#00000030" stroke-width="1"/>
  ${g}
  ${dots}
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

/**
 * Minimal SVG path (`d` attribute) parser and sampler. Supports M/m L/l H/h
 * V/v C/c S/s Q/q T/t A/a Z/z (absolute and relative). Returns an array of
 * subpaths, each a flat list of [x,y] points sampled along the path (curves
 * flattened at `perCurve` samples). Good enough to turn a hand-drawn f-hole
 * SVG into a polygon for THREE.Shape / SVG fills. Arc support is approximate.
 */
export function parsePathSubpaths(d, perCurve = 24) {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  let i = 0;
  const nextNum = () => parseFloat(toks[i++]);
  const isCmd = (t) => /[a-zA-Z]/.test(t);

  const subpaths = [];
  let cur = null; // current subpath points
  let x = 0, y = 0, startX = 0, startY = 0;
  let px = 0, py = 0; // previous control point (for S/T)
  let prevCmd = "";

  const bez3 = (p0, c1, c2, p3) => {
    for (let k = 1; k <= perCurve; k++) {
      const t = k / perCurve, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
      cur.push([a * p0[0] + b * c1[0] + c * c2[0] + e * p3[0],
                a * p0[1] + b * c1[1] + c * c2[1] + e * p3[1]]);
    }
  };
  const bez2 = (p0, c, p2) => {
    for (let k = 1; k <= perCurve; k++) {
      const t = k / perCurve, u = 1 - t;
      cur.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p2[0],
                u * u * p0[1] + 2 * u * t * c[1] + t * t * p2[1]]);
    }
  };

  let cmd = "";
  while (i < toks.length) {
    if (isCmd(toks[i])) { cmd = toks[i++]; }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M": {
        x = ox + nextNum(); y = oy + nextNum();
        if (cur) subpaths.push(cur);
        cur = [[x, y]]; startX = x; startY = y;
        cmd = rel ? "l" : "L"; // subsequent pairs are implicit lineto
        break;
      }
      case "L": { x = ox + nextNum(); y = oy + nextNum(); cur.push([x, y]); break; }
      case "H": { x = ox + nextNum(); cur.push([x, y]); break; }
      case "V": { y = oy + nextNum(); cur.push([x, y]); break; }
      case "C": {
        const c1 = [ox + nextNum(), oy + nextNum()];
        const c2 = [ox + nextNum(), oy + nextNum()];
        const p3 = [ox + nextNum(), oy + nextNum()];
        bez3([x, y], c1, c2, p3); px = c2[0]; py = c2[1]; x = p3[0]; y = p3[1];
        break;
      }
      case "S": {
        const c1 = /[CS]/.test(prevCmd.toUpperCase()) ? [2 * x - px, 2 * y - py] : [x, y];
        const c2 = [ox + nextNum(), oy + nextNum()];
        const p3 = [ox + nextNum(), oy + nextNum()];
        bez3([x, y], c1, c2, p3); px = c2[0]; py = c2[1]; x = p3[0]; y = p3[1];
        break;
      }
      case "Q": {
        const c = [ox + nextNum(), oy + nextNum()];
        const p2 = [ox + nextNum(), oy + nextNum()];
        bez2([x, y], c, p2); px = c[0]; py = c[1]; x = p2[0]; y = p2[1];
        break;
      }
      case "T": {
        const c = /[QT]/.test(prevCmd.toUpperCase()) ? [2 * x - px, 2 * y - py] : [x, y];
        const p2 = [ox + nextNum(), oy + nextNum()];
        bez2([x, y], c, p2); px = c[0]; py = c[1]; x = p2[0]; y = p2[1];
        break;
      }
      case "A": {
        // approximate: skip radii/flags, straight line to endpoint
        nextNum(); nextNum(); nextNum(); nextNum(); nextNum();
        x = ox + nextNum(); y = oy + nextNum(); cur.push([x, y]);
        break;
      }
      case "Z": { cur.push([startX, startY]); x = startX; y = startY; break; }
      default: i++; // skip unknown
    }
    prevCmd = cmd;
  }
  if (cur) subpaths.push(cur);
  return subpaths;
}

/** Extract the first `d="..."` from arbitrary SVG text (or return input as-is
 * if it already looks like a bare path string). */
export function extractD(text) {
  const m = text.match(/\bd\s*=\s*"([^"]+)"/) || text.match(/\bd\s*=\s*'([^']+)'/);
  if (m) return m[1];
  // maybe they pasted just the path data
  if (/[MmLlCcQqZz]/.test(text) && /\d/.test(text)) return text.trim();
  throw new Error("no path data found");
}

const perpDist = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  if (L < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]); // degenerate: point distance
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L;
};

/** Douglas–Peucker simplify of an open polyline. */
export function simplify(points, eps) {
  if (points.length < 3) return points.slice();
  const rec = (pts) => {
    let dm = 0, idx = 0;
    for (let k = 1; k < pts.length - 1; k++) {
      const dd = perpDist(pts[k], pts[0], pts[pts.length - 1]);
      if (dd > dm) { dm = dd; idx = k; }
    }
    if (dm > eps) return rec(pts.slice(0, idx + 1)).slice(0, -1).concat(rec(pts.slice(idx)));
    return [pts[0], pts[pts.length - 1]];
  };
  return rec(points);
}

/** DP simplify of a closed loop: split at the vertex farthest from the first,
 * simplify both arcs, so the near-coincident start/end don't degenerate it. */
export function simplifyClosed(points, eps) {
  let pts = points.slice();
  // drop a duplicated closing point
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) pts = pts.slice(0, -1);
  }
  if (pts.length < 4) return pts;
  let far = 1, fd = 0;
  for (let k = 1; k < pts.length; k++) {
    const d = Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]);
    if (d > fd) { fd = d; far = k; }
  }
  const arcA = simplify(pts.slice(0, far + 1), eps);
  const arcB = simplify(pts.slice(far).concat([pts[0]]), eps);
  return arcA.slice(0, -1).concat(arcB.slice(0, -1));
}

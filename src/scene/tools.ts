/** Meshes for the playing implements: bow, plectrum, plucking finger, and the
 * left-hand stopping finger. Drawn in the same flat "vector illustration"
 * style as the instrument (see scene.ts): layered unlit shapes. */
import * as THREE from "three";

function flat(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
}

// Playable hair span in the bow's own (unscaled) coordinates: the tip end sits
// at the head's hair mortise, the frog end just past the ferrule. A bow stroke
// sweeps the string's contact point across exactly this range, so these bound
// how far the contact travels (see main.ts / interactions.ts). They are pulled
// a touch inside the drawn hair ribbon so the contact sits on hair, not on the
// head wood or the ferrule.
export const BOW_HAIR_TIP = -1.5;
export const BOW_HAIR_FROG = 1.22;
export const BOW_HAIR_SPAN = BOW_HAIR_FROG - BOW_HAIR_TIP; // 2.72, the base hair length

const BOW = {
  stick: 0x8a5228, // pernambuco
  hair: 0xefe7d2,
  hairEdge: 0x9d947c, // dark rim so the hair reads on light backgrounds too
  frog: 0x17110d, // ebony
  pearl: 0xccd6df,
  silver: 0xb3bac2,
  grip: 0x3c2b1f, // leather
  tipPlate: 0xe9e0cc, // ivory
};

/**
 * Violin bow, lying along x with the hair ribbon through the group origin
 * (y = 0 is the contact line on the string). Frog to the right (+x), tip to
 * the left. Drawn slim, at the proportions of a real bow, and — like the frog
 * — in profile (side view): a fine tapered stick with a gentle camber that
 * brings it closest to the hair mid-bow, a Tourte swan head whose crest rises
 * above the stick and whose ivory-plated face drops to a little beak at the
 * hair line, a compact ebony frog with a pearl eye and silver ferrule, and a
 * short silver winding and leather thumb grip near the frog. (The whole group
 * is uniformly scaled to size on screen — see SceneView.applyBowScale — so
 * these proportions hold at every size.)
 */
export function makeBow(): THREE.Group {
  const g = new THREE.Group();

  // hair: a pale ribbon with a darker edge behind it, running from the head's
  // hair mortise to the ferrule at the frog. Kept thin so the bow reads fine.
  const hairEdge = new THREE.Mesh(new THREE.PlaneGeometry(2.87, 0.024), flat(BOW.hairEdge));
  hairEdge.position.set(-0.175, 0, 0);
  const hair = new THREE.Mesh(new THREE.PlaneGeometry(2.86, 0.014), flat(BOW.hair));
  hair.position.set(-0.175, 0.001, 0.005);

  // stick: a thin ribbon, ~0.02 thick and tapering toward the tip, with a
  // gentle camber (closest to the hair around the middle). The same outline
  // carries on into the head, drawn in profile like the rest of the bow: a
  // Tourte swan head, clearly taller than the stick, dropping from its crest
  // to a beak at the hair line.
  const s = new THREE.Shape();
  // top edge, frog end -> tip
  s.moveTo(1.58, 0.114);
  s.quadraticCurveTo(1.3, 0.092, 0.7, 0.064);
  s.quadraticCurveTo(0.05, 0.054, -0.6, 0.06);
  s.quadraticCurveTo(-1.08, 0.066, -1.5, 0.086); // out to the head, still slim
  // the head, side on: a compact form no longer than it is tall. The ridge
  // line sweeps up into the crest (the back of the swan's head), rounds over
  // the top, and the face — leaning gently forward — drops to the toe, a
  // little beak jutting ahead at the hair line. Behind the toe the underside
  // runs back to the hair mortise, and the throat (the swan's neck) scoops
  // deeply concave up under the stick.
  s.quadraticCurveTo(-1.567, 0.09, -1.608, 0.105); // ridge rising into the crest
  s.quadraticCurveTo(-1.652, 0.116, -1.669, 0.092); // rounded crest, over the top
  s.quadraticCurveTo(-1.681, 0.057, -1.686, 0.026); // the face, down toward the toe
  s.quadraticCurveTo(-1.689, 0.009, -1.698, 0.002); // the toe (the swan's beak)
  s.quadraticCurveTo(-1.669, -0.007, -1.616, -0.004); // underside, back from the beak
  s.quadraticCurveTo(-1.6, -0.003, -1.585, 0.002); // to the hair mortise
  s.quadraticCurveTo(-1.558, 0.052, -1.5, 0.066); // throat, scooped up under the stick
  // bottom edge, tip -> frog end
  s.quadraticCurveTo(-1.05, 0.054, -0.6, 0.044);
  s.quadraticCurveTo(0.05, 0.04, 0.7, 0.05);
  s.quadraticCurveTo(1.3, 0.076, 1.58, 0.096);
  s.closePath();
  const stick = new THREE.Mesh(new THREE.ShapeGeometry(s, 16), flat(BOW.stick));
  stick.position.z = 0.02;

  // ivory face plate: a thin light sliver hugging the head's face from just
  // under the beak up to the crest, with a hairline dark liner behind it.
  const facePlate = (w: number): THREE.Shape => {
    const p = new THREE.Shape();
    p.moveTo(-1.696, 0.0); // at the beak
    p.quadraticCurveTo(-1.689, 0.02, -1.684, 0.04); // outer edge, up the face
    p.quadraticCurveTo(-1.678, 0.07, -1.664, 0.092); // to just under the crest
    p.lineTo(-1.664 + w, 0.09);
    p.quadraticCurveTo(-1.678 + w, 0.066, -1.683 + w, 0.038); // inner edge
    p.quadraticCurveTo(-1.688 + w, 0.016, -1.693 + w, 0.002);
    p.closePath();
    return p;
  };
  const tipLiner = new THREE.Mesh(new THREE.ShapeGeometry(facePlate(0.032), 8), flat(BOW.frog));
  tipLiner.position.z = 0.021;
  const tipPlate = new THREE.Mesh(new THREE.ShapeGeometry(facePlate(0.022), 8), flat(BOW.tipPlate));
  tipPlate.position.z = 0.022;

  // frog: compact ebony block under the stick, thumb bevel toward the winding
  const f = new THREE.Shape();
  f.moveTo(1.26, 0.072);
  f.lineTo(1.55, 0.076);
  f.lineTo(1.55, 0.004);
  f.quadraticCurveTo(1.47, -0.008, 1.39, -0.005);
  f.quadraticCurveTo(1.3, -0.001, 1.26, 0.022);
  f.closePath();
  const frog = new THREE.Mesh(new THREE.ShapeGeometry(f, 8), flat(BOW.frog));
  frog.position.z = 0.025;

  const ferrule = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.072), flat(BOW.silver));
  ferrule.position.set(1.275, 0.03, 0.03);
  const eye = new THREE.Mesh(new THREE.CircleGeometry(0.016, 16), flat(BOW.pearl));
  eye.position.set(1.4, 0.035, 0.03);

  const button = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.04), flat(BOW.silver));
  button.position.set(1.6, 0.096, 0.015);
  const buttonRing = new THREE.Mesh(new THREE.PlaneGeometry(0.01, 0.04), flat(BOW.frog));
  buttonRing.position.set(1.592, 0.096, 0.02);

  const winding = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.03), flat(BOW.silver));
  winding.position.set(1.0, 0.066, 0.03);
  winding.rotation.z = 0.035;
  const grip = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.036), flat(BOW.grip));
  grip.position.set(1.18, 0.076, 0.03);
  grip.rotation.z = 0.035;

  g.add(hairEdge, hair, stick, tipLiner, tipPlate, frog, ferrule, eye, button, buttonRing, winding, grip);
  return g;
}

export function makePlectrum(): THREE.Group {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.16);
  shape.quadraticCurveTo(0.13, 0.02, 0.09, 0.14);
  shape.quadraticCurveTo(0, 0.2, -0.09, 0.14);
  shape.quadraticCurveTo(-0.13, 0.02, 0, -0.16);
  const base = new THREE.Mesh(new THREE.ShapeGeometry(shape, 12), flat(0xe08a3c));
  // smaller, lighter copy: a simple two-tone highlight
  const hi = new THREE.Mesh(new THREE.ShapeGeometry(shape, 12), flat(0xf2ab63));
  hi.scale.setScalar(0.62);
  hi.position.set(-0.01, 0.025, 0.01);
  g.add(base, hi);
  return g;
}

/** A finger is shown as a simple flat circle in a neutral yellow (used for
 * both hands), with a thin darker rim for contrast against the string. Kept
 * small — about a fingertip at the drawn instrument's scale — so it covers
 * only its own string lane (the lanes sit just 0.062 apart at the nut, see
 * ./lanes.ts) and the touch can read which string it is stopping. */
export function makeFinger(): THREE.Group {
  const g = new THREE.Group();
  const pad = new THREE.Mesh(new THREE.CircleGeometry(0.055, 32), flat(0xe3c284));
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.055, 0.068, 32), flat(0x93794a));
  rim.position.z = 0.001;
  g.add(pad, rim);
  return g;
}

export interface ToolSet {
  bow: THREE.Group;
  pick: THREE.Group;
  rightFinger: THREE.Group;
  leftFinger: THREE.Group;
}

export function makeTools(parent: THREE.Group): ToolSet {
  const bow = makeBow();
  const pick = makePlectrum();
  const rightFinger = makeFinger();
  const leftFinger = makeFinger();
  for (const t of [bow, pick, rightFinger, leftFinger]) {
    t.visible = false;
    parent.add(t);
  }
  return { bow, pick, rightFinger, leftFinger };
}

/** Fade helper: tools render semi-transparent when hovering, solid when engaged. */
export function setToolOpacity(tool: THREE.Group, opacity: number): void {
  tool.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      const m = mesh.material as THREE.MeshBasicMaterial;
      m.transparent = opacity < 1;
      m.opacity = opacity;
    }
  });
}

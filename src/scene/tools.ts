/** Meshes for the playing implements: bow, plectrum, plucking finger, and the
 * left-hand stopping finger. Drawn in the same flat "vector illustration"
 * style as the instrument (see scene.ts): layered unlit shapes. */
import * as THREE from "three";

function flat(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
}

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
 * the left. Cambered tapered stick, swan-head tip with an ivory face plate,
 * ebony frog with pearl eye, silver winding and a leather thumb grip.
 */
export function makeBow(): THREE.Group {
  const g = new THREE.Group();

  // hair: a pale ribbon with a darker edge behind it, ending at the mortise
  // in the head's underside (the plate band carries on to the toe from there)
  const hairEdge = new THREE.Mesh(new THREE.PlaneGeometry(2.875, 0.044), flat(BOW.hairEdge));
  hairEdge.position.set(-0.1675, 0, 0);
  const hair = new THREE.Mesh(new THREE.PlaneGeometry(2.86, 0.028), flat(BOW.hair));
  hair.position.set(-0.17, 0, 0.005);

  // stick: the camber brings it closest to the hair mid-bow, then it rises
  // clear of the hair toward the tip — the open daylight between stick and
  // hair through the throat is what makes the head read as a head. The head
  // matches the reference photos: its top is simply the stick's own top
  // line, dead straight to a rounded front corner (no crown bump); below
  // that the head is a wide solid shape, nearly four stick-widths tall,
  // whose near-vertical face flares forward at the bottom into an upturned
  // toe (the swan's bill), while the throat sweeps concave from the mortise
  // up the back of the head and under the stick.
  const s = new THREE.Shape();
  s.moveTo(1.62, 0.07); // frog-end underside
  s.quadraticCurveTo(0.5, 0.018, -0.5, 0.044); // camber, closest to the hair
  s.quadraticCurveTo(-1.0, 0.058, -1.44, 0.121); // rising away toward the head
  s.quadraticCurveTo(-1.53, 0.118, -1.565, 0.09); // throat sweeping under the stick
  s.quadraticCurveTo(-1.59, 0.055, -1.585, 0.008); // near-vertical back of the head
  s.quadraticCurveTo(-1.67, 0.0, -1.722, 0.01); // head underside out to the toe
  s.quadraticCurveTo(-1.7, 0.028, -1.7, 0.07); // toe flare, gently concave
  s.quadraticCurveTo(-1.704, 0.12, -1.696, 0.165); // face, nearly vertical
  s.quadraticCurveTo(-1.69, 0.198, -1.656, 0.199); // rounded front corner
  s.quadraticCurveTo(-1.1, 0.128, -0.5, 0.09); // head top = the stick's top line
  s.quadraticCurveTo(0.4, 0.068, 1.62, 0.13); // rising to the frog
  s.closePath();
  const stick = new THREE.Mesh(new THREE.ShapeGeometry(s, 16), flat(BOW.stick));
  stick.position.z = 0.02;

  // ivory face plate with its black liner: two slightly larger silhouettes
  // of the head's front, layered *under* the stick so only rims show along
  // the face and around the toe where the plate wraps under the hair
  // mortise — ivory outermost, then the thin dark liner against the wood
  const plateRim = (grow: number): THREE.Shape => {
    const p = new THREE.Shape();
    p.moveTo(-1.61, 0.03); // tucked inside the head at the mortise
    // under the head, `grow` below the wood, out around the toe
    p.quadraticCurveTo(-1.67, -grow * 2, -1.727 - grow * 0.8, 0.004 - grow * 2);
    // up the concave flare, tapering to a point partway up the face
    p.quadraticCurveTo(-1.704 - grow, 0.028, -1.702 - grow * 0.3, 0.07 + grow * 1.5);
    p.quadraticCurveTo(-1.692, 0.05, -1.65, 0.012); // back inside the wood
    p.closePath();
    return p;
  };
  const tipPlate = new THREE.Mesh(new THREE.ShapeGeometry(plateRim(0.012), 10), flat(BOW.tipPlate));
  tipPlate.position.z = 0.01;
  const tipLiner = new THREE.Mesh(new THREE.ShapeGeometry(plateRim(0.004), 10), flat(BOW.frog));
  tipLiner.position.z = 0.015;

  // frog: ebony block under the stick, thumb bevel toward the winding
  const f = new THREE.Shape();
  f.moveTo(1.26, 0.08);
  f.lineTo(1.6, 0.085);
  f.lineTo(1.6, -0.005);
  f.quadraticCurveTo(1.52, -0.02, 1.44, -0.015);
  f.quadraticCurveTo(1.3, -0.01, 1.26, 0.02);
  f.closePath();
  const frog = new THREE.Mesh(new THREE.ShapeGeometry(f, 8), flat(BOW.frog));
  frog.position.z = 0.025;

  const ferrule = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.09), flat(BOW.silver));
  ferrule.position.set(1.28, 0.025, 0.03);
  const eye = new THREE.Mesh(new THREE.CircleGeometry(0.024, 16), flat(BOW.pearl));
  eye.position.set(1.44, 0.035, 0.03);

  const button = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.05), flat(BOW.silver));
  button.position.set(1.655, 0.097, 0.015);
  const buttonRing = new THREE.Mesh(new THREE.PlaneGeometry(0.012, 0.05), flat(BOW.frog));
  buttonRing.position.set(1.645, 0.097, 0.02);

  const winding = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.058), flat(BOW.silver));
  winding.position.set(1.02, 0.087, 0.03);
  winding.rotation.z = 0.02;
  const grip = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.06), flat(BOW.grip));
  grip.position.set(1.2, 0.089, 0.03);
  grip.rotation.z = 0.02;

  g.add(hairEdge, hair, stick, tipPlate, tipLiner, frog, ferrule, eye, button, buttonRing, winding, grip);
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
 * both hands), with a thin darker rim for contrast against the string. */
export function makeFinger(): THREE.Group {
  const g = new THREE.Group();
  const pad = new THREE.Mesh(new THREE.CircleGeometry(0.14, 32), flat(0xe3c284));
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.14, 0.165, 32), flat(0x93794a));
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

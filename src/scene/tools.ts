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

  // hair: a pale ribbon with a darker edge behind it, reaching under the
  // head's heel where the tip plate wraps over its end (the mortise)
  const hairEdge = new THREE.Mesh(new THREE.PlaneGeometry(2.95, 0.044), flat(BOW.hairEdge));
  hairEdge.position.set(-0.205, 0, 0);
  const hair = new THREE.Mesh(new THREE.PlaneGeometry(2.93, 0.028), flat(BOW.hair));
  hair.position.set(-0.205, 0, 0.005);

  // stick: the camber brings it closest to the hair mid-bow, then it rises
  // clear of the hair toward the tip — the open daylight between stick and
  // hair through the throat is what makes the head read as a head. The head
  // itself is the classic swan profile of the reference photos: about three
  // stick-widths tall, a big concave throat hugging up under the stick and
  // dropping down the nearly-vertical back to the heel where the hair
  // enters, a gently convex face leaning back as it rises, and a rounded
  // crown easing into the stick's top line.
  const s = new THREE.Shape();
  s.moveTo(1.62, 0.07); // frog-end underside
  s.quadraticCurveTo(0.5, 0.018, -0.5, 0.044); // camber, closest to the hair
  s.quadraticCurveTo(-1.0, 0.058, -1.46, 0.118); // rising away toward the head
  // throat: hugs high under the stick, then drops almost vertically down
  // the back of the head to the heel
  s.quadraticCurveTo(-1.635, 0.115, -1.639, 0.012);
  s.quadraticCurveTo(-1.665, -0.002, -1.696, 0.002); // heel at the hair
  s.quadraticCurveTo(-1.705, 0.05, -1.668, 0.17); // face, leaning back as it rises
  s.quadraticCurveTo(-1.657, 0.2, -1.614, 0.202); // crown
  s.quadraticCurveTo(-1.578, 0.198, -1.55, 0.185); // easing over the back
  s.quadraticCurveTo(-1.5, 0.168, -1.46, 0.166); // fillet into the stick top
  s.quadraticCurveTo(-1.05, 0.115, -0.5, 0.09); // stick top
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
    p.moveTo(-1.635, 0.014); // flush with the back of the heel
    // under the heel: track the wood's own heel curve, `grow` below it, so
    // the rim stays an even band and never blots out the hair at the throat
    p.quadraticCurveTo(-1.665, -0.002 - grow, -1.7 - grow * 0.3, -0.004 - grow);
    p.quadraticCurveTo(-1.708 - grow, 0.05, -1.674 - grow, 0.165); // face rim
    p.quadraticCurveTo(-1.663 - grow, 0.178, -1.645, 0.179); // under the crown
    p.closePath(); // back edge stays inside the wood, clear of the open throat
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

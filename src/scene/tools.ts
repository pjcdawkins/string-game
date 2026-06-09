/** Meshes for the playing implements: bow, plectrum, plucking finger, and the
 * left-hand stopping finger. */
import * as THREE from "three";

function skinMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xd9a577, roughness: 0.7 });
}

export function makeBow(): THREE.Group {
  const g = new THREE.Group();
  const stick = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.035, 3.4, 12),
    new THREE.MeshStandardMaterial({ color: 0x5b3a21, roughness: 0.45 })
  );
  stick.rotation.z = Math.PI / 2;
  stick.position.z = 0.09;
  const hair = new THREE.Mesh(
    new THREE.BoxGeometry(3.25, 0.045, 0.012),
    new THREE.MeshStandardMaterial({ color: 0xf2ecd8, roughness: 0.9 })
  );
  hair.position.z = 0.0;
  const frog = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.12, 0.1),
    new THREE.MeshStandardMaterial({ color: 0x14100c, roughness: 0.3 })
  );
  frog.position.set(1.45, 0.02, 0.05);
  const tip = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.09, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xe8dcc8, roughness: 0.5 })
  );
  tip.position.set(-1.66, 0.03, 0.04);
  g.add(stick, hair, frog, tip);
  return g;
}

export function makePlectrum(): THREE.Group {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.16);
  shape.quadraticCurveTo(0.13, 0.02, 0.09, 0.14);
  shape.quadraticCurveTo(0, 0.2, -0.09, 0.14);
  shape.quadraticCurveTo(-0.13, 0.02, 0, -0.16);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false });
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0xd97f30, roughness: 0.35 })
  );
  g.add(mesh);
  return g;
}

export function makeFinger(): THREE.Group {
  const g = new THREE.Group();
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.1, 18, 14), skinMaterial());
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.4, 6, 14), skinMaterial());
  body.rotation.x = -0.9;
  body.position.set(0, 0.22, 0.16);
  g.add(tip, body);
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
  leftFinger.rotation.z = Math.PI; // approaches from the other side
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
      const m = mesh.material as THREE.MeshStandardMaterial;
      m.transparent = opacity < 1;
      m.opacity = opacity;
    }
  });
}

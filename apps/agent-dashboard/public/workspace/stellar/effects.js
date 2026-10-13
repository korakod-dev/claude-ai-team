/**
 * stellar/effects.js - Meshes of the activity effects (browser module, imports THREE): beams and finish bursts.
 * The rules (colours, caps, states) are in stellar/activity.js; this file only DRAWS them. scene.js owns the instance.
 *
 *   beam(anchor, radius, length, color, seq)   a short bolt shoots out from a planet / moon / the sun on a tool call
 *   burst(anchor, radius, maxRadius, color)    a small ring of particles flies out from a planet / moon when it finishes
 *
 * Budget: everything is built ONCE in createEffects() and pooled.
 *   - MAX_BEAMS beam meshes (one shared plane geometry, one shared gradient texture, one material per slot for colour and fade)
 *   - MAX_BURSTS Points objects (BURST_PARTICLES points each, one material per slot). The points sit on a fixed unit sphere and the
 *     whole object is scaled outward, so a frame writes no buffer at all.
 *   - Nothing is allocated per frame (module scratch vectors only) and nothing per effect. When a pool is full the oldest effect is
 *     reused (activity.js pickSlot), so the number of live effects can never exceed the pool size.
 * An effect follows its anchor (the planet group, or the moon mesh). When the anchor is gone (a moon finished) the effect
 * finishes at the last known position.
 * Reduced motion (prefers-reduced-motion): beam() and burst() draw nothing.
 * dispose() frees every geometry, material and texture (page teardown).
 *
 * Effects live in world space and never touch layout: orbit radii, body extents and the camera fit do not know about them.
 */
import * as THREE from '../vendor/three/three.module.min.js';
import { MAX_BEAMS, MAX_BURSTS, pickSlot } from './activity.js';

export const BEAM_SECONDS = 0.5;       // life of a beam (simulated seconds)
export const BURST_SECONDS = 0.9;      // life of a burst
export const BURST_PARTICLES = 20;     // points per burst
const BEAM_WIDTH = 0.07;               // world units
const BEAM_TAIL = 0.55;                // visible length of the bolt as a share of its full reach
const BEAM_GAIN = 1.7;                 // colour gain: above 1 so the hot core blooms (UnrealBloomPass threshold)
const BURST_SIZE = 0.2;                // point size (world units, size-attenuated)
const BURST_GAIN = 1.5;
const GOLDEN_ANGLE = 2.39996323;       // successive beams of one actor fan out by this angle

// Scratch objects (shared, never allocated per frame)
const sPos = new THREE.Vector3();
const sRight = new THREE.Vector3();
const sUp = new THREE.Vector3();
const sToViewer = new THREE.Vector3();   // camera +Z in world space: from the scene toward the viewer
const sX = new THREE.Vector3();
const sY = new THREE.Vector3();
const sZ = new THREE.Vector3();
const sScale = new THREE.Vector3();
const sCenter = new THREE.Vector3();
const sMat = new THREE.Matrix4();

/** Beam texture: transparent at the tail, bright at the head, soft across the width. White (the material colour tints it). */
function beamTexture() {
  const w = 64;
  const h = 16;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h - 0.5;
    const across = Math.exp(-((v / 0.22) ** 2));
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const along = u ** 1.6;                       // fades toward the tail
      const a = Math.round(255 * Math.min(1, along * across));
      const i = (y * w + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft round dot for the burst particles. */
function dotTexture() {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Unit-sphere directions (Fibonacci spiral): even, deterministic, no random numbers. */
function fibonacciSphere(count) {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * GOLDEN_ANGLE;
    out[i * 3] = Math.cos(phi) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(phi) * r;
  }
  return out;
}

/** Position of an anchor in world space into `out`. A detached anchor (finished moon) keeps `slot.last`. */
function anchorPosition(slot, out) {
  if (slot.anchor && slot.anchor.parent) {
    slot.anchor.getWorldPosition(out);
    slot.last.copy(out);
  } else {
    out.copy(slot.last);
  }
  return out;
}

/**
 * Build both pools.
 * @param {object} opts
 * @param {THREE.Object3D} opts.parent       where the effect objects live (the world scene)
 * @param {(geo: THREE.BufferGeometry, count: number) => void} [opts.register]  quality hook: scales the drawn particle count
 * @param {boolean} [opts.reducedMotion]     true = beam() and burst() draw nothing. Can change later: setReducedMotion()
 */
export function createEffects({ parent, register, reducedMotion = false }) {
  let time = 0;                                           // simulated seconds of the last update()
  const beamGeo = new THREE.PlaneGeometry(1, 1);
  beamGeo.translate(0.5, 0, 0);                           // x runs 0..1: the plane starts at its origin, so scaling X stretches it forward
  const beamTex = beamTexture();
  const dotTex = dotTexture();
  const burstDirs = fibonacciSphere(BURST_PARTICLES);
  const burstGeo = new THREE.BufferGeometry();
  burstGeo.setAttribute('position', new THREE.BufferAttribute(burstDirs, 3));
  if (register) register(burstGeo, BURST_PARTICLES);

  const beams = [];
  for (let i = 0; i < MAX_BEAMS; i++) {
    const material = new THREE.MeshBasicMaterial({
      map: beamTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
    });
    const mesh = new THREE.Mesh(beamGeo, material);
    mesh.matrixAutoUpdate = false;          // the matrix is written directly in update()
    mesh.frustumCulled = false;
    mesh.visible = false;
    parent.add(mesh);
    beams.push({
      active: false, start: 0, mesh, material, anchor: null, last: new THREE.Vector3(), radius: 0, length: 0, angle: 0, width: BEAM_WIDTH,
    });
  }

  const bursts = [];
  for (let i = 0; i < MAX_BURSTS; i++) {
    const material = new THREE.PointsMaterial({
      map: dotTex, size: BURST_SIZE, sizeAttenuation: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0,
    });
    const points = new THREE.Points(burstGeo, material);
    points.frustumCulled = false;
    points.visible = false;
    parent.add(points);
    bursts.push({ active: false, start: 0, points, material, anchor: null, last: new THREE.Vector3(), radius: 0, maxRadius: 0 });
  }

  /** Start a beam from an anchor: it shoots outward from `radius` to `radius + length` in a direction fanned out by `seq`. */
  function beam(anchor, radius, length, color, seq = 0) {
    if (reducedMotion || !anchor) return false;
    const i = pickSlot(beams);
    if (i < 0) return false;                               // disposed
    const slot = beams[i];
    slot.active = true;
    slot.start = time;
    slot.anchor = anchor;
    slot.radius = radius;
    slot.length = length;
    slot.angle = seq * GOLDEN_ANGLE;
    slot.width = BEAM_WIDTH * (length > 0.6 ? 1 : 0.8);
    slot.material.color.setHex(color).multiplyScalar(BEAM_GAIN);
    anchor.getWorldPosition(slot.last);
    return true;
  }

  /** Start a burst on an anchor: BURST_PARTICLES points fly out from `radius` to `maxRadius`. */
  function burst(anchor, radius, maxRadius, color) {
    if (reducedMotion || !anchor) return false;
    const i = pickSlot(bursts);
    if (i < 0) return false;                               // disposed
    const slot = bursts[i];
    slot.active = true;
    slot.start = time;
    slot.anchor = anchor;
    slot.radius = radius;
    slot.maxRadius = maxRadius;
    slot.material.color.setHex(color).multiplyScalar(BURST_GAIN);
    slot.points.rotation.set(i * 0.9 + time, i * 1.7, 0);   // a different orientation per slot, so repeated bursts do not look alike
    anchor.getWorldPosition(slot.last);
    return true;
  }

  /** Per-frame update of every active effect. `camera` orients the beam strips toward the viewer. */
  function update(simTime, camera) {
    time = simTime;
    // Camera basis (world): beams fan out in the screen plane, so every beam is visible from any view
    camera.matrixWorld.extractBasis(sRight, sUp, sToViewer);
    for (let i = 0; i < beams.length; i++) {
      const b = beams[i];
      if (!b.active) continue;
      const t = (time - b.start) / BEAM_SECONDS;
      if (t >= 1) {
        b.active = false;
        b.mesh.visible = false;
        continue;
      }
      anchorPosition(b, sPos);
      const ease = 1 - (1 - t) * (1 - t);                 // ease out: shoots out fast, then slows
      const head = b.radius + b.length * ease;
      const tail = Math.max(b.radius, head - b.length * BEAM_TAIL);
      const len = Math.max(0.001, head - tail);
      sX.copy(sRight).multiplyScalar(Math.cos(b.angle)).addScaledVector(sUp, Math.sin(b.angle));   // beam direction (unit, in the screen plane)
      sZ.copy(sToViewer);                                     // the strip faces the viewer
      sY.crossVectors(sZ, sX);                             // width direction
      sCenter.copy(sPos).addScaledVector(sX, tail);        // the strip starts at the tail (geometry x runs 0..1)
      sScale.set(len, b.width, 1);
      sMat.makeBasis(sX, sY, sZ).scale(sScale).setPosition(sCenter);
      b.mesh.matrix.copy(sMat);
      b.mesh.matrixWorldNeedsUpdate = true;
      b.material.opacity = (1 - t) ** 1.2;
      b.mesh.visible = true;
    }
    for (let i = 0; i < bursts.length; i++) {
      const b = bursts[i];
      if (!b.active) continue;
      const t = (time - b.start) / BURST_SECONDS;
      if (t >= 1) {
        b.active = false;
        b.points.visible = false;
        continue;
      }
      anchorPosition(b, sPos);
      const ease = 1 - (1 - t) ** 3;
      b.points.position.copy(sPos);
      b.points.scale.setScalar(b.radius + (b.maxRadius - b.radius) * ease);
      b.material.opacity = (1 - t) ** 1.5;
      b.points.visible = true;
    }
  }

  /**
   * Switch reduced motion on or off while the page is running (the OS setting changed).
   * On: every running beam and burst stops at once and new ones are refused. Off: new ones are drawn again.
   * (`reducedMotion` is the option of createEffects(); beam() and burst() read it on every call.)
   */
  function setReducedMotion(value) {
    reducedMotion = !!value;
    if (reducedMotion) clear();
  }

  /** Stop every effect at once (reset). */
  function clear() {
    beams.forEach((b) => { b.active = false; b.mesh.visible = false; b.anchor = null; });
    bursts.forEach((b) => { b.active = false; b.points.visible = false; b.anchor = null; });
  }

  /** Number of effects alive right now (tests and debugging). */
  function stats() {
    return { beams: beams.filter((b) => b.active).length, bursts: bursts.filter((b) => b.active).length };
  }

  /** Free everything: objects leave the scene, geometries, materials and textures are disposed. */
  function dispose() {
    clear();
    beams.forEach((b) => { parent.remove(b.mesh); b.material.dispose(); });
    bursts.forEach((b) => { parent.remove(b.points); b.material.dispose(); });
    beams.length = 0;
    bursts.length = 0;
    beamGeo.dispose();
    burstGeo.dispose();
    beamTex.dispose();
    dotTex.dispose();
  }

  return { beam, burst, update, clear, stats, setReducedMotion, dispose };
}

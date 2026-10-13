/**
 * stellar/backdrop.js - Deep-space backdrop of the Stellar Universe view (Phase 2). Browser module (imports THREE).
 *
 * Builds, once:
 *   - sky dome: a large inside-out sphere with a drifting nebula and a faint galactic band (SKY_FRAG).
 *     The dome lives in its own THREE.Scene (returned as skyScene), not in group: scene.js draws it in SkyPass
 *     (stellar/sky-pass.js) at half resolution, so the main scene pass must not draw it again.
 *   - three star layers (far, mid, near). Each layer turns by a different factor as the camera yaws, so near stars
 *     shift more than far stars (parallax). Every star twinkles in the shader (STAR_VERT / STAR_FRAG).
 *   - space dust: DUST_COUNT motes drifting inside a box. The drift and the wrap run on the GPU (DUST_VERT).
 *
 * All data is generated from a fixed seed, so the sky looks the same on every load. Nothing is loaded from a file.
 * Particle geometries are passed to the caller's register() so the quality preset can draw a share of them.
 */
import * as THREE from '../vendor/three/three.module.min.js';
import {
  SKY_VERT, SKY_FRAG, STAR_VERT, STAR_FRAG, DUST_VERT, DUST_FRAG,
} from './shaders.js';

const SKY_RADIUS = 700;          // dome radius (world units); the camera far plane is set above it in scene.js
const DUST_BOX = new THREE.Vector3(70, 36, 70); // motes wrap inside this box around the origin
export const DUST_COUNT = 900;   // space dust motes (quality scales the drawn share)

// Star layers: count, shell radius range, size range (CSS px), brightness range, and the parallax factor
// (how much the layer turns when the camera yaws; near stars turn the most).
export const STAR_LAYERS = Object.freeze([
  { name: 'far',  count: 2600, radius: [620, 740], size: [0.8, 1.8], brightness: [0.10, 0.42], parallax: 0.02, seed: 1234 },
  { name: 'mid',  count: 1000, radius: [400, 500], size: [1.2, 2.6], brightness: [0.22, 0.75], parallax: 0.06, seed: 4321 },
  { name: 'near', count: 240,  radius: [230, 290], size: [2.0, 4.0], brightness: [0.45, 1.00], parallax: 0.14, seed: 777 },
]);

/** Seeded random generator (mulberry32): the same stars and dust on every load. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform random unit vector (direction on a sphere). */
function randomDirection(rnd) {
  const u = rnd() * 2 - 1;
  const t = rnd() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return new THREE.Vector3(s * Math.cos(t), u, s * Math.sin(t));
}

/**
 * Approximate colour of a black body at temperature k (Kelvin), as linear RGB.
 * Tanner Helland's curve fit (1000 K to 40000 K). Visual approximation only, used for star colours.
 */
function kelvinToLinearColor(k) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66
    ? 99.4708025861 * Math.log(t) - 161.1195681661
    : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  let b;
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = new THREE.Color();
  const clamp255 = (v) => Math.min(255, Math.max(0, v)) / 255;
  c.setRGB(clamp255(r), clamp255(g), clamp255(b), THREE.SRGBColorSpace);
  return c;
}

/**
 * Build the backdrop.
 *   options.register(geo, count)  called for every particle geometry (quality scales the drawn count)
 *   options.scaleU                shared uniform { value }: device pixels per world unit (set by scene.js on resize)
 *   options.pixelU                shared uniform { value }: renderer pixel ratio (star point sizes), set by scene.js
 * Returns:
 *   group                  THREE.Group with the star layers and dust (add it to the scene once)
 *   skyScene               THREE.Scene with the sky dome only (drawn by SkyPass at half resolution)
 *   update(time, yaw, dt)  per frame: time = simulated seconds, yaw = camera yaw (radians), dt = simulated step
 */
export function createBackdrop(options = {}) {
  const register = typeof options.register === 'function' ? options.register : () => {};
  const group = new THREE.Group();
  // Shared uniforms from the scene (resize and the pixel ratio update them), or private ones for tests
  const pixel = options.pixelU || { value: 1 };    // renderer pixel ratio: star size
  const scaleU = options.scaleU || { value: 1 };   // device px per world unit: dust size
  const layers = [];              // { points, mat, parallax, speed }
  const timeUniforms = [];        // every uTime uniform of this backdrop (set each frame)

  // Sky dome: inside-out sphere, drawn first and never written to the depth buffer
  const skyUniforms = { uTime: { value: 0 } };
  timeUniforms.push(skyUniforms.uTime);
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 48, 24),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  // Own scene: drawn by SkyPass (scene.js), not by the main scene pass
  const skyScene = new THREE.Scene();
  skyScene.add(sky);

  // Star layers
  STAR_LAYERS.forEach((cfg) => {
    const rnd = mulberry32(cfg.seed);
    const pos = new Float32Array(cfg.count * 3);
    const col = new Float32Array(cfg.count * 3);
    const size = new Float32Array(cfg.count);
    const phase = new Float32Array(cfg.count);
    for (let i = 0; i < cfg.count; i++) {
      const r = cfg.radius[0] + rnd() * (cfg.radius[1] - cfg.radius[0]);
      const d = randomDirection(rnd).multiplyScalar(r);
      pos.set([d.x, d.y, d.z], i * 3);
      // Power law brightness: most stars faint, a few bright
      const m = rnd();
      const brightness = cfg.brightness[0] + (cfg.brightness[1] - cfg.brightness[0]) * Math.pow(m, 3);
      const c = kelvinToLinearColor(3200 + 8800 * Math.pow(rnd(), 0.8));
      col.set([c.r * brightness, c.g * brightness, c.b * brightness], i * 3);
      size[i] = cfg.size[0] + (cfg.size[1] - cfg.size[0]) * Math.pow(m, 5);
      phase[i] = rnd();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
    const uniforms = { uTime: { value: 0 }, uPixel: pixel };
    timeUniforms.push(uniforms.uTime);
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    group.add(points);
    register(geo, cfg.count);
    layers.push({ points, mat, parallax: cfg.parallax, speed: 0.002 + cfg.parallax * 0.05 });
  });

  // Space dust: motes spread through the box, drifting and wrapping on the GPU
  const dustRnd = mulberry32(2025);
  const dustPos = new Float32Array(DUST_COUNT * 3);
  const dustSeed = new Float32Array(DUST_COUNT);
  const dustSize = new Float32Array(DUST_COUNT);
  for (let i = 0; i < DUST_COUNT; i++) {
    dustPos.set([
      (dustRnd() - 0.5) * DUST_BOX.x,
      (dustRnd() - 0.5) * DUST_BOX.y,
      (dustRnd() - 0.5) * DUST_BOX.z,
    ], i * 3);
    dustSeed[i] = dustRnd();
    dustSize[i] = 0.05 + 0.12 * dustRnd();
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.Float32BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('aSeed', new THREE.Float32BufferAttribute(dustSeed, 1));
  dustGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(dustSize, 1));
  const dustUniforms = { uTime: { value: 0 }, uScale: scaleU, uBox: { value: DUST_BOX } };
  timeUniforms.push(dustUniforms.uTime);
  const dustMat = new THREE.ShaderMaterial({
    uniforms: dustUniforms,
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  group.add(dust);
  register(dustGeo, DUST_COUNT);

  return {
    group,
    skyScene,

    /** Per frame: twinkle and dust clock, sky drift, and the parallax turn of each star layer. */
    update(time, yaw, dt) {
      timeUniforms.forEach((u) => { u.value = time; });
      layers.forEach((l) => {
        // Parallax: the layer follows the camera yaw by its own factor, plus a very slow drift of its own
        l.points.rotation.y = -yaw * l.parallax + time * l.speed;
      });
    },
  };
}

/**
 * stellar/bodies.js - Meshes and materials of the Stellar Universe bodies (Phase 2). Browser module (imports THREE).
 * These factories only BUILD the objects. Per-frame animation, status moods and positions are in scene.js.
 *
 *   createSun()          main agent (เลขาคนสวย): plasma surface, chromosphere, corona, halo, lens streak, flare, shock ring
 *   createPlanet()       sub-agent: procedural surface (one type per agent), day/night lighting, atmosphere,
 *                        halo, dark-red error aura and the energy ring
 *   createBlackHole()    dark core, photon ring, lensing ring, rotating accretion disk, violet halo
 *   createCometSlot()    one comet of the pool: glowing head sprite and a tail of point samples
 *
 * Textures are drawn on canvas (glow, streak, comet head). No image file is loaded.
 */
import * as THREE from '../vendor/three/three.module.min.js';
import {
  BODY_VERT, SUN_CORE_FRAG, SUN_PROM_FRAG, CORONA_FRAG, PLANET_FRAG, ATMO_FRAG, RING_FRAG,
  DISK_FRAG, TAIL_VERT, TAIL_FRAG,
} from './shaders.js';

/** Surface types of the planets (uType in PLANET_FRAG). One per registered sub-agent. */
export const SURFACE = Object.freeze({ CIRCUIT: 0, BANDS: 1, CONTINENTS: 2, MARBLE: 3 });

/** Soft radial glow texture in one colour (halos, flares, aura). */
function glowTexture(hex, size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0.0, `rgba(${r},${g},${b},1)`);
  grad.addColorStop(0.2, `rgba(${r},${g},${b},0.55)`);
  grad.addColorStop(0.5, `rgba(${r},${g},${b},0.14)`);
  grad.addColorStop(1.0, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Comet head: white-hot core falling off to a coloured halo (the colour comes from the sprite material). */
function cometHeadTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.1, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Horizontal lens streak (anamorphic flare) drawn as a flattened radial gradient. */
function streakTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(256, 32);
  ctx.scale(1, 0.125);
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 256);
  grad.addColorStop(0, 'rgba(255,220,160,1)');
  grad.addColorStop(0.3, 'rgba(255,200,130,0.35)');
  grad.addColorStop(1, 'rgba(255,200,130,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(-256, -256, 512, 512);
  ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Additive material with the usual settings for glow shells and sprites. */
function additiveShader(uniforms, vertexShader, fragmentShader, extra = {}) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    ...extra,
  });
}

/**
 * The sun (main agent). Radius is the physical surface; the corona shell is radius * coronaScale.
 * Returns the meshes and the uniform sets that scene.js updates each frame.
 */
export function createSun({ radius, coronaScale }) {
  const group = new THREE.Group();

  // Plasma surface: domain-warped noise in three colours (hot, mid, edge)
  const coreU = {
    uHot: { value: new THREE.Color(0xffe7a3) },
    uMid: { value: new THREE.Color(0xffa040) },
    uEdge: { value: new THREE.Color(0xe2561a) },
    uGlow: { value: 0 },
    uError: { value: 0 },
    uTime: { value: 0 },
  };
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 128, 96),
    new THREE.ShaderMaterial({ uniforms: coreU, vertexShader: BODY_VERT, fragmentShader: SUN_CORE_FRAG }),
  );
  group.add(core);

  // Chromosphere with prominences at the limb
  const promU = { uColor: { value: new THREE.Color(0xff7a1a) }, uGlow: { value: 0 }, uTime: { value: 0 } };
  const prom = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.07, 96, 64),
    additiveShader(promU, BODY_VERT, SUN_PROM_FRAG),
  );
  group.add(prom);

  // Corona with streamers
  const coronaU = { uColor: { value: new THREE.Color(0xffc857) }, uGlow: { value: 0 }, uTime: { value: 0 } };
  const corona = new THREE.Mesh(
    new THREE.SphereGeometry(radius * coronaScale, 64, 48),
    additiveShader(coronaU, BODY_VERT, CORONA_FRAG),
  );
  group.add(corona);

  // Wide warm halo sprite behind everything
  const haloMat = new THREE.SpriteMaterial({
    map: glowTexture(0xffa040, 256), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.35,
  });
  const halo = new THREE.Sprite(haloMat);
  halo.scale.set(radius * 9, radius * 9, 1);
  group.add(halo);

  // Horizontal lens streak
  const streakMat = new THREE.SpriteMaterial({
    map: streakTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.25,
  });
  const streak = new THREE.Sprite(streakMat);
  streak.scale.set(radius * 10, radius * 1.0, 1);
  group.add(streak);

  // Flare: a short bright burst when the sun dispatches a task (opacity driven by scene.js)
  const flareMat = new THREE.SpriteMaterial({
    map: glowTexture(0xfff7d6, 256), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
  });
  const flare = new THREE.Sprite(flareMat);
  flare.scale.set(radius * 6, radius * 6, 1);
  group.add(flare);

  // Shock ring: expands from the surface on a dispatch. scene.js turns it to face the camera.
  const shockMat = new THREE.MeshBasicMaterial({
    color: 0xffd38a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, side: THREE.DoubleSide,
  });
  const shock = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 128), shockMat);
  shock.visible = false;
  group.add(shock);

  return {
    group,
    radius,
    core,
    coreU,
    prom,
    promU,
    corona,
    coronaU,
    halo,
    haloMat,
    streak,
    streakMat,
    flare,
    flareMat,
    shock,
    shockMat,
    uniformSets: [coreU, promU, coronaU],   // every ShaderMaterial uniform set of the sun
  };
}

/**
 * One planet (sub-agent).
 *   opts.radius    body radius (world units)
 *   opts.type      SURFACE.* (one surface per agent)
 *   opts.colors    { c0, c1, c2, atmo }: hex colours of the surface and the atmosphere rim
 *   opts.ringScale energy ring radius at rest, in body radii (scene.js widens it with the open task count)
 * Returns the meshes, and the uniform sets that scene.js updates each frame.
 */
export function createPlanet({ radius, type, colors, ringScale }) {
  const group = new THREE.Group();
  const c = (hex) => new THREE.Color(hex);

  const surfaceU = {
    uType: { value: type },
    uC0: { value: c(colors.c0) },
    uC1: { value: c(colors.c1) },
    uC2: { value: c(colors.c2) },
    uAtmo: { value: c(colors.atmo) },
    uGlow: { value: 0 },
    uError: { value: 0 },
    uTime: { value: 0 },
  };
  const surface = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 96, 64),
    new THREE.ShaderMaterial({ uniforms: surfaceU, vertexShader: BODY_VERT, fragmentShader: PLANET_FRAG }),
  );
  group.add(surface);

  // Atmosphere: rim-only additive shell in the planet colour (dark red during an error)
  const atmoU = {
    uColor: { value: c(colors.atmo) },
    uGlow: { value: 0 },
    uError: { value: 0 },
    uTime: { value: 0 },
    uSunPos: { value: new THREE.Vector3(0, 0, 0) },
  };
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.12, 64, 48),
    additiveShader(atmoU, BODY_VERT, ATMO_FRAG),
  );
  group.add(atmo);

  // Soft pale halo (idle glow). scene.js sets its colour and size from the mood.
  const haloMat = new THREE.SpriteMaterial({
    map: glowTexture(0xffffff, 128), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.3,
  });
  const halo = new THREE.Sprite(haloMat);
  group.add(halo);

  // Error aura: dark red, normal blending so it darkens the stars behind the planet
  const auraMat = new THREE.SpriteMaterial({
    map: glowTexture(0x7f1d1d, 128), transparent: true, depthWrite: false, opacity: 0,
  });
  const aura = new THREE.Sprite(auraMat);
  group.add(aura);

  // Energy ring: tilted band around the planet, visible while it is active
  const energyU = { uColor: { value: c(colors.atmo) }, uOpacity: { value: 0 }, uTime: { value: 0 } };
  const energy = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.025, 8, 180),
    additiveShader(energyU, BODY_VERT, RING_FRAG),
  );
  energy.rotation.x = 1.25;
  energy.scale.setScalar(radius * ringScale);
  group.add(energy);

  return {
    group,
    radius,
    surface,
    surfaceU,
    atmo,
    atmoU,
    halo,
    haloMat,
    aura,
    auraMat,
    energy,
    energyU,
    ringScale,
    uniformSets: [surfaceU, atmoU, energyU],
  };
}

/**
 * Beacon (User Prompt): a small pale body with a thin spinning ring. Uses the planet builder, with no energy ring.
 */
export function createBeacon({ radius }) {
  const planet = createPlanet({
    radius,
    type: SURFACE.CIRCUIT,
    colors: { c0: 0xe0f2fe, c1: 0xbae6fd, c2: 0xffffff, atmo: 0xe0f2fe },
    ringScale: 1.6,
  });
  // Thin ring around the beacon
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 2.1, 0.012, 8, 96),
    new THREE.MeshBasicMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  ring.rotation.x = Math.PI / 2;
  planet.group.add(ring);
  planet.ring = ring;
  planet.energy.visible = false;
  return planet;
}

/**
 * Black hole (failed tasks are pulled in). Local origin = the centre of the hole.
 *   opts.horizon  radius of the black core (world units)
 *   opts.innerR, opts.outerR  accretion disk radii (world units)
 */
export function createBlackHole({ horizon, innerR, outerR }) {
  const group = new THREE.Group();

  // Dark core: hides the stars behind it
  const horizonMesh = new THREE.Mesh(
    new THREE.SphereGeometry(horizon, 64, 48),
    new THREE.MeshBasicMaterial({ color: 0x000000 }),
  );
  group.add(horizonMesh);

  // Photon ring: bright thin ring just outside the core (over-bright colour, so the bloom picks it up)
  const photonMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.0, 0.82, 0.45).multiplyScalar(2.2),
    transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const photon = new THREE.Mesh(new THREE.TorusGeometry(horizon * 1.08, horizon * 0.035, 12, 180), photonMat);
  group.add(photon);

  // Lensing ring: faint outer ring, a hint of light bent around the hole
  const lensMat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const lens = new THREE.Mesh(new THREE.TorusGeometry(horizon * 1.35, horizon * 0.02, 8, 180), lensMat);
  group.add(lens);

  // Accretion disk: tilted into a horizontal plane. The shader animates the swirl.
  const diskU = {
    uTime: { value: 0 },
    uInner: { value: innerR },
    uOuter: { value: outerR },
    uPull: { value: 0 },
    uFlash: { value: 0 },
  };
  const tilt = new THREE.Group();
  tilt.rotation.x = Math.PI / 2 - 0.42;
  group.add(tilt);
  const disk = new THREE.Mesh(
    new THREE.RingGeometry(innerR, outerR, 192, 1),
    additiveShader(diskU, BODY_VERT, DISK_FRAG, { side: THREE.DoubleSide }),
  );
  tilt.add(disk);

  // Dark violet halo behind the hole
  const haloMat = new THREE.SpriteMaterial({
    map: glowTexture(0x5b21b6, 256), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.3,
  });
  const halo = new THREE.Sprite(haloMat);
  halo.scale.set(outerR * 3.0, outerR * 3.0, 1);
  group.add(halo);

  return {
    group,
    horizon: horizonMesh,
    photon,
    photonMat,
    lens,
    lensMat,
    disk,
    diskU,
    halo,
    haloMat,
  };
}

/**
 * One comet slot of the pool: a glowing head sprite and a tail of `samples` points.
 * The tail points are drawn with TAIL_FRAG: alpha falls toward the tail end (set per frame from comet.js).
 *   opts.samples     number of tail points
 *   opts.tailSize    size of the first (head side) tail point, world units at distance 1
 *   opts.scaleU      shared uniform { value } with the device pixels per world unit
 */
export function createCometSlot({ samples, tailSize, scaleU }) {
  const headMat = new THREE.SpriteMaterial({
    map: cometHeadTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
  });
  const head = new THREE.Sprite(headMat);
  head.visible = false;

  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(samples * 3);
  const alphas = new Float32Array(samples);
  const sizes = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    // Tail points shrink toward the far end, so the tail tapers
    sizes[i] = tailSize * (1 - 0.75 * (i / Math.max(1, samples - 1)));
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  const tailU = { uColor: { value: new THREE.Color(0xffffff) }, uGain: { value: 2.6 }, uScale: scaleU };
  const tailMat = new THREE.ShaderMaterial({
    uniforms: tailU,
    vertexShader: TAIL_VERT,
    fragmentShader: TAIL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const tail = new THREE.Points(geo, tailMat);
  tail.frustumCulled = false;
  tail.visible = false;

  return { head, headMat, tail, tailMat, tailU, geo, positions, alphas };
}

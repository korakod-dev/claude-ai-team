/**
 * stellar/shaders.js - GLSL source of the Stellar Universe scene (Phase 2). Plain strings, no THREE, no DOM.
 * Used by backdrop.js (sky, stars, dust) and bodies.js (sun, planets, black hole, comet tails).
 * Everything is procedural: no texture file is loaded. Code and comments in English.
 *
 * Colour convention: the shaders write linear HDR values (> 1 for the hot parts). The composer's bloom pass
 * picks up the bright parts, and OutputPass does the tone mapping.
 */

// Shared 3D value noise and fractal noise. Hash based, no textures. Four octaves keep the cost low on a laptop GPU.
const NOISE_GLSL = `
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i + vec3(0.0, 0.0, 0.0)), hash3(i + vec3(1.0, 0.0, 0.0)), f.x),
                   mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x),
                   mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
  }
  // Four octaves, normalised to about 0..1
  float fbm3(vec3 p) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      s += a * vnoise3(p);
      p = p * 2.02 + vec3(3.1, 1.7, 5.3);
      a *= 0.5;
    }
    return s / 0.9375;
  }
`;

/* ---------- backdrop ---------- */

// Sky dome: deep-space gradient with a slowly drifting nebula (violet, teal, magenta) and a faint galactic band.
// The dome is centred on the origin and drawn first (renderOrder -1), so it never moves with the camera.
export const SKY_VERT = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

export const SKY_FRAG = NOISE_GLSL + `
  uniform float uTime;   // simulated seconds (slow drift)
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float t = uTime * 0.01;
    // Two-layer domain warp gives soft, cloud-like nebula shapes
    float n1 = fbm3(d * 1.7 + vec3(t, 0.0, -t * 0.7));
    float n2 = fbm3(d * 3.4 - vec3(0.0, t * 1.2, 0.0) + n1 * 0.9);
    vec3 col = vec3(0.008, 0.010, 0.030);                              // deep space
    col += vec3(0.20, 0.06, 0.36) * smoothstep(0.48, 0.98, n1) * 0.26; // violet clouds (kept faint: the stars must read)
    col += vec3(0.02, 0.20, 0.25) * smoothstep(0.45, 0.95, n2) * 0.20;  // teal clouds
    col += vec3(0.30, 0.05, 0.18) * smoothstep(0.6, 1.0, n1 * n2 * 1.8) * 0.14; // magenta dust lanes
    // Galactic band: a bright ribbon along a tilted great circle
    vec3 bandN = normalize(vec3(0.25, 0.9, 0.35));
    float band = 1.0 - smoothstep(0.0, 0.22, abs(dot(d, bandN)));
    col += vec3(0.10, 0.09, 0.16) * band * (0.35 + 0.45 * n2) * 0.6;
    gl_FragColor = vec4(col, 1.0);
  }`;

// Stars: one point per star, per-star size and colour, slow twinkle. Used by every star layer.
export const STAR_VERT = `
  attribute float aSize;   // CSS px
  attribute vec3 aColor;   // linear colour, already scaled by brightness
  attribute float aPhase;  // random 0..1
  uniform float uTime;
  uniform float uPixel;    // device pixels per CSS pixel
  varying vec3 vColor;
  void main() {
    float tw = 0.85 + 0.15 * sin(uTime * (0.8 + aPhase * 1.8) + aPhase * 60.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixel;
    gl_Position = projectionMatrix * mv;
    vColor = aColor * tw;
  }`;

export const STAR_FRAG = `
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float d2 = dot(p, p);
    float core = exp(-d2 * 14.0);       // bright centre
    float halo = exp(-d2 * 3.0) * 0.25; // soft falloff
    float a = core + halo;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor, a);     // additive
  }`;

// Space dust: tiny drifting motes. The drift and the wrap happen on the GPU (mod in a box), so there is no CPU cost per mote.
export const DUST_VERT = `
  attribute float aSeed;
  attribute float aSize;
  uniform float uTime;
  uniform float uScale;     // device pixels per world unit at distance 1 (set on resize)
  uniform vec3 uBox;        // wrap box size (world units)
  varying float vAlpha;
  void main() {
    vec3 drift = vec3(sin(uTime * 0.05 + aSeed * 6.2) * 0.6,
                      uTime * (0.05 + 0.08 * aSeed),
                      cos(uTime * 0.04 + aSeed * 9.0) * 0.6);
    vec3 p = mod(position + drift + uBox * 0.5, uBox) - uBox * 0.5;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
    // Motes near the camera fade out, so they never blur the view
    vAlpha = (0.2 + 0.5 * fract(aSeed * 17.3)) * smoothstep(1.5, 7.0, -mv.z);
  }`;

export const DUST_FRAG = `
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * a, 1.0); // additive
  }`;

/* ---------- sun ---------- */

// Shared vertex shader for the body shells: passes the object normal, view direction, local position and world data.
export const BODY_VERT = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vLocal;
  varying vec3 vWorldN;
  varying vec3 vWorldP;
  void main() {
    vLocal = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldP = wp.xyz;
    vWorldN = normalize(mat3(modelMatrix) * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;

// Sun surface: domain-warped plasma with granules and limb darkening. Values above 1 feed the bloom.
export const SUN_CORE_FRAG = NOISE_GLSL + `
  uniform vec3 uHot;      // hottest plasma
  uniform vec3 uMid;      // mid plasma
  uniform vec3 uEdge;     // cooler plasma at the edges of the cells
  uniform float uGlow;    // 0..1 status glow (active = brighter), plus the dispatch impact
  uniform float uError;   // 0..1 red tint
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vLocal;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewDir);
    vec3 d = normalize(vLocal);
    float mu = clamp(dot(N, V), 0.0, 1.0);
    float t = uTime * 0.06;
    vec3 q = d * 2.6 + vec3(t, -t * 0.5, t * 0.3);
    vec3 warp = vec3(fbm3(q), fbm3(q + vec3(5.2, 1.3, 2.8)), fbm3(q + vec3(1.7, 9.2, 3.4)));
    float plasma = fbm3(q + warp * 1.6);                    // domain-warped flow
    float granule = vnoise3(d * 34.0 + vec3(t * 2.0));      // fine granules
    float tone = clamp(plasma * 0.95 + granule * 0.22 - 0.04, 0.0, 1.0);
    vec3 col = mix(uEdge, uMid, smoothstep(0.1, 0.55, tone));
    col = mix(col, uHot, smoothstep(0.55, 0.95, tone));
    float limb = 0.4 + 0.6 * pow(mu, 0.5);                  // limb darkening
    float intensity = (0.95 + 0.95 * uGlow) * limb;   // kept below the tone-mapping knee so the hues stay saturated
    col = mix(col, vec3(1.0, 0.22, 0.18), uError * 0.5);
    gl_FragColor = vec4(col * intensity, 1.0);
  }`;

// Chromosphere shell: a thin bright band at the limb with prominence loops (additive).
export const SUN_PROM_FRAG = NOISE_GLSL + `
  uniform vec3 uColor;
  uniform float uGlow;
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vLocal;
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewDir);
    float rim = 1.0 - clamp(dot(N, V), 0.0, 1.0);
    vec3 d = normalize(vLocal);
    float t = uTime * 0.1;
    float loops = smoothstep(0.6, 0.9, fbm3(d * 6.0 + vec3(t, -t * 0.6, t * 0.4)));
    float limbMask = smoothstep(0.5, 1.0, rim);
    float prominence = loops * limbMask * (0.7 + 1.0 * uGlow);
    float chromo = pow(rim, 3.0) * (0.25 + 0.5 * uGlow);
    gl_FragColor = vec4(uColor * (chromo + prominence * 1.4), 1.0);
  }`;

// Corona: outer shell with radial streamers that fade with distance from the limb (additive).
export const CORONA_FRAG = NOISE_GLSL + `
  uniform vec3 uColor;
  uniform float uGlow;
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vLocal;
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewDir);
    float rim = 1.0 - clamp(dot(N, V), 0.0, 1.0);
    vec3 d = normalize(vLocal);
    float streak = fbm3(d * 2.2 + vec3(0.0, uTime * 0.03, 0.0));
    float streamers = 0.5 + 1.0 * streak;
    float falloff = pow(rim, 2.2);
    float flicker = 0.94 + 0.06 * sin(uTime * 1.7);
    float strength = falloff * streamers * (0.30 + 0.55 * uGlow) * flicker;
    gl_FragColor = vec4(uColor * strength, 1.0);
  }`;

/* ---------- planets ---------- */

// Planet surface. Four surface types, chosen per agent by the uType uniform:
//   0 circuit   (Dev-ไอ้เก่ง, apps/)           ridged noise veins over dark-blue plates
//   1 bands     (QA-คุณละเอียด, read-only; also PM-Professor-X in rose)    gas-giant bands with a storm spot
//   2 continents (Writer-ยัยแว่นหนา, study/) ocean, land and cloud layer
//   3 marble    (Content Director, portfolio/) domain-warped swirls
// Lighting: the sun sits at the world origin, so the sunward side is lit and the far side is night (soft terminator).
export const PLANET_FRAG = NOISE_GLSL + `
  uniform float uType;     // 0..3, see above
  uniform vec3 uC0;        // base colour
  uniform vec3 uC1;        // second colour
  uniform vec3 uC2;        // accent colour
  uniform vec3 uAtmo;      // rim colour
  uniform float uGlow;     // status glow 0..1
  uniform float uError;    // 0..1 error aura (dark red)
  uniform float uTime;
  varying vec3 vLocal;
  varying vec3 vWorldN;
  varying vec3 vWorldP;

  void main() {
    vec3 d = normalize(vLocal);
    float t = uTime * 0.05;
    vec3 alb;
    if (uType < 0.5) {
      // Circuit: ridged noise makes thin bright veins, the plates are a smoother noise
      float ridge = 1.0 - abs(fbm3(d * 5.5 + vec3(0.0, t, 0.0)) * 2.0 - 1.0);
      float veins = smoothstep(0.80, 0.97, ridge);
      float plates = smoothstep(0.30, 0.70, fbm3(d * 2.2));
      alb = mix(uC0, uC1, plates);
      alb += uC2 * veins * (1.0 + 0.6 * sin(uTime * 2.0 + d.y * 7.0));
    } else if (uType < 1.5) {
      // Bands: latitude stripes warped by noise, one storm spot
      float warp = fbm3(d * vec3(2.0, 5.0, 2.0) + vec3(t)) * 0.35;
      float bandPattern = 0.5 + 0.5 * sin((d.y + warp) * 24.0);
      alb = mix(uC0, uC1, bandPattern);
      float stormDist = length(d - normalize(vec3(0.6, 0.25, 0.75)));
      float storm = smoothstep(0.30, 0.10, stormDist);
      alb = mix(alb, uC2, storm * 0.85);
    } else if (uType < 2.5) {
      // Continents: height noise gives ocean, land and mountains; drifting clouds on top
      float h = fbm3(d * 2.4);
      float land = smoothstep(0.52, 0.56, h);
      vec3 ocean = mix(uC0, uC1, smoothstep(0.30, 0.60, h));
      vec3 ground = mix(uC1, uC2, smoothstep(0.56, 0.75, h));
      alb = mix(ocean, ground, land);
      float cloud = smoothstep(0.58, 0.80, fbm3(d * 4.0 + vec3(t * 2.0, 0.0, 0.0)));
      alb = mix(alb, vec3(0.92, 0.96, 1.0), cloud * 0.75);
    } else {
      // Marble: domain-warped swirls in three colours
      vec3 q = d * 2.6;
      vec3 w = vec3(fbm3(q), fbm3(q + vec3(3.1, 1.4, 0.7)), fbm3(q + vec3(7.7, 2.2, 4.1)));
      float s = fbm3(q + w * 2.0 + vec3(t));
      alb = mix(uC0, uC1, smoothstep(0.30, 0.70, s));
      alb = mix(alb, uC2, smoothstep(0.55, 0.90, w.x * s * 1.6));
    }

    vec3 N = normalize(vWorldN);
    vec3 L = normalize(-vWorldP);                    // the sun is at the origin
    float ndl = dot(N, L);
    float lit = smoothstep(-0.20, 0.35, ndl);        // day / terminator / night
    vec3 V = normalize(cameraPosition - vWorldP);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 day = alb * (0.16 + 1.35 * max(ndl, 0.0));   // sunward side: bright
    vec3 night = alb * 0.06;                          // night side: dim, still readable
    vec3 col = mix(night, day, lit);
    col += uAtmo * rim * (0.20 + 0.9 * lit);         // rim light, brighter on the sunward side
    col += alb * uGlow * 0.30;                       // active planets glow a little
    col = mix(col, vec3(0.30, 0.02, 0.02) + col * 0.5, uError * 0.45); // error: darker and red
    gl_FragColor = vec4(col, 1.0);
  }`;

// Atmosphere shell: rim-only additive glow in the planet colour. Dark red for an error aura.
export const ATMO_FRAG = `
  uniform vec3 uColor;
  uniform float uGlow;
  uniform float uError;
  uniform float uTime;
  uniform vec3 uSunPos;
  varying vec3 vWorldN;
  varying vec3 vWorldP;
  void main() {
    vec3 N = normalize(vWorldN);
    vec3 V = normalize(cameraPosition - vWorldP);
    float facing = max(dot(N, V), 0.0);
    float rim = pow(1.0 - facing, 2.4);
    vec3 L = normalize(uSunPos - vWorldP);
    float lit = clamp(dot(N, L) * 0.5 + 0.65, 0.0, 1.0);
    vec3 c = mix(uColor, vec3(1.0, 0.10, 0.10), uError);
    float pulse = 0.92 + 0.08 * sin(uTime * 3.0);
    float a = rim * (0.22 + 0.7 * uGlow) * (0.45 + 0.55 * lit) * pulse;
    gl_FragColor = vec4(c * a, 1.0);   // additive
  }`;

// Energy ring: a thin band that pulses slowly. Its opacity and radius are set by scene.js.
export const RING_FRAG = `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  varying vec3 vLocal;
  void main() {
    float a = uOpacity * (0.75 + 0.25 * sin(uTime * 4.0 + atan(vLocal.y, vLocal.x) * 3.0));
    gl_FragColor = vec4(uColor * a * 1.6, 1.0);   // additive
  }`;

/* ---------- black hole ---------- */

// Accretion disk: flat ring in its local XY plane. Swirling hot bands, brighter when debris falls in (uPull) or a comet arrives (uFlash).
export const DISK_FRAG = NOISE_GLSL + `
  uniform float uTime;
  uniform float uInner;   // inner radius (local units)
  uniform float uOuter;   // outer radius (local units)
  uniform float uPull;    // 0..1 eased: debris is falling in
  uniform float uFlash;   // 0..1 short pulse after a debris comet arrives
  varying vec3 vLocal;
  void main() {
    float r = length(vLocal.xy);
    float x = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0); // 0 = inner edge, 1 = outer edge
    float edge = smoothstep(0.0, 0.06, x) * (1.0 - smoothstep(0.82, 1.0, x));
    float ang = atan(vLocal.y, vLocal.x);
    float swirl = 0.5 + 0.5 * sin(ang * 6.0 - uTime * (1.2 + 2.2 * uPull) + x * 10.0);
    float turb = vnoise3(vec3(ang * 2.5 - uTime * 0.7, x * 7.0, 0.0));
    vec3 hot = vec3(1.0, 0.96, 0.80);
    vec3 mid = vec3(1.0, 0.55, 0.14);
    vec3 cold = vec3(0.55, 0.09, 0.03);
    vec3 col = mix(hot, mid, smoothstep(0.0, 0.35, x));
    col = mix(col, cold, smoothstep(0.55, 1.0, x));
    float intensity = edge * (0.30 + 0.95 * swirl * (0.55 + 0.45 * turb)) * (1.0 + 1.6 * uFlash);
    gl_FragColor = vec4(col * intensity * 1.8, 1.0); // additive
  }`;

/* ---------- comets ---------- */

// Comet tail: point sprites, one per tail sample. Size and alpha fall off toward the tail end (aAlpha from comet.js).
export const TAIL_VERT = `
  attribute float aAlpha;   // 0..1 brightness of this sample (0 = invisible)
  attribute float aSize;    // world units at distance 1 (sample size)
  uniform float uScale;     // device pixels per world unit at distance 1
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
    vAlpha = aAlpha;
  }`;

export const TAIL_FRAG = `
  uniform vec3 uColor;
  uniform float uGain;      // brightness of the tail (additive, blooms)
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float a = exp(-dot(p, p) * 3.0) * vAlpha;
    if (a < 0.005) discard;
    vec3 c = mix(uColor, vec3(1.0), 0.35 * vAlpha);   // the head of each sample is whiter
    gl_FragColor = vec4(c * a * uGain, 1.0);          // additive
  }`;

/* ---------- post ---------- */

// Cinematic post pass (after OutputPass, so it works on display-referred sRGB values).
// Slight chromatic aberration at the edges, animated film grain, soft vignette.
export const CINEMATIC_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

export const CINEMATIC_FRAG = `
  uniform sampler2D tDiffuse;
  uniform float uTime;        // real seconds (grain animation)
  uniform float uAberration;  // strength of the radial colour split
  uniform float uGrain;       // grain amplitude (0..1)
  uniform float uVignette;    // vignette strength (0..1)
  varying vec2 vUv;

  float rnd(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec2 c = vUv - 0.5;
    float r2 = dot(c, c);
    vec2 shift = c * r2 * uAberration;
    vec3 col;
    col.r = texture2D(tDiffuse, vUv + shift).r;
    col.g = texture2D(tDiffuse, vUv).g;
    col.b = texture2D(tDiffuse, vUv - shift).b;

    float grain = rnd(vUv * vec2(1357.0, 911.0) + fract(uTime) * 97.0) - 0.5;
    col += grain * uGrain;

    float d = clamp(length(c) * 1.414, 0.0, 1.0);
    float vig = 1.0 - 0.6 * smoothstep(0.4, 1.0, d);
    col *= mix(1.0, vig, uVignette);

    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }`;

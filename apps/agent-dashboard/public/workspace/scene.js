/**
 * scene.js - Stellar Universe view of the agent team (Multi-Agent Workspace, /workspace, left panel). Phase 2 look.
 *
 * Scene layout (world units, the sun is at the origin):
 *   - Backdrop (stellar/backdrop.js): deep-space sky dome with a drifting nebula and a galactic band, three star layers
 *     that turn by different amounts when the camera yaws (parallax), twinkling stars and drifting space dust.
 *   - Sun = เลขาคนสวย (main agent). Large (SUN_RADIUS), with a plasma surface (domain-warped noise), a chromosphere
 *     with prominences, a corona with streamers and a warm halo. Dispatching a task makes it flare and sends out
 *     a shock ring.
 *   - Planets = the five registered sub-agents (PM-Professor-X, Dev-ไอ้เก่ง, QA-คุณละเอียด, Writer-ยัยแว่นหนา, Content Director), each on its own circular orbit (ORBIT_LAYOUT block). Each agent has its own
 *     surface type (PLANET_THEME): PM-Professor-X pink continents (innermost orbit), Dev-ไอ้เก่ง circuit plates, QA-คุณละเอียด gas-giant bands, Writer-ยัยแว่นหนา continents, Content Director marble.
 *     Dynamic planets: any other agent gets a planet on its first event (up to MAX_DYNAMIC_PLANETS). It sits on an orbit
 *     outside the registered ones, with a look derived from its name (stellar/dynamic.js). Beyond the cap it has no planet.
 *     Surfaces are lit by the sun (day side, terminator, night side). Orbit lines are visible in each planet's colour.
 *     Status (rules in stellar/model.js):
 *       idle    slow spin, soft pale halo; a short pale yellow flash after COMPLETED
 *       active  faster spin, and an energy ring that widens with the number of open tasks (store.js)
 *       error   the planet shakes, gets a dark-red aura and a red atmosphere
 *   - Comets (stellar/bodies.js, comet.js): dispatch = sun -> planet (PROCESSING handoff), result = planet -> sun
 *     (COMPLETED). A bright head with a long tapering particle tail.
 *   - Black hole, upper right (BLACK_HOLE_HOME): always visible. Dark core, photon ring, lensing ring, and a rotating
 *     accretion disk. A failed task (ERROR) is pulled into it. Visual only: there is no retry in this phase.
 *   - User Prompt (the owner, คุณกฎ) = a large pale star OUTSIDE the agent system: upper left, beyond the outermost orbit
 *     (horizontally) and lifted above the orbit plane, mirroring the black hole on the upper right (OWNER_POSITION, ORBIT_LAYOUT block). It is not a camera fit point (see CAMERA_FIT).
 *     Its dispatch comet to the sun (เลขาคนสวย) crosses the whole system.
 *   - Click a planet: the camera flies to it (smooth ease over FLIGHT_SECONDS), then follows it. The HUD
 *     (index.html #planet-hud, stellar/hud.js) shows its current and recent tasks and its last log lines
 *     (stellar/store.js). Click empty space or press Esc to release.
 *   - Lighting: the sun is the only light source (sunward side lit). The planet shaders compute the lighting themselves.
 *   - Post-processing: RenderPass (MSAA target) -> UnrealBloomPass -> OutputPass (Neutral tone mapping, sRGB)
 *     -> cinematic ShaderPass (chromatic aberration, film grain, vignette).
 *
 * Moons: when two or more instances of the SAME agent run at once (several Agent tool calls of one type), each instance
 * is a small moon on a circle around its planet (stellar/moons.js). One instance has no moon. A moon goes away when its
 * instance completes or fails (store.js closes the task), or by itself after MOON_TIMEOUT_MS (a missed end event). At most
 * MAX_MOONS are drawn, a "+N" chip in the planet label counts the rest. A moon has no label; hovering it shows what that
 * instance is doing (its task text). Moons apply to every planet (registered and dynamic), not to the sun or the owner star.
 * The moon circle lies INSIDE the satellite extent (ORBIT_LAYOUT block), so orbit spacing and camera framing are unchanged.
 * A planet's status is derived from its open instances (store.js instanceState), not from the latest event, so one instance
 * finishing while another still runs does not turn the planet idle.
 *
 * Activity effects (owner-approved ideas 1 + 4 + 6; rules in stellar/activity.js, meshes in stellar/effects.js):
 *   1. Thinking pulse: while a planet has a live instance that is not running a tool, its halo breathes slowly (a heartbeat curve);
 *      a thinking moon pulses in size. With prefers-reduced-motion the pulse is a static glow.
 *   4. Beam per tool call: on each PreToolUse a short bolt shoots out of the planet (or of the moon of that instance, or of the sun
 *      for the main session), coloured by tool type (Read/Grep/Glob cyan, Edit/Write orange, Bash red, WebSearch/WebFetch purple,
 *      other white). Pooled (MAX_BEAMS), oldest reused. Off with prefers-reduced-motion.
 *   6. Finish burst: a ring of particles in green (COMPLETED) or red (ERROR) when an instance or planet finishes. Pooled
 *      (MAX_BURSTS). Live events only. Off with prefers-reduced-motion.
 * The tool calls arrive on their own SSE channel ("activity", app.js -> 'workspace:activity'); the server attributes a call to an
 * instance (moon) only when the hook carried agent_id and the link is trusted, otherwise to the planet. The effects are drawn in
 * world space on top of the scene: they change no orbit, extent or camera fit.
 *
 * Data honesty: the event stream has no CPU, memory, token or context-limit values and no timeout status. The HUD shows
 * "no data" for them, and nothing in the scene is sized or coloured by them. The moon count is the number of instances
 * the events really report. The energy ring follows the number of running tasks only (store.js); that count is approximate (README).
 *
 * ---------- Quality and 4K ----------
 * Resolution: the renderer pixel ratio is min(devicePixelRatio, preset.maxPixelRatio) * pixelScale of the active
 * quality preset (low, medium and high are capped at 1.5, ultra at MAX_PIXEL_RATIO = 2). The presets and the rule
 * live in stellar/quality.js, which keeps the ratio non-decreasing from low to ultra on every device pixel ratio.
 * The sky dome is drawn at SKY_SCALE (half resolution) by SkyPass and upscaled to full screen.
 * QUALITY_LEVEL (below) selects 'auto' (adaptive governor) or a fixed level 0..3. The HUD button "Quality" in the
 * stage cycles auto -> low -> medium -> high (a fixed level turns the governor off).
 * The governor measures real frame time over GOVERNOR.windowSeconds and steps the level down when FPS
 * is below GOVERNOR.minFps; it steps back up after GOVERNOR.stableWindows windows with FPS >= GOVERNOR.stableFps.
 * Each preset sets: pixel scale, bloom strength, cinematic post on/off, and the share of particles drawn.
 * The current level is written to the #scene element as data-quality (for QA).
 *
 * Public hooks, used by app.js through window.workspaceScene:
 *   setNodeStatus(step, status)  stores the status of the sun or the owner star. PROCESSING / WORKING: active glow and
 *                                faster spin. COMPLETED: short flash, then idle. ERROR: red aura and shake until the next
 *                                status. Planets ignore it: their status comes from their open instances (store.js).
 *   handoff(fromStep, toStep)    dispatch comet from one body to the other. The sun flares when it dispatches.
 *   reset()                      every body back to idle, comets off, HUD closed and the HUD store cleared
 *                                (used by "ล้างหน้าจอ").
 *
 * Events: app.js dispatches window events 'workspace:event' ({ event, replay }) for every event it applies, and
 * 'workspace:scene-ready' once this module has registered its listener (app.js buffers events until then).
 * The HUD store takes every event (including the replayed history). Result and failure comets come from live
 * events only (replay is false), never from the replay burst after a reconnect.
 *
 * Labels are the HTML .node elements of index.html (data-step). They are DOM elements above the canvas, so
 * a planet or the sun never covers them. Each frame updateLabels() projects every body and anchors its label on a
 * fixed side of it (labelRect, see the LABEL_LAYOUT block): labels never move to avoid each other. When two labels
 * overlap, the one farther from the camera fades (labelTargetOpacity). Labels are compact (name chip) unless the
 * planet is hovered or focused (class is-expanded). A body hidden behind the sun or another planet gets class
 * is-occluded (dashed label border).
 *
 * Camera: slow drift (off with prefers-reduced-motion), drag to orbit, wheel to zoom within a limited range,
 * double-click to reset the view. A planet click flies the camera to that planet, and it follows it while focused.
 *
 * Performance: about 3800 stars and 900 dust motes (GPU shaders, Points), up to 8 comets with 40 tail points each.
 * Lower quality levels draw a share of them. The render loop stops while the tab is hidden.
 *
 * Fallback: without WebGL, or if the scene fails to start, the stage keeps its list layout
 * (class "no-webgl" in index.html and style.css) and window.workspaceScene is not set.
 */
// Plain ES module, no build step. Three.js r170 is vendored in ./vendor/three (no CDN, works offline).
// Every texture and shader is generated in code (canvas 2D or GLSL). No external texture or image is loaded.
// Code and comments in English.
import * as THREE from './vendor/three/three.module.min.js';
import { EffectComposer } from './vendor/three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from './vendor/three/addons/postprocessing/ShaderPass.js';
import {
  PLANET_STEPS, SUN_STEP, BLACK_HOLE_STEP, AGENT_STEP, statusMood, planetLook, visualIntentsForEvent,
  stepOfEvent, dynamicKeyOf, isDynamicKey, isPlanetKey, agentOfBodyKey, setAgentModels, withModel, chipTextOf,
} from './stellar/model.js';
import { MAX_DYNAMIC_PLANETS, createDynamicRegistry, cssHex } from './stellar/dynamic.js';
import { hashName } from './stellar/dynamic.js';   // per-body phase of the thinking pulse
import { cometProgress, cometEnvelope, cometPoint, fillTail } from './stellar/comet.js';
import { createStore } from './stellar/store.js';
import { moonAngle, moonTip } from './stellar/moons.js';
import {
  createActivityTracker, isActivity, isStale, activityLabel, burstFor, heartbeat,
} from './stellar/activity.js';
import { createEffects } from './stellar/effects.js';
import { createHud } from './stellar/hud.js';
import { createBackdrop } from './stellar/backdrop.js';
import {
  SURFACE, createSun, createPlanet, createBeacon, createBlackHole, createCometSlot,
} from './stellar/bodies.js';
import { CINEMATIC_VERT, CINEMATIC_FRAG } from './stellar/shaders.js';
import { SkyPass } from './stellar/sky-pass.js';
import { QUALITY_PRESETS, effectivePixelRatio, createPixelRatioApplier } from './stellar/quality.js';
import { createHoverState, setHoverPointer, takeHoverPointer, bindHoverClear } from './stellar/hover.js';

// app.js (a classic script, no WebGL needed) builds its own store for the list view with this factory, so the list and the
// scene derive the status and the instance count with the SAME rules. A module runs before DOMContentLoaded, so it is set
// before the first event is handled, even when the scene itself cannot start.
window.createWorkspaceStore = createStore;
// Same for the activity rules: the agent list in app.js shows a text state ("คิดอยู่" / "กำลังใช้ tool: Read") from its own tracker
window.workspaceActivity = Object.freeze({ createActivityTracker, isActivity, isStale, activityLabel });

/* ---------- quality settings (edit here) ---------- */

// 'auto' = the adaptive governor chooses the level (starts at AUTO_START_LEVEL).
// 0 = low, 1 = medium, 2 = high, 3 = ultra. A number fixes the level and turns the governor off.
const QUALITY_LEVEL = 'auto';

// The presets (QUALITY_PRESETS: pixel scale, pixel ratio cap, bloom, cinematic, particles) and the pixel ratio
// rule (effectivePixelRatio) are in stellar/quality.js, so the node tests can check them.
const AUTO_START_LEVEL = 2;   // 'auto' starts at 'high' and may climb to 'ultra' when the frame rate is stable

// Adaptive governor (used only when QUALITY_LEVEL is 'auto'). Times are real seconds, not simulated seconds.
const GOVERNOR = {
  windowSeconds: 2,   // frame time is averaged over this window
  minFps: 50,         // below this average, step quality down one level
  stableFps: 57,      // at or above this average, count the window as stable
  stableWindows: 2,   // consecutive stable windows (about 4 s) before stepping up
  // Step-ups that change the renderer pixel ratio (a canvas resize) need this many stable windows instead (about 8 s).
  // Stepping down is never delayed: a slow frame rate must be fixed at once.
  resizeStableWindows: 4,
  settleSeconds: 1,   // frames right after a level change are ignored (shader and texture warm-up)
  capSeconds: 60,     // after a step down, the level that was too heavy is not retried for this long
};
const MSAA_SAMPLES = 4;      // multisampling of the scene render target (the composer draws into it)
const SKY_SCALE = 0.5;       // sky dome is drawn at this fraction of the composer size per axis (SkyPass), then upscaled

/* ---------- tuning constants ---------- */

// prefers-reduced-motion is read at start AND followed live: when the OS setting changes while the page is open, the
// "change" listener below (applyReducedMotion) updates these two values; they are read on every frame.
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let REDUCED_MOTION = reducedMotionQuery.matches;
let TIME_SCALE = REDUCED_MOTION ? 0.35 : 1;    // every animation runs at this speed (slower when reduced motion is on)

const CAMERA_FOV = 50;                         // degrees
const FOV_RAD = THREE.MathUtils.degToRad(CAMERA_FOV);
const LOOK_AT = new THREE.Vector3(0, 0.4, 0);  // base look-at point; the camera fit may move only its height (CAMERA_FIT block)
const BASE_PITCH = 0.34;                       // radians above the orbit plane
const ZOOM_MIN_FACTOR = 0.65;                  // zoom range relative to the fitted distance
const ZOOM_MAX_FACTOR = 1.5;

const SUN_RADIUS = 2.4;                        // the sun is about four planet radii across (was 1.5)
const SUN_CORONA_SCALE = 1.45;                 // corona shell = SUN_RADIUS * this (also the orbit clearance, see ORBIT_LAYOUT)
const BODY_RADIUS = 0.62;

const IDLE_LEVEL = 0.15;     // glow when idle
const ACTIVE_LEVEL = 1.0;    // glow when PROCESSING or WORKING
const FLASH_LEVEL = 0.6;     // glow during the COMPLETED flash
const ERROR_LEVEL = 0.7;     // glow when ERROR
const COMPLETE_FLASH_SECONDS = 1.6;

// Comets: dispatch = sun -> planet, result = planet -> sun, failure = pulled into the black hole.
const COMET_SECONDS = { dispatch: 2.2, result: 2.6, failure: 2.8 }; // flight time (simulated seconds)
const COMET_LIFT = { dispatch: 0.6, result: 0.9, failure: 0.4 };    // arc height over the straight path (world units)
const COMET_HEAD_SIZE = 1.5;      // head glow sprite size (world units)
const COMET_HEAD_GAIN = 3.0;      // brightness gain of the head (additive, so it blooms)
const COMET_TAIL_LENGTH = 0.5;    // tail length as a fraction of the whole path (0..1)
const MAX_COMETS = 8;             // comet pool size (the oldest comet is reused when the pool is full)
const BEAM_PARTICLES = 40;        // tail points per comet (name kept: the particle budget test reads it)
const TAIL_POINT_SIZE = 0.85;     // size of the first tail point (world units at distance 1)
const SUN_FLARE_DISPATCH = 0.8;   // sun impact when the sun dispatches a task (brightens the sun and flares)
const SUN_FLARE_RESULT = 0.9;     // sun impact when a result comet arrives
const SHOCK_SECONDS = 1.1;        // shock ring of a dispatch: expansion time
const RESULT_COLOR = 0xfef08a;    // pale yellow: result comets and the COMPLETED flash
const TINT_IDLE_HEX = 0xdbeafe;   // pale blue-white: idle halo

// Planet look (stellar/model.js sets the targets; these set how they are drawn)
const LOOK_EASE = 3;              // per second: spin, energy ring and halo tint ease toward their targets
const ENERGY_PER_TASK = 0.14;     // the ring widens by this many body radii per open task...
const ENERGY_MAX_TASKS = 6;       // ...up to this many tasks (the ring stops growing there)
const JITTER_AMPLITUDE = 0.045;   // shake of a planet in the error mood (world units)

// Moons (geometry is in the ORBIT_LAYOUT block)
const MOON_SPEED = 0.9;           // orbit speed (radians per simulated second), faster than the planets (0.075 .. 0.10)
const MOON_GROW_EASE = 4;         // per second: a moon grows in and shrinks out
const MOON_SLOT_EASE = 3;         // per second: the moons of a planet ease to their even spacing when one comes or goes
const MOON_REFRESH_SECONDS = 0.5; // real seconds between two store reads per planet (timeouts need no event)
const MOON_PICK_PX = 14;          // hover radius around a moon centre (screen px), at least
const MOON_LIGHTEN = 0.25;        // moon colour = planet atmosphere colour mixed toward white by this much

// Activity effects (stellar/activity.js rules, stellar/effects.js meshes). Sizes are in world units.
const PULSE_PERIOD = 1.8;         // seconds per heartbeat (slow)
const PULSE_EASE = 3;             // per second: the pulse fades in and out
const PULSE_HALO_OPACITY = 0.1;   // extra halo opacity at the top of a beat (the planet halo opacity is 0.16 .. 0.46)
const PULSE_HALO_SCALE = 0.06;    // extra halo size at the top of a beat (share)
const PULSE_MOON_SCALE = 0.3;     // extra moon size at the top of a beat (share)
const PULSE_STATIC = 0.5;         // reduced motion: constant share of a beat (a static glow instead of a pulse)
const BEAM_PLANET = { radius: BODY_RADIUS * 1.08, length: 0.8 };   // from the surface; ends inside the satellite extent (1.46)
const BEAM_MOON = { radius: 0.14, length: 0.45 };
const BEAM_SUN = { radius: SUN_RADIUS * 1.06, length: 1.3 };
const FAILURE_BEAM_LENGTH = 1.25;  // a failed tool call's red beam is this much longer than a normal beam (stays inside the extents)
const BURST_PLANET = { radius: BODY_RADIUS * 1.1, max: 1.35 };     // ends inside the satellite extent
const BURST_MOON = { radius: 0.15, max: 0.6 };

// Black hole: upper right, behind and above the orbit plane (see the view notes in README). Keep it on the right side.
const BLACK_HOLE_HOME = new THREE.Vector3(18.0, 6.0, -8.5);
const BLACK_HOLE_HORIZON = 0.7;   // dark core radius
const BLACK_HOLE_DISK_INNER = 1.15;
const BLACK_HOLE_DISK_OUTER = 2.6;

// Focus (planet click)
const FOCUS_DISTANCE = 6.5;       // camera distance while a planet is focused (world units)
const FOCUS_EASE = 4;             // per second: the look-at point follows the focused planet
const FLIGHT_SECONDS = 1.2;       // fly-to duration when a planet is focused or released (simulated seconds)
const CLICK_MAX_MOVE = 6;         // px: a pointer that moves more than this is a drag, not a click

// Particle budget (the quality preset draws a share of each). STAR_COUNT = sum of STAR_LAYERS in stellar/backdrop.js.
const STAR_COUNT = 3840;
const DUST_COUNT = 900;           // space dust motes (stellar/backdrop.js DUST_COUNT)

// Satellite look and orbit. Angles are on the XZ plane (radians): -z is the back of the screen (top).
// The orbit radius is not set here: it comes from the orbit layout block (SATELLITE_ORBIT_RADIUS).
// color = orbit line colour (the planet's atmosphere colour).
const SATELLITE_CONFIG = {
  pm:        { color: 0xf472b6, angle: 0, speed: 0.095, seed: 53 },       // PM-Professor-X (planner), rose pink, right, innermost orbit
  appdev:    { color: 0x38bdf8, angle: -2.356, speed: 0.10, seed: 11 },  // Dev-ไอ้เก่ง, electric blue, back-left
  qa:        { color: 0xfacc15, angle: -0.785, speed: 0.085, seed: 23 }, // QA-คุณละเอียด, gold, back-right
  study:     { color: 0x4ade80, angle: 2.356, speed: 0.09, seed: 37 },   // Writer-ยัยแว่นหนา, green, front-left
  portfolio: { color: 0xa78bfa, angle: 0.785, speed: 0.075, seed: 41 },  // Content Director, violet, front-right
};

// Planet surfaces: one type per agent (SURFACE in stellar/bodies.js) and its colours.
//   c0, c1, c2: surface colours (their roles depend on the type), atmo: rim colour and energy ring colour.
const PLANET_THEME = Object.freeze({
  // Only four surface types exist (no heavy new shader), so five planets share them. PM uses BANDS in rose, not
  // CONTINENTS (that is Writer-ยัยแว่นหนา's), so it is told apart by pattern (stripes + storm spot) and by colour
  // (rose vs QA's gold bands).
  pm: {
    type: SURFACE.BANDS,
    c0: 0x4a0d2e, c1: 0xbe185d, c2: 0xfbcfe8, atmo: 0xf472b6, ringScale: 1.5,
  },
  appdev: {
    type: SURFACE.CIRCUIT,
    c0: 0x0a2540, c1: 0x1e5b8f, c2: 0x7ff0ff, atmo: 0x38bdf8, ringScale: 1.5,
  },
  qa: {
    type: SURFACE.BANDS,
    c0: 0x7c2d12, c1: 0xfacc15, c2: 0xc2410c, atmo: 0xfacc15, ringScale: 1.55,
  },
  study: {
    type: SURFACE.CONTINENTS,
    c0: 0x0b3d5c, c1: 0x1f8a70, c2: 0x9be89b, atmo: 0x4ade80, ringScale: 1.5,
  },
  portfolio: {
    type: SURFACE.MARBLE,
    c0: 0x3b0764, c1: 0xa78bfa, c2: 0xf5d0fe, atmo: 0xc084fc, ringScale: 1.6,
  },
});


// ORBIT_LAYOUT:BEGIN
/* ---------- orbit layout: one radius per satellite, so two satellites can never touch ---------- */
// Root cause of the old overlap: all satellites (four at the time) shared one radius (6.2) on one plane, so two of them
// passed the same point whenever their angles matched. Now every satellite has its own circular orbit.
// Circles with different radii in one plane never cross. The 3D distance between two satellites is at least
// the difference of their radii (the bob only adds a vertical offset), so a radius gap larger than the sum of
// their clearance radii keeps their bodies apart at every time and every phase. No per-frame collision check.
// This block is also read by test/workspace-scene.test.js, so keep it self-contained (no THREE here).
const ORBIT_BOB_AMPLITUDE = 0.35;                 // vertical bob of each satellite (world units), see satellitePosition()
const ORBIT_GAP_MARGIN = 0.25;                    // empty space left between two clearance spheres
const SUN_CLEARANCE = SUN_RADIUS * 1.45;          // corona extent of the sun: no satellite may enter it

// Visual extent of each satellite from its centre: the energy ring at its largest (ring scale + ENERGY_PER_TASK x
// ENERGY_MAX_TASKS, in body radii) times BODY_RADIUS. The atmosphere (1.12 x radius) lies inside it. Keep in sync with
// PLANET_THEME.ringScale, ENERGY_PER_TASK, ENERGY_MAX_TASKS and BODY_RADIUS:
//   appdev:    (1.50 + 0.84) x 0.62 = 1.45      study:     (1.50 + 0.84) x 0.62 = 1.45
//   qa:        (1.55 + 0.84) x 0.62 = 1.48      portfolio: (1.60 + 0.84) x 0.62 = 1.51
//   pm:        (1.50 + 0.84) x 0.62 = 1.45
const SATELLITE_EXTENT = { pm: 1.46, appdev: 1.46, qa: 1.49, study: 1.46, portfolio: 1.52 };

// Inner -> outer. The order is chosen so that neighbouring orbits need the least space.
const SATELLITE_ORBIT_ORDER = ['pm', 'qa', 'study', 'appdev', 'portfolio'];

/** Clearance radius of a satellite: how far its centre can be from the orbit circle plus its own extent. */
function satelliteClearance(step) {
  return SATELLITE_EXTENT[step] + ORBIT_BOB_AMPLITUDE;
}

// Orbit radius per satellite, built from the clearances. The innermost orbit clears the sun, and each next
// orbit clears the previous one by (clearance of both) + margin.
const SATELLITE_ORBIT_RADIUS = {};
{
  let radius = SUN_CLEARANCE + satelliteClearance(SATELLITE_ORBIT_ORDER[0]) + ORBIT_GAP_MARGIN;
  SATELLITE_ORBIT_ORDER.forEach((step, i) => {
    if (i > 0) {
      radius += satelliteClearance(SATELLITE_ORBIT_ORDER[i - 1]) + satelliteClearance(step) + ORBIT_GAP_MARGIN;
    }
    SATELLITE_ORBIT_RADIUS[step] = radius;
  });
}

// Owner star (User Prompt, คุณกฎ): OUTSIDE the agent system, not above the sun. It sits off to the side, upper left and
// toward the back, mirroring the black hole on the upper right (BLACK_HOLE_HOME). Geometry (see test/workspace-owner.test.js):
//   - horizontal distance from the sun = hypot(x, z) = 23.07: beyond the outermost registered orbit (portfolio, 21.14), but
//     BELOW the first dynamic ring (25.13), so the horizontal position alone does not separate it from the dynamic planets
//   - the separation comes from the elevation: y = 7.9 lifts the star above the orbit plane, so even the nearest dynamic
//     ring (and its +-0.35 bob) stays about 3.5 world units clear of the star's whole visual extent
//   - the position is chosen so that the star stays fully inside the frame while the camera drifts +-0.22 rad in yaw,
//     +-0.03 rad in pitch, for aspects 0.6 .. 2.0 at the start zoom (about 15 % of NDC left free at the worst case; the position was scaled by about 1.21 when the PM-Professor-X orbit was added)
// OWNER_RADIUS is the body radius (a planet is BODY_RADIUS 0.62, the sun 2.4; the old beacon was 0.2).
// OWNER_EXTENT is its visual reach from the centre (spinning ring at 2.1 x radius, plus the soft core of the halo).
const OWNER_RADIUS = 1.3;
const OWNER_EXTENT = 2.8;
const OWNER_POSITION = [-15.7, 7.9, -16.9];        // x, y, z (the sun is at the origin, -z is the back of the screen)

// Room (world units) kept around every satellite for its HTML label. Used by the camera fit (CAMERA_FIT block).
const LABEL_ROOM = 1.5;

/**
 * Satellite centre for an orbit at a given time: a circle on the XZ plane plus a slow vertical bob.
 * orbit = { angle, radius }. Writes into `out` (a THREE.Vector3 in the scene; any object with set() in tests).
 */
function satellitePosition(orbit, time, out) {
  const a = orbit.angle;
  return out.set(
    Math.cos(a) * orbit.radius,
    Math.sin(time * 0.7 + a) * ORBIT_BOB_AMPLITUDE,
    Math.sin(a) * orbit.radius,
  );
}

// Moons (stellar/moons.js): small bodies on a circle around their planet, one per concurrent instance of the agent.
// The circle lies INSIDE the satellite extent of every planet (the smallest registered extent is 1.46, the dynamic one
// 1.52): MOON_ORBIT_RADIUS + MOON_RADIUS <= extent, checked in test/workspace-moons.test.js. A moon therefore never leaves
// the sphere that the orbit spacing already reserves for its planet, so no orbit radius, clearance or camera fit changes.
// The circle is tilted by MOON_ORBIT_TILT (a pivot group) so it reads from the low default camera pitch; a tilt does not
// change the distance from the planet centre.
const MOON_ORBIT_RADIUS = 1.12;                   // distance of a moon centre from its planet centre (world units)
const MOON_RADIUS = 0.1;                          // radius of a moon (world units)
const MOON_ORBIT_TILT = 0.5;                      // tilt of the moon circle around the X axis (radians)

/** Moon centre on its circle, relative to the planet pivot (before the tilt). Writes into `out` (any object with set()). */
function moonPosition(angle, out) {
  return out.set(Math.cos(angle) * MOON_ORBIT_RADIUS, 0, Math.sin(angle) * MOON_ORBIT_RADIUS);
}

// Dynamic planets (agents that are not registered): one ring each, OUTSIDE the registered orbits, in arrival order.
// Every dynamic planet has the same extent, the largest of the registered ones, so the ring spacing is fixed and
// needs no per-planet check. Keep DYNAMIC_RING_SCALE (scene.js, below) within it: (ringScale + 0.84) x BODY_RADIUS <= extent.
const DYNAMIC_EXTENT = 1.52;                      // = SATELLITE_EXTENT.portfolio (the largest registered extent)
const DYNAMIC_CLEARANCE = DYNAMIC_EXTENT + ORBIT_BOB_AMPLITUDE;
// Radius of the first dynamic ring: outside the outermost registered orbit, with the same gap rule as the registered ones
const DYNAMIC_ORBIT_BASE = SATELLITE_ORBIT_RADIUS[SATELLITE_ORBIT_ORDER[SATELLITE_ORBIT_ORDER.length - 1]]
  + satelliteClearance(SATELLITE_ORBIT_ORDER[SATELLITE_ORBIT_ORDER.length - 1])
  + DYNAMIC_CLEARANCE + ORBIT_GAP_MARGIN;

/** Orbit radius of the dynamic planet with this index (0 = the first ring outside the registered planets). */
function dynamicOrbitRadius(index) {
  return DYNAMIC_ORBIT_BASE + index * (2 * DYNAMIC_CLEARANCE + ORBIT_GAP_MARGIN);
}
// ORBIT_LAYOUT:END

// Owner star position as a vector (floats a little, see updateBody)
const OWNER_HOME = new THREE.Vector3(OWNER_POSITION[0], OWNER_POSITION[1], OWNER_POSITION[2]);


// CAMERA_FIT:BEGIN
/* ---------- camera fit: the distance at which the whole orbit system is inside the frame ---------- */
// Pure functions: no THREE, no DOM. test/workspace-orbit.test.js extracts this block and projects points with it.
//
// Camera model used by updateCamera(): it looks at (0, LY, 0), LY on the Y axis (the base is LOOK_AT.y), from pitch p above the orbit plane at
// distance d. Yaw is left out on purpose: the orbit system is a circle around the Y axis, so yaw does not change
// what fits. Derivation for a point Q relative to LOOK (yaw 0, T = tan(fov / 2)):
//   D = (0, sin p, cos p)   camera direction from LOOK      u = (0, cos p, -sin p)   camera up
//   depth along the view axis:  z = d - Q.D
//   NDC y = (Q.u) / (z * T)            NDC x = Q.x / (z * T * aspect)
// Q.u does not depend on d, so |NDC| <= 1 is linear in d and the smallest fitting distance per point is closed form:
//   d >= Q.D + |Q.u| / T        and        d >= Q.D + |Q.x| / (T * aspect)
// The fit is the maximum over all sample points.
//
// Look-at height: the same derivation holds for any look-at height LY (Q is taken relative to (0, LY, 0)).
// The fit distance is a maximum of convex terms in LY (each term is a linear function plus an absolute value),
// so it is convex in LY. fitViewAtPitch() searches the best LY with a golden-section search: the orbit system is
// seen from above, so the near (bottom) side projects larger than the far (top) side, and moving the look-at point
// re-centres the projected extent and lowers the distance needed. The sun moves on screen by the same amount, so
// the search is limited to LOOK_Y_MAX_SHIFT around the base height.

const CAMERA_PITCH_MIN = 0.09;    // lowest camera pitch (radians above the orbit plane) the view may reach
const CAMERA_PITCH_MAX = 1.19;    // highest camera pitch
const FIT_ANGLE_STEPS = 48;       // sample points around each satellite orbit (7.5 degrees apart)
const FIT_EDGE_PAD = 0.2;         // extra world units kept between the outermost body and the frame edge
const FIT_NDC_MARGIN = 0.02;      // kept free at every screen edge (NDC units, about 5 px on a 520 px stage)
const FIT_MIN_DISTANCE = 12;      // never closer than this (world units)
const LOOK_Y_MAX_SHIFT = 1.5;     // the look-at height may move at most this far from the base height (world units)
const FIT_SEARCH_STEPS = 30;      // golden-section iterations: the 3-unit interval shrinks to about 2e-6 units
const FIT_GOLDEN = (Math.sqrt(5) - 1) / 2;
// Look-at dead-band: the distance gain of the shifted look-at (1 - shifted / base) decides how much of the shift is used.
// Measured at the default pitch (0.34): aspect 0.6-1.2 gives 0.7-1.3 % (not worth moving the sun), aspect 1.5+ gives
// 6.5-7.3 %. The full shift applies from 3 % (the owner's threshold). The ramp starts at 1.5 %, which is above every
// default-pitch gain up to aspect 1.2, so those aspects get exactly no shift. Sweep of the sun per 0.002 aspect step
// (measured): 0.05 at pitch 0.34, 0.12 at 0.7, 0.32 at 1.19 (steepest near aspect 0.9 at top-down pitch).
const FIT_SHIFT_GAIN_ZERO = 0.015; // gain at or below this: no look-at shift (base height)
const FIT_SHIFT_GAIN_FULL = 0.03;  // gain at or above this: full look-at shift (smooth ramp in between)
// Pitch tolerance of the solve cache (radians, about 0.06 degrees): the camera drift changes the pitch every frame, so
// a smaller change than this reuses the cached solve. The camera uses the pitch the solve was made for (see createFitCache).
const FIT_PITCH_TOLERANCE = 0.001;

// 26 unit directions (corners, edge and face centres of a cube). Points on the extent sphere in these directions
// reach the silhouette of a planet close to the camera, which axis points alone do not.
const FIT_DIRECTIONS = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
  if (x || y || z) {
    const n = Math.hypot(x, y, z);
    FIT_DIRECTIONS.push([x / n, y / n, z / n]);
  }
}

/**
 * Points that must stay inside the frame. For every orbit in `orbits` ({ radius, extent }), every angle on its circle
 * and both bob extremes: the centre, and the points on a sphere of radius (extent + label room + edge pad) around it,
 * in FIT_DIRECTIONS. Returns an array of [x, y, z].
 */
function fitSamplePoints(orbits) {
  const points = [];
  orbits.forEach(({ radius: r, extent }) => {
    const reach = extent + LABEL_ROOM + FIT_EDGE_PAD;
    for (let k = 0; k < FIT_ANGLE_STEPS; k++) {
      const a = (k / FIT_ANGLE_STEPS) * Math.PI * 2;
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      [-ORBIT_BOB_AMPLITUDE, ORBIT_BOB_AMPLITUDE].forEach((by) => {
        points.push([cx, by, cz]);
        FIT_DIRECTIONS.forEach((d) => {
          points.push([cx + d[0] * reach, by + d[1] * reach, cz + d[2] * reach]);
        });
      });
    }
  });
  return points;
}

// The registered orbits (five). Dynamic orbits are added by setFitOrbits() when a dynamic planet appears.
const REGISTERED_FIT_ORBITS = SATELLITE_ORBIT_ORDER.map((step) => ({ radius: SATELLITE_ORBIT_RADIUS[step], extent: SATELLITE_EXTENT[step] }));
// The owner star and the black hole are not fit points: both sit in the corners of the frame that the (round) orbit system
// leaves free, so the fit, and the sun position it produces, stay as they were. test/workspace-owner.test.js checks that the
// owner star is inside the frame at the start view for the usual aspect ratios.
let FIT_POINTS = fitSamplePoints(REGISTERED_FIT_ORBITS);

/**
 * Replace the orbits the fit must keep in the frame (registered + active dynamic). The caller must also invalidate
 * the camera solve cache (createFitCache().invalidate) and recompute the fitted distance.
 */
function setFitOrbits(orbits) {
  FIT_POINTS = fitSamplePoints(orbits);
}

/**
 * Smallest camera distance at which every fit point is inside the frame, for this aspect, vertical fov (radians),
 * pitch (radians) and look-at height. Closed form, see the derivation above.
 */
function fitDistanceAtPitch(aspect, fovRad, pitch, lookY) {
  const T = Math.tan(fovRad / 2) * (1 - FIT_NDC_MARGIN); // shrink the usable frame by the NDC margin
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  let need = FIT_MIN_DISTANCE;
  for (let i = 0; i < FIT_POINTS.length; i++) {
    const p = FIT_POINTS[i];
    const qx = p[0];
    const qy = p[1] - lookY;
    const qz = p[2];
    const qD = qy * sp + qz * cp;   // Q . D
    const qu = qy * cp - qz * sp;   // Q . u
    need = Math.max(need, qD + Math.abs(qu) / T, qD + Math.abs(qx) / (T * aspect));
  }
  return need;
}

/**
 * Raw golden-section search for the look-at height with the smallest fit distance (no dead-band). Searches on
 * [lookY0 - LOOK_Y_MAX_SHIFT, lookY0 + LOOK_Y_MAX_SHIFT]. Writes { lookY, distance } into `out` and returns it;
 * `distance` is the exact fit at the returned `lookY`. Used by fitViewAtPitch() and by the tests (dense scan).
 * Cost: FIT_SEARCH_STEPS + 3 evaluations of fitDistanceAtPitch().
 */
function searchLookAtHeight(aspect, fovRad, pitch, lookY0, out) {
  let lo = lookY0 - LOOK_Y_MAX_SHIFT;
  let hi = lookY0 + LOOK_Y_MAX_SHIFT;
  let c = hi - FIT_GOLDEN * (hi - lo);
  let e = lo + FIT_GOLDEN * (hi - lo);
  let fc = fitDistanceAtPitch(aspect, fovRad, pitch, c);
  let fe = fitDistanceAtPitch(aspect, fovRad, pitch, e);
  for (let i = 0; i < FIT_SEARCH_STEPS; i++) {
    if (fc < fe) {
      // Minimum lies in [lo, e]: the old e becomes the new upper probe
      hi = e;
      e = c;
      fe = fc;
      c = hi - FIT_GOLDEN * (hi - lo);
      fc = fitDistanceAtPitch(aspect, fovRad, pitch, c);
    } else {
      // Minimum lies in [c, hi]: the old c becomes the new lower probe
      lo = c;
      c = e;
      fc = fe;
      e = lo + FIT_GOLDEN * (hi - lo);
      fe = fitDistanceAtPitch(aspect, fovRad, pitch, e);
    }
  }
  const lookY = (lo + hi) / 2;
  out.lookY = lookY;
  out.distance = fitDistanceAtPitch(aspect, fovRad, pitch, lookY);
  return out;
}

/** Smoothstep: 0 at or below a, 1 at or above b, smooth (zero slope at both ends) in between. */
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Look-at height and the matching fit distance for this aspect and pitch, written into `out` ({ lookY, distance })
 * and returned. Dead-band: the search result is applied only in proportion to its distance gain over the base height:
 *   gain  = 1 - bestDistance / baseDistance
 *   w     = smoothstep(FIT_SHIFT_GAIN_ZERO, FIT_SHIFT_GAIN_FULL, gain)   (0 = base height, 1 = full search result)
 *   lookY = lookY0 + w * (bestLookY - lookY0)
 * So a gain up to 1.5 % keeps the base height, a gain of 3 % or more uses the full shift, and the ramp in between keeps
 * the height and the distance continuous as the aspect changes (no jump when the window is resized across the threshold).
 * `distance` is always the exact fit at the returned `lookY`, so the framing guarantee holds for the returned pair.
 * The fit is convex in lookY, so a blend between lookY0 and bestLookY is never worse than the base height.
 * Cost: one searchLookAtHeight() plus two evaluations of fitDistanceAtPitch().
 */
function fitViewAtPitch(aspect, fovRad, pitch, lookY0, out) {
  const best = searchLookAtHeight(aspect, fovRad, pitch, lookY0, FIT_SCRATCH);
  const baseDistance = fitDistanceAtPitch(aspect, fovRad, pitch, lookY0);
  const gain = 1 - best.distance / baseDistance;
  const w = smoothstep(FIT_SHIFT_GAIN_ZERO, FIT_SHIFT_GAIN_FULL, gain);
  out.lookY = lookY0 + w * (best.lookY - lookY0);
  // w = 0 keeps the base height exactly; otherwise evaluate the exact fit at the blended height
  out.distance = w === 0 ? baseDistance : fitDistanceAtPitch(aspect, fovRad, pitch, out.lookY);
  return out;
}

/**
 * Cache of fitViewAtPitch() for the camera. The solve depends only on aspect, fov, pitch and the base height, so it
 * is recomputed only when one of them changes: a resize changes the aspect, pitch drag changes the pitch. The camera
 * drift changes the pitch every frame by a tiny amount, so the pitch is compared with FIT_PITCH_TOLERANCE against the
 * pitch of the last solve (so the lag never grows past the tolerance).
 * solve(aspect, fovRad, pitch) returns the cached record { pitch, lookY, distance }. The record's `pitch` is the pitch
 * the solve was made for, and the caller must place the camera at that pitch: the solve and the camera then agree,
 * and the framing is exact. `solves` counts the real solves (used by the tests).
 */
function createFitCache(lookY0) {
  const rec = { pitch: NaN, lookY: lookY0, distance: 0 };
  const key = { aspect: NaN, fovRad: NaN };
  const solved = { lookY: 0, distance: 0 };
  const api = {
    solves: 0,
    solve(aspect, fovRad, pitch) {
      const hit = aspect === key.aspect && fovRad === key.fovRad && Math.abs(pitch - rec.pitch) < FIT_PITCH_TOLERANCE;
      if (!hit) {
        fitViewAtPitch(aspect, fovRad, pitch, lookY0, solved);
        key.aspect = aspect;
        key.fovRad = fovRad;
        rec.pitch = pitch;
        rec.lookY = solved.lookY;
        rec.distance = solved.distance;
        api.solves += 1;
      }
      return rec;
    },
    // Forget the cached solve: the next solve() runs again (used when the fit points change, see setFitOrbits)
    invalidate() {
      key.aspect = NaN;
    },
  };
  return api;
}

// Scratch result of searchLookAtHeight() inside fitViewAtPitch(); reused so a solve does not allocate it
const FIT_SCRATCH = { lookY: 0, distance: 0 };

/**
 * Generic look-at projection of one world point (used by the tests to check the fit with independent maths).
 * camPos, lookAt, p: [x, y, z]. Returns { x, y, depth } where x, y are NDC (on screen when both are within [-1, 1]).
 */
function projectToNdc(p, camPos, lookAt, fovRad, aspect) {
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const f = norm([lookAt[0] - camPos[0], lookAt[1] - camPos[1], lookAt[2] - camPos[2]]); // view axis
  const r = norm(cross(f, [0, 1, 0]));                                                    // camera right
  const u = cross(r, f);                                                                  // camera up
  const d = [p[0] - camPos[0], p[1] - camPos[1], p[2] - camPos[2]];
  const depth = dot(d, f);
  const t = Math.tan(fovRad / 2);
  return { x: dot(d, r) / (depth * t * aspect), y: dot(d, u) / (depth * t), depth };
}
// CAMERA_FIT:END


// LABEL_LAYOUT:BEGIN
/* ---------- label placement: anchored labels, depth-based fade on overlap ---------- */
// Pure functions: no DOM, no THREE. test/workspace-labels.test.js extracts this block and runs it in a sandbox,
// so keep it self-contained. All values are CSS pixels. A label is a rectangle {x, y, w, h} (x, y = top-left).
//
// Rules (owner decision: options 1 + 3):
//   1. A label never moves to avoid another label. It sits on a FIXED side of its planet (LABEL_SIDE), so it
//      follows the planet and never jumps or swaps side. The only clamp is the stage edge (LABEL_EDGE), which
//      keeps a label readable when its planet leaves the view. There is no collision search and no leader line.
//   2. When two labels overlap, the one FARTHER from the camera fades to LABEL_FADE_MIN. The nearer one stays at 1.
//      Opacity eases toward its target (labelOpacityStep), and an overlap has hysteresis (labelTargetOpacity),
//      so a label does not flicker when two planets pass each other at the overlap threshold.
//   3. A pinned label (hovered or focused planet) is always at 1 and is never faded.

const LABEL_GAP_PAD = 6;          // px: two label rectangles closer than this count as overlapping
const LABEL_OVERLAP_HYST = 8;     // px: extra distance a faded label must clear before it is shown again (no flicker)
const LABEL_EDGE = 6;             // px: a label stays this far inside the stage edge (clamp only, see labelRect)
const LABEL_FADE_MIN = 0.15;      // opacity of a label hidden behind a nearer label (still visible as a faint chip)
const LABEL_FADE_RATE = 10;       // per second: how fast the opacity eases toward its target

// Fixed side of each planet's label. 'right' = beside the body, 'above' / 'below' = above / below it.
// Fixed on purpose: a label that switched side with the planet's vertical position would look like it jumped.
const LABEL_SIDE = Object.freeze({
  user: 'right',
  router: 'below',
  pm: 'above',
  appdev: 'above',
  qa: 'above',
  study: 'above',
  portfolio: 'above',
});
// Dynamic planets (keys 'dyn:<agent>') are not in the table: they all use the same fixed side, above.
const DYNAMIC_LABEL_SIDE = 'above';

/** Fixed side of the label of a body key: its LABEL_SIDE entry, or DYNAMIC_LABEL_SIDE for a dynamic planet. */
function labelSideOf(step) {
  return Object.prototype.hasOwnProperty.call(LABEL_SIDE, step) ? LABEL_SIDE[step] : DYNAMIC_LABEL_SIDE;
}

function labelClamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/** True when two rectangles overlap, with `pad` px of space required between them. */
function labelsOverlap(a, b, pad) {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/**
 * Top-left rectangle of a w x h label on its fixed side of the anchor (ax, ay), `gap` px away from the body.
 * Only the stage edge clamp is applied (no collision check): the label is kept inside the view.
 */
function labelRect(side, ax, ay, w, h, gap, view) {
  let x;
  let y;
  if (side === 'right') {
    x = ax + gap;
    y = ay - h / 2;
  } else if (side === 'below') {
    x = ax - w / 2;
    y = ay + gap;
  } else {                       // 'above' (and any unknown side)
    x = ax - w / 2;
    y = ay - gap - h;
  }
  return {
    x: labelClamp(x, LABEL_EDGE, view.w - LABEL_EDGE - w),
    y: labelClamp(y, LABEL_EDGE, view.h - LABEL_EDGE - h),
    w,
    h,
  };
}

/**
 * Target opacity of every label in one frame.
 *   items: [{ id, depth, rect, pinned }]   depth = distance from the camera (smaller = nearer)
 *   prev:  Map id -> previous target (hysteresis: a label that was faded keeps a wider clearance before it is shown)
 *   Pinned labels are always 1 and count as visible. The others are processed nearest first: a label is faded when
 *   it overlaps a label that is already visible (a nearer one), otherwise it is 1. A faded label does not hide the
 *   labels behind it, so there is no chain reaction between frames.
 * Returns Map id -> target opacity.
 */
function labelTargetOpacity(items, prev, pad) {
  const out = new Map();
  const visible = [];
  items.forEach((it) => {
    if (it.pinned) { out.set(it.id, 1); visible.push(it.rect); }
  });
  const rest = items
    .filter((it) => !it.pinned)
    .sort((a, b) => (a.depth - b.depth) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // nearest first, tie by id
  rest.forEach((it) => {
    const wasFaded = !!prev && prev.get(it.id) === LABEL_FADE_MIN;
    const clearance = wasFaded ? pad + LABEL_OVERLAP_HYST : pad;
    const hidden = visible.some((r) => labelsOverlap(it.rect, r, clearance));
    out.set(it.id, hidden ? LABEL_FADE_MIN : 1);
    if (!hidden) visible.push(it.rect);
  });
  return out;
}

/**
 * One easing step of a label opacity toward its target. dt = seconds since the last frame (0 = jump at once).
 * Never leaves [min(from, to), max(from, to)], so it cannot overshoot.
 */
function labelOpacityStep(from, to, dt) {
  if (from === undefined || !(dt > 0)) return to;
  const k = 1 - Math.exp(-dt * LABEL_FADE_RATE);
  return from + (to - from) * k;
}

/**
 * True when a body is hidden from the camera by another sphere (the sun or a planet).
 * camera, target: { x, y, z } world points. targetRadius: radius of the target sphere.
 * occluders: [{ x, y, z, r }]. A sphere occludes only if it lies between the camera and the target's front surface.
 */
function bodyOccluded(camera, target, targetRadius, occluders) {
  const dx = target.x - camera.x;
  const dy = target.y - camera.y;
  const dz = target.z - camera.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return false;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  for (const o of occluders) {
    const ox = o.x - camera.x;
    const oy = o.y - camera.y;
    const oz = o.z - camera.z;
    const t = ox * ux + oy * uy + oz * uz;               // distance along the view ray to the occluder centre
    if (t <= 0 || t - o.r >= len - targetRadius) continue; // behind the camera, or behind the target's front surface
    const px = ox - t * ux;                              // closest point of the ray to the occluder centre
    const py = oy - t * uy;
    const pz = oz - t * uz;
    if (Math.hypot(px, py, pz) < o.r) return true;
  }
  return false;
}
// LABEL_LAYOUT:END


/* ---------- small helpers ---------- */

const ERROR_COLOR_HEX = 0xff4d4d;   // red: error aura, failure comets

/** Clamp a number into [lo, hi]. */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Smooth start and stop (cubic ease in-out) for the camera fly-to. t in 0..1. */
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Colour of a body for its comets and orbit line. */
function colorOf(step) {
  if (step === 'user') return 0xe0f2fe;
  if (step === SUN_STEP) return 0xfff4c2;
  if (isDynamicKey(step)) {
    const entry = dynamic.get(step);
    return entry ? entry.look.color : 0xffffff;   // dynamic planet: colour derived from its name
  }
  return SATELLITE_CONFIG[step] ? SATELLITE_CONFIG[step].color : 0xffffff;
}

/**
 * Register a particle geometry so the quality preset can scale how many points are drawn.
 * The current preset's share is applied at once (comets can be created after the quality was set).
 */
function registerParticles(geo, count) {
  particleSets.push({ geo, count });
  const share = QUALITY_PRESETS[qualityLevel].particleScale;
  geo.setDrawRange(0, Math.max(1, Math.floor(count * share)));
}

/** Faint circle in the XZ plane (orbit line). */
function ringLine(radius, hex, opacity) {
  const points = [];
  for (let i = 0; i <= 160; i++) {
    const a = (i / 160) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({
    color: hex, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  return new THREE.Line(geo, mat);
}

/* ---------- module state (filled by buildScene) ---------- */

let renderer = null;
let composer = null;
let bloomPass = null;      // UnrealBloomPass (strength set by the quality preset)
let skyPass = null;        // SkyPass: sky dome at half resolution, first pass of the composer (stellar/sky-pass.js)
let cinematicPass = null;  // ShaderPass: aberration, grain, vignette
let world = null;          // THREE.Scene
let camera = null;
let container = null;      // #scene (canvas parent)
let layer = null;          // #label-layer (HTML labels)
let stageEl = null;
let fallbackEl = null;
let qualityBtn = null;     // #quality-toggle (HUD button in the stage), may be missing
let shownQuality = '';     // text currently shown on the quality button
let viewW = 1;             // CSS pixels
let viewH = 1;
let fitDist = 18.5;        // distance at which the whole scene fits the view (default pitch, current aspect)
const viewLook = new THREE.Vector3(0, 0.4, 0); // the point the camera looks at this frame (fit-solved height, see updateCamera)
const camFit = createFitCache(LOOK_AT.y);      // cached camera solve (CAMERA_FIT block): recomputed only on aspect / pitch change
let stageSized = false;    // true once resize() has seen a stage with a real size (the first call at boot can see 0 x 0)

const bodies = new Map();  // body key (pipeline step, or 'dyn:<agent>' for a dynamic planet) -> body object
const dynamic = createDynamicRegistry(MAX_DYNAMIC_PLANETS); // dynamic planets in arrival order (stellar/dynamic.js)
// Label iteration order (depth ties in the fade are broken by id, see labelTargetOpacity)
const LABEL_ORDER = ['router', 'user', 'pm', 'appdev', 'qa', 'study', 'portfolio'];
const labelState = new Map();      // step -> displayed label opacity 0..1, eased toward its target (labelOpacityStep)
let labelTargetState = null;       // step -> last target opacity (hysteresis of the fade), null until the first frame
// Hover state (stellar/hover.js): hover.step = planet under the pointer (its label shows the detail), or null;
// hover.pointer = latest pointer position waiting for the hover pick. pointermove only stores it; frame() runs the
// pick once per frame, so a burst of pointer events (120 Hz pointers) costs one raycast, not one per event.
const hover = createHoverState();
const comets = [];         // comet pool (createCometSlot), at most MAX_COMETS slots
let blackHole = null;      // black hole object (createBlackHole), set in buildScene
let fx = null;             // activity effects (stellar/effects.js): beam and burst pools, set in buildScene
let activity = null;       // running tool calls per actor (stellar/activity.js), set in buildScene
let backdrop = null;       // stellar/backdrop.js: sky, star layers, dust
let sunShock = { start: -1e9 }; // sim time of the last dispatch from the sun (shock ring)
let store = null;          // per-agent state for the HUD (stellar/store.js)
let hud = null;            // planet HUD (stellar/hud.js), null when index.html has no #planet-hud
let focusStep = null;      // focused planet step ('appdev', ...) or null
let flight = null;         // camera fly-to in progress: { from: Vector3, start: sim time, duration } or null
const pickRay = new THREE.Raycaster();   // click picking on the planet surfaces
const pickNdc = new THREE.Vector2();
const scaleU = { value: 1 };             // device px per world unit (shared with the backdrop and the comet tails)
const scaleUniforms = [scaleU];          // every uScale uniform (set on resize, device px per world unit)
const particleSets = [];   // { geo, count } for every particle geometry (quality scales the drawn count)
const devicePx = { value: 1 }; // shared uniform: renderer pixel ratio (star and dust sizes)
const sim = { time: 0 };   // simulated seconds (scaled by TIME_SCALE)
const cam = {
  yawUser: 0,              // drag offsets (radians)
  pitchUser: 0,
  yaw: 0,                  // yaw used this frame (drives the star-layer parallax)
  zoom: 0.9,               // user zoom as a ratio of fitDist (1 = the fitted view; 0.9 = the start view, a little closer)
  dist: 18.5,
  distTarget: 18.5,
  dragging: false,
  lastX: 0,
  lastY: 0,
  downX: 0,                // pointer position at the press (click vs drag, see handleClick)
  downY: 0,
};
let running = false;
let rafId = 0;
let lastFrame = 0;
let qualityLevel = AUTO_START_LEVEL;   // index into QUALITY_PRESETS (current level)
let qualityAuto = true;                // true when QUALITY_LEVEL is 'auto' (governor on)
const governor = {
  windowStart: 0,     // performance time when the current measuring window started
  frames: 0,          // frames counted in the current window
  stableWindows: 0,   // consecutive stable windows
  settleUntil: 0,     // ignore frames before this time (after a level change)
  capLevel: -1,       // level that was too heavy (last step down came from it)
  capUntil: 0,        // time until which capLevel is not retried
};
const tmpV = new THREE.Vector3();      // scratch: projection and positions
const tmpA = new THREE.Vector3();      // scratch: comet start position
const tmpB = new THREE.Vector3();      // scratch: comet end position
const tmpDir = new THREE.Vector3();    // scratch: comet direction
const tmpLook = new THREE.Vector3();   // scratch: fitted look-at point (updateCamera)
const tmpFly = new THREE.Vector3();    // scratch: fly-to interpolation
const tmpTint = new THREE.Color();     // scratch: planet halo tint target
let contextLost = false;               // set when the WebGL context is lost (no restart)

/* ---------- world objects ---------- */

/** Wrap a built body (createSun / createPlanet / createBeacon) into the body record used by the update code. */
function makeBody(step, built, extra) {
  return {
    ...built,                        // group, radius, halo, uniform sets, plus the sun's or planet's own meshes
    step,
    kind: extra.kind,                 // 'sun' | 'beacon' | 'planet'
    radius: built.radius,
    group: built.group,
    surface: built.surface || null,   // planets and the beacon have a surface (spins, picked by clicks)
    halo: built.halo,
    haloMat: built.haloMat,
    haloBase: extra.haloBase,
    aura: built.aura || null,
    auraMat: built.auraMat || null,
    energy: built.energy || null,
    energyU: built.energyU || null,
    ringScale: built.ringScale || 1,
    uniformSets: built.uniformSets,
    orbit: extra.orbit || null,       // { angle, speed, radius } for planets
    home: extra.home || null,         // fixed position (beacon)
    status: 'IDLE',
    state: 'idle',                    // 'idle' | 'active'
    error: false,
    errorAmt: 0,                      // eased 0..1 red tint
    flashUntil: 0,
    level: IDLE_LEVEL,
    impact: 0,                        // short boost when a comet arrives
    spin: planetLook('idle').spin,    // eased spin (radians per simulated second)
    tint: new THREE.Color(TINT_IDLE_HEX),
    energyAmt: 0,                     // eased energy ring opacity 0..1
    ringGrow: 0,                      // eased extra ring radius (body radii), grows with open tasks
    openTasks: 0,                     // running tasks of this agent (store.js instanceState), set by refreshPlanet
    tracking: false,                  // planets: true once a live event (or, for dynamic planets, any event) was seen: status/moons follow the store
    moons: new Map(),                 // moon id (task id) -> { mesh, scale, target, offset, slot }, see syncMoons
    moonPivot: null,                  // THREE.Group (tilted circle) that holds the moons; child of the planet group
    moonRing: null,                   // faint line along the moon circle
    moonMat: null,                    // moon material (planet colour)
    moonSpin: 0,                      // common orbit angle of the moons (radians)
    thinking: false,                  // planets: a live instance is thinking (activity.js): the halo pulses
    pulseAmt: 0,                      // eased 0..1 strength of the thinking pulse
    pulseOffset: (hashName(step) % 1000) / 1000 * PULSE_PERIOD,   // per-body phase, so the planets do not beat in sync
    moreEl: null,                     // "+N" chip in the label
    jitterAmt: 0,
    node: null,                       // HTML label, bound in buildScene
    info: null,
  };
}

/** Backdrop: sky, star layers and dust (stellar/backdrop.js). Shared uniforms keep resize and quality in sync. */
function buildBackdrop() {
  backdrop = createBackdrop({ register: registerParticles, scaleU, pixelU: devicePx });
  world.add(backdrop.group);
}

/**
 * Sun, beacon, five planets, orbit lines, black hole and the comet pool.
 * The orbit lines are drawn in each planet's colour, so every lane is readable.
 */
function buildBodies() {
  // Sun = เลขาคนสวย (router), at the origin
  const sunBuilt = createSun({ radius: SUN_RADIUS, coronaScale: SUN_CORONA_SCALE });
  world.add(sunBuilt.group);
  bodies.set(SUN_STEP, makeBody(SUN_STEP, sunBuilt, { kind: 'sun', haloBase: 9 }));

  // User Prompt = the owner: a large star outside the agent system (OWNER_POSITION), not above the sun
  const beaconBuilt = createBeacon({ radius: OWNER_RADIUS });
  beaconBuilt.group.position.copy(OWNER_HOME);
  world.add(beaconBuilt.group);
  bodies.set('user', makeBody('user', beaconBuilt, { kind: 'beacon', home: OWNER_HOME, haloBase: 4.5 }));

  // Five planets: one surface type each, one orbit each
  Object.keys(SATELLITE_CONFIG).forEach((step) => {
    const cfg = SATELLITE_CONFIG[step];
    const theme = PLANET_THEME[step];
    const built = createPlanet({
      radius: BODY_RADIUS,
      type: theme.type,
      colors: { c0: theme.c0, c1: theme.c1, c2: theme.c2, atmo: theme.atmo },
      ringScale: theme.ringScale,
    });
    world.add(built.group);
    built.surface.userData.step = step;   // read by the click picking (handleClick)
    const orbit = { angle: cfg.angle, speed: cfg.speed, radius: SATELLITE_ORBIT_RADIUS[step] };
    satellitePosition(orbit, 0, built.group.position);
    const planet = makeBody(step, built, { kind: 'planet', orbit, haloBase: 4.5 });
    bodies.set(step, planet);
    attachMoonRig(planet, theme.atmo);
    // Orbit lane in the planet colour
    world.add(ringLine(SATELLITE_ORBIT_RADIUS[step], cfg.color, 0.34));
  });

  // Black hole (failed tasks are pulled in): upper right, always visible
  blackHole = createBlackHole({ horizon: BLACK_HOLE_HORIZON, innerR: BLACK_HOLE_DISK_INNER, outerR: BLACK_HOLE_DISK_OUTER });
  blackHole.group.position.copy(BLACK_HOLE_HOME);
  blackHole.flash = 0;     // 0..1 pulse after a debris comet arrives
  blackHole.pulling = 0;   // 0..1 eased: debris is falling in
  world.add(blackHole.group);

  // Comet pool: each slot has a head sprite and a tail of BEAM_PARTICLES points
  for (let i = 0; i < MAX_COMETS; i++) {
    const slot = createCometSlot({ samples: BEAM_PARTICLES, tailSize: TAIL_POINT_SIZE, scaleU });
    world.add(slot.head);
    world.add(slot.tail);
    registerParticles(slot.geo, BEAM_PARTICLES);
    comets.push({
      active: false,
      kind: 'dispatch',          // 'dispatch' | 'result' | 'failure'
      from: null,                // start body step
      to: null,                  // target body step, or BLACK_HOLE_STEP
      start: 0,                  // sim time of launch
      duration: 1,
      lift: 0,
      pull: false,               // true for failure: accelerates into the black hole
      color: new THREE.Color(),
      A: new THREE.Vector3(),    // path start (surface of the start body)
      B: new THREE.Vector3(),    // path end (surface of the target body or the black hole)
      P: new THREE.Vector3(),    // head position this frame
      samples: Array.from({ length: BEAM_PARTICLES }, () => ({ s: 0, alpha: 0 })),
      ...slot,
    });
  }
}

/**
 * Start one comet from body `from` to body `to` (or to BLACK_HOLE_STEP). Uses a free slot, or recycles the oldest one.
 * kind: 'dispatch' (target colour), 'result' (pale yellow) or 'failure' (red, pulled in).
 */
function launchComet(kind, from, to) {
  if (comets.length === 0 || !bodies.has(from)) return;
  let slot = comets.find((c) => !c.active);
  if (!slot) slot = comets.reduce((oldest, c) => (c.start < oldest.start ? c : oldest), comets[0]);
  const hex = kind === 'failure' ? ERROR_COLOR_HEX : (kind === 'result' ? RESULT_COLOR : colorOf(to));
  slot.active = true;
  slot.kind = kind;
  slot.from = from;
  slot.to = to;
  slot.start = sim.time;
  slot.duration = COMET_SECONDS[kind];
  slot.lift = COMET_LIFT[kind];
  slot.pull = kind === 'failure';
  slot.color.setHex(hex);
  slot.tailU.uColor.value.copy(slot.color);
  // Head: mostly white-hot, tinted by the comet colour, over-bright for the bloom
  slot.headMat.color.setHex(0xffffff).lerp(slot.color, 0.5).multiplyScalar(COMET_HEAD_GAIN);
}

/** Path endpoints of a comet: on the surface of the start body and of the target (or the black hole edge). */
function cometEndpoints(c) {
  const fromBody = bodies.get(c.from);
  fromBody.group.getWorldPosition(tmpA);
  let toRadius;
  if (c.to === BLACK_HOLE_STEP) {
    tmpB.copy(blackHole.group.position);
    toRadius = BLACK_HOLE_HORIZON * 1.1;
  } else {
    const toBody = bodies.get(c.to);
    toBody.group.getWorldPosition(tmpB);
    toRadius = toBody.radius * 1.05;
  }
  tmpDir.subVectors(tmpB, tmpA);
  const len = Math.max(0.001, tmpDir.length());
  tmpDir.divideScalar(len);
  c.A.copy(tmpA).addScaledVector(tmpDir, fromBody.radius * 1.05);
  c.B.copy(tmpB).addScaledVector(tmpDir, -toRadius);
}

/** Comet arrival: the receiving body flares, the sun flares for a result, the black hole pulses for debris. */
function cometArrived(c) {
  if (c.kind === 'dispatch') {
    bodies.get(c.to).impact = 1;
  } else if (c.kind === 'result') {
    const sun = bodies.get(SUN_STEP);
    sun.impact = Math.max(sun.impact, SUN_FLARE_RESULT);
  } else if (c.kind === 'failure' && blackHole) {
    blackHole.flash = 1;
  }
}

/* ---------- moons: one per concurrent instance of an agent (stellar/moons.js) ---------- */

const MOON_GEOMETRY = new THREE.SphereGeometry(MOON_RADIUS, 16, 12);   // shared by every moon
let moonTipEl = null;      // hover tip of a moon (HTML, created in buildScene)
let moonTipText = '';      // text currently written in the tip (written only when it changes)
let moonPointer = null;    // last pointer position over the canvas ({ clientX, clientY }), or null
let moonHover = null;      // moon under the pointer: { body, id, sx, sy } or null
let moonClock = 0;         // real seconds since the last store read of all planets

/**
 * Give a planet its moon rig: a tilted pivot group (child of the planet group, so it follows the orbit), a faint circle
 * along the moon orbit and the moon material in the planet colour. Nothing is drawn until a moon exists.
 */
function attachMoonRig(body, atmoHex) {
  const pivot = new THREE.Group();
  pivot.rotation.x = MOON_ORBIT_TILT;
  pivot.visible = false;
  body.group.add(pivot);
  const color = new THREE.Color(atmoHex).lerp(new THREE.Color(0xffffff), MOON_LIGHTEN).multiplyScalar(1.25);
  body.moonMat = new THREE.MeshBasicMaterial({ color });
  const ring = ringLine(MOON_ORBIT_RADIUS, atmoHex, 0.2);
  pivot.add(ring);
  body.moonPivot = pivot;
  body.moonRing = ring;
  attachMoreChip(body);
}

/** Add the "+N" chip to the planet label (hidden while empty, see style.css .node-more). No label yet = no chip. */
function attachMoreChip(body) {
  if (body.moreEl || !body.info) return;
  const chip = document.createElement('span');
  chip.className = 'node-more';
  body.info.appendChild(chip);
  body.moreEl = chip;
}

/**
 * Make the drawn moons match the live instances of a planet. view = { shown, extra } from the store (moons.js moonView):
 * `shown` are the oldest MAX_MOONS live instances. A moon whose instance is gone shrinks out, a new instance grows a
 * moon in place. The "+N" chip counts the instances beyond MAX_MOONS.
 */
function syncMoons(body, view) {
  if (!body.moonPivot) return;
  const ids = new Set(view.shown.map((t) => t.id));
  body.moons.forEach((m, id) => { if (!ids.has(id)) m.target = 0; });
  view.shown.forEach((task, i) => {
    const slot = moonAngle(i, view.shown.length);
    let moon = body.moons.get(task.id);
    if (!moon) {
      const mesh = new THREE.Mesh(MOON_GEOMETRY, body.moonMat);
      mesh.scale.setScalar(0.001);
      body.moonPivot.add(mesh);
      moon = { mesh, scale: 0, target: 1, offset: slot, slot, thinking: false, pulse: 0 };
      body.moons.set(task.id, moon);
    }
    moon.target = 1;
    moon.slot = slot;
  });
  if (body.moreEl) {
    const text = view.extra > 0 ? `+${view.extra}` : '';
    if (body.moreEl.textContent !== text) body.moreEl.textContent = text;
  }
}

/** Remove every moon of a planet at once (reset). */
function clearMoons(body) {
  body.moons.forEach((m) => { if (body.moonPivot) body.moonPivot.remove(m.mesh); });
  body.moons.clear();
  if (body.moonPivot) body.moonPivot.visible = false;
  if (body.moreEl) body.moreEl.textContent = '';
}

/** Shortest signed angle (radians) from a to b. */
function angleDelta(a, b) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/** Per-frame moons of one planet: common orbit angle, even spacing, grow in / shrink out, removal of finished moons. */
function updateMoons(b, dt) {
  if (!b.moonPivot) return;
  if (b.moons.size === 0) {
    b.moonPivot.visible = false;
    return;
  }
  b.moonPivot.visible = true;
  b.moonSpin += MOON_SPEED * dt;
  const grow = Math.min(1, dt * MOON_GROW_EASE);
  const ease = Math.min(1, dt * MOON_SLOT_EASE);
  let alive = false;
  b.moons.forEach((m, id) => {
    m.scale += (m.target - m.scale) * grow;
    m.offset += angleDelta(m.offset, m.slot) * ease;
    if (m.target === 0 && m.scale < 0.03) {          // finished: gone
      b.moonPivot.remove(m.mesh);
      b.moons.delete(id);
      return;
    }
    if (m.target === 1) alive = true;
    moonPosition(b.moonSpin + m.offset, m.mesh.position);
    m.mesh.scale.setScalar(Math.max(m.scale, 0.001));
  });
  b.moonRing.visible = alive;
}

/**
 * Re-read one planet from the store: running-task count (energy ring), derived status and moons.
 * ev = the event that was just ingested for this planet (its COMPLETED flash and dynamic label message), or null for the
 * periodic read, which only follows changes that need no event (timeouts).
 * A registered planet follows the store only after a live event (`tracking`): history alone does not paint it, as before.
 */
function refreshPlanet(b, ev) {
  const agent = agentOfBodyKey(b.step);
  if (!agent || !store) return;
  const inst = store.instanceState(agent, Date.now());
  b.openTasks = inst.running;
  if (!b.tracking) return;
  if (ev || inst.status !== b.status) {
    setBodyStatus(b.step, inst.status);
    if (b.badgeEl) showDynamicStatus(b, inst.status, ev ? ev.message : b.msgEl.textContent);
  }
  syncMoons(b, inst.moons);
}

/** Re-read every planet (after an event, which may close a task of another agent by id; and on the periodic timer). */
function refreshPlanets(ev, evBodyKey) {
  bodies.forEach((b, key) => {
    if (b.kind === 'planet') refreshPlanet(b, key === evBodyKey ? ev : null);
  });
}

/**
 * The moon under a pointer: the nearest moon centre within MOON_PICK_PX (or its on-screen radius) of the pointer, or null.
 * Projection-based (not a ray cast), so a small moon is easy to hit. Dying moons (shrinking out) are skipped.
 */
function pickMoon(pointer) {
  const rect = renderer.domElement.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const px = pointer.clientX - rect.left;
  const py = pointer.clientY - rect.top;
  const halfH = rect.height / 2;
  let best = null;
  bodies.forEach((b) => {
    b.moons.forEach((m, id) => {
      if (m.target !== 1 || m.scale < 0.5) return;
      m.mesh.getWorldPosition(tmpV);
      const dist = tmpV.distanceTo(camera.position);
      const unit = halfH / (dist * Math.tan(FOV_RAD / 2));       // CSS px per world unit at this depth
      tmpV.project(camera);
      if (tmpV.z >= 1) return;
      const sx = (tmpV.x * 0.5 + 0.5) * rect.width;
      const sy = (-tmpV.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - px, sy - py);
      if (d <= Math.max(MOON_PICK_PX, MOON_RADIUS * unit * 1.5) && (!best || d < best.d)) best = { body: b, id, sx, sy, d };
    });
  });
  return best;
}

/** Show, move or hide the hover tip of a moon. The text is what that instance is doing (its task text) and its age. */
function updateMoonTip() {
  if (!moonTipEl) return;
  let text = '';
  if (moonHover && store) {
    const agent = agentOfBodyKey(moonHover.body.step);
    const task = store.instanceState(agent, Date.now()).live.find((t) => t.id === moonHover.id);
    if (task) text = moonTip(task);
  }
  if (!text) {
    moonTipEl.classList.remove('is-visible');
    return;
  }
  if (text !== moonTipText) {
    moonTipEl.textContent = text;     // textContent only: the task text comes from the event stream
    moonTipText = text;
  }
  moonTipEl.style.transform = `translate(${Math.round(moonHover.sx + 14)}px, ${Math.round(moonHover.sy + 14)}px)`;
  moonTipEl.classList.add('is-visible');
}

/* ---------- activity effects: thinking pulse, tool beams, finish bursts (stellar/activity.js, stellar/effects.js) ---------- */

/**
 * Body key of an agent for the effects: the registered step or the dynamic planet that already exists. Never creates a planet:
 * a tool call alone does not make a new planet (its dispatch event does). null when the agent has no body.
 */
function effectBodyKey(agent) {
  const key = AGENT_STEP[agent] || dynamicKeyOf(agent);
  return key && bodies.has(key) ? key : null;
}

/**
 * Update the thinking state of a planet and of its moons from the live instances (store.js) and the running tool calls
 * (activity.js). Called after an event and twice a second (frame), so it needs no per-frame work.
 *   planet  thinking when a live instance is not running a tool: the halo pulses (updateBody)
 *   moon    each moon takes the state of its own instance (pulseMoons)
 * Only planets that follow the store (`tracking`: a live event was seen) pulse, like their status and moons.
 */
function refreshActivity(b) {
  const agent = agentOfBodyKey(b.step);
  if (b.kind !== 'planet' || !agent || !store || !activity) return;
  if (!b.tracking) {
    b.thinking = false;
    return;
  }
  const now = Date.now();
  const live = store.instanceState(agent, now).live.map((t) => t.id);
  b.thinking = activity.agentActivity(agent, live, now).thinking > 0;
  b.moons.forEach((m, id) => {
    m.thinking = m.target === 1 && activity.instanceActivity(agent, id, now).state === 'thinking';
  });
}

/** refreshActivity for every planet. */
function refreshActivityAll() {
  bodies.forEach((b) => refreshActivity(b));
}

/**
 * Per frame: ease the thinking pulse of each moon and apply it on top of the size updateMoons set this frame
 * (updateMoons writes the scale from scratch every frame, so nothing accumulates). Reduced motion: a static size bump.
 */
function pulseMoons(b, dt) {
  if (b.moons.size === 0) return;
  const k = Math.min(1, dt * PULSE_EASE);
  const beat = REDUCED_MOTION ? PULSE_STATIC : heartbeat(sim.time + b.pulseOffset, PULSE_PERIOD);
  b.moons.forEach((m) => {
    m.pulse += ((m.thinking ? 1 : 0) - m.pulse) * k;
    if (m.pulse > 0.001) m.mesh.scale.multiplyScalar(1 + PULSE_MOON_SCALE * m.pulse * beat);
  });
}

/**
 * Anchor of an effect for a planet and an optional instance: the moon of that instance when it is drawn (grown in, not shrinking
 * out), otherwise the planet itself. Returns { anchor, shape } with shape = the BEAM_* / BURST_* family ('moon' | 'body').
 */
function effectAnchor(body, instanceId) {
  const moon = instanceId ? body.moons.get(instanceId) : null;
  if (moon && moon.target === 1 && moon.scale > 0.4) return { anchor: moon.mesh, moonShape: true };
  return { anchor: body.group, moonShape: false };
}

/** One tool call started: draw its beam. act is the tracker's beam descriptor { agent, instance, color, seq }. */
function spawnBeam(beam) {
  const key = effectBodyKey(beam.agent);
  if (!key || !fx) return;
  const body = bodies.get(key);
  if (body.kind === 'sun') {
    fx.beam(body.group, BEAM_SUN.radius, BEAM_SUN.length * (beam.failed ? FAILURE_BEAM_LENGTH : 1), beam.color, beam.seq);
    return;
  }
  if (body.kind !== 'planet') return;
  const { anchor, moonShape } = effectAnchor(body, beam.instance);
  const shape = moonShape ? BEAM_MOON : BEAM_PLANET;
  // A failed tool call (red) reaches a bit further than a normal beam, so it reads as a flash of failure
  fx.beam(anchor, shape.radius, shape.length * (beam.failed ? FAILURE_BEAM_LENGTH : 1), beam.color, beam.seq);
}

/** A task finished: a green (COMPLETED) or red (ERROR) burst on its moon when it has one, otherwise on its planet. */
function spawnBurst(burst) {
  const key = effectBodyKey(burst.agent);
  if (!key || !fx) return;
  const body = bodies.get(key);
  if (body.kind !== 'planet') return;                       // the sun and the owner star draw no burst
  // The moon of the closed instance may already be shrinking out (the store closed the task first): it still marks the place
  const moon = burst.id ? body.moons.get(burst.id) : null;
  if (moon && moon.scale > 0.2) fx.burst(moon.mesh, BURST_MOON.radius, BURST_MOON.max, burst.color);
  else fx.burst(body.group, BURST_PLANET.radius, BURST_PLANET.max, burst.color);
}

/**
 * Event 'workspace:activity' (app.js forwards the SSE channel "activity"): one tool call started, ended or failed.
 * Start: track the call and draw its beam. End: only the state changes (the planet is thinking again).
 * Error (an ordinary tool failed): the same, plus one red beam from that actor. No planet status, no black hole.
 */
function onActivity(e) {
  const act = e && e.detail && e.detail.activity;
  if (!activity || !isActivity(act)) return;
  const res = activity.ingest(act, Date.now());
  const key = effectBodyKey(act.agent);
  const body = key ? bodies.get(key) : null;
  // A tool call is a live event of its agent: the planet follows the store from now on (same rule as for a live workspace event)
  if (body && body.kind === 'planet') {
    body.tracking = true;
    refreshPlanet(body, null);       // status and moons from the store, now that the planet follows it
    refreshActivity(body);
  }
  if (res.beam) spawnBeam(res.beam);
}

/**
 * Second listener of 'workspace:event' (registered right after onWorkspaceEvent, so the store has the event already):
 * the effects that depend on the task this event closed, and the thinking state after any event.
 *   - the closed task: its running tool calls are forgotten; a LIVE close (never the replay) draws a burst:
 *     green for COMPLETED, red for ERROR, on the moon of that instance when it has one, otherwise on the planet
 *   - an instance that started or ended changes which planets are thinking
 */
function onEventEffects(e) {
  const detail = e && e.detail;
  if (!detail || !detail.event || !store || !activity) return;
  const closed = store.takeClose();
  if (closed) {
    activity.release(closed.agent, closed.id);
    if (!detail.replay) {
      const burst = burstFor(closed);
      if (burst) spawnBurst(burst);
    }
  }
  refreshActivityAll();
}

/* ---------- dynamic planets (agents that are not registered) ---------- */
// Created on the first event of an agent that has no registered planet (see ensureDynamicPlanet). Same body record,
// status, comets and HUD as the registered planets. The look comes from the agent name (stellar/dynamic.js), the orbit
// from dynamicOrbitRadius (ORBIT_LAYOUT block). The label is built in code with the same .node markup as index.html.
// Nothing is removed while the page is open. Beyond MAX_DYNAMIC_PLANETS an agent has no planet (see ensureDynamicPlanet).

// Energy ring of a dynamic planet, in body radii. (1.5 + 0.84) x BODY_RADIUS stays inside DYNAMIC_EXTENT (ORBIT_LAYOUT block).
const DYNAMIC_RING_SCALE = 1.5;
// Badge class per status (the same mapping as app.js STATUS_CLASS, so the dynamic label looks like the registered ones)
const BADGE_CLASS = { COMPLETED: 's-done', PROCESSING: 's-working', WORKING: 's-working', ERROR: 's-error' };

/** Orbits the camera fit must keep in the frame: the registered ones plus one per dynamic planet that exists. */
function activeFitOrbits() {
  const orbits = REGISTERED_FIT_ORBITS.slice();
  dynamic.keys().forEach((key) => {
    orbits.push({ radius: dynamicOrbitRadius(dynamic.get(key).index), extent: DYNAMIC_EXTENT });
  });
  return orbits;
}

/**
 * Refit the camera after a dynamic planet was added: the fit points, the cached solve and the fitted distance are updated,
 * so the whole orbit system (including the new ring) stays in the frame. The same distance rule as resize().
 */
function refitCamera() {
  setFitOrbits(activeFitOrbits());
  camFit.invalidate();
  if (!stageSized) return;          // no real stage size yet: resize() fits the new points on the first real size
  fitDist = fitDistance(viewW / viewH);
  cam.distTarget = baseDist() * clamp(cam.zoom, ZOOM_MIN_FACTOR, ZOOM_MAX_FACTOR);
}

/**
 * Build the HTML label of a dynamic planet: the same .node structure as the registered labels in index.html.
 * Text is set with textContent only (agent names come from the event stream).
 * Returns { node, info, badge, msg }.
 */
function createDynamicLabel(key, agent, look) {
  const node = document.createElement('div');
  node.className = 'node';
  node.dataset.step = key;
  node.dataset.status = 'IDLE';
  const info = document.createElement('div');
  info.className = 'node-info';
  const name = document.createElement('span');
  name.className = 'node-name';
  name.textContent = withModel(agent, agent);   // model suffix when /api/agents knows this agent
  name.style.color = cssHex(look.atmo);       // the chip colour comes from the planet, like the registered labels
  // Compact 3D label: "Model-Effort" (style.css hides .node-name until hover / focus). No suffix known (no agent file,
  // /api/agents failed): the member's display name instead, so the chip is never empty. applyModels() switches it later.
  const model = document.createElement('span');
  model.className = 'node-model';
  model.textContent = chipTextOf(agent, agent);
  model.style.color = cssHex(look.atmo);
  const detail = document.createElement('span');
  detail.className = 'node-detail';
  detail.textContent = 'auto-added';
  const badge = document.createElement('span');
  badge.className = 'badge s-idle';
  badge.dataset.badge = '';
  badge.dataset.kind = 'badge';
  badge.textContent = 'IDLE';
  const msg = document.createElement('div');
  msg.className = 'node-msg';
  msg.dataset.msg = '';
  info.append(name, model, detail, badge, msg);
  node.appendChild(info);
  return { node, info, badge, msg };
}

/** Build one dynamic planet (surface, orbit lane, HTML label) from its registry entry and add it to the scene. */
function buildDynamicPlanet(entry) {
  const { look } = entry;
  const built = createPlanet({
    radius: BODY_RADIUS,
    type: look.surface,
    colors: { c0: look.c0, c1: look.c1, c2: look.c2, atmo: look.atmo },
    ringScale: DYNAMIC_RING_SCALE,
  });
  world.add(built.group);
  built.surface.userData.step = entry.key;   // read by the click picking (pickPlanetStep)
  const orbit = { angle: look.angle, speed: look.speed, radius: dynamicOrbitRadius(entry.index) };
  satellitePosition(orbit, 0, built.group.position);
  const body = makeBody(entry.key, built, { kind: 'planet', orbit, haloBase: 4.5 });
  bodies.set(entry.key, body);
  body.tracking = true;   // a dynamic planet is created by its first event (live or history) and follows the store from then on
  attachMoonRig(body, look.atmo);
  world.add(ringLine(orbit.radius, look.color, 0.34));   // orbit lane in the planet's colour

  const label = createDynamicLabel(entry.key, entry.agent, look);
  if (layer) layer.appendChild(label.node);
  body.node = label.node;
  body.info = label.info;
  body.badgeEl = label.badge;   // status badge and message box of the label (see showDynamicStatus)
  body.msgEl = label.msg;
  attachMoreChip(body);         // the "+N" chip of the moons (after the label exists)
}

/**
 * The body key of an agent's dynamic planet, creating the planet on the first event of that agent.
 * Returns null when the agent has no dynamic planet: it has a registered planet, or the cap (MAX_DYNAMIC_PLANETS) is full.
 * Beyond the cap, the agent gets NO planet and no comets. Its events still reach the log (app.js) and the HUD store.
 * The first refusal of each agent is written once to the console, so the owner can see why a planet is missing.
 */
function ensureDynamicPlanet(agent) {
  const res = dynamic.add(agent);
  if (res.status === 'added') {
    buildDynamicPlanet(dynamic.get(res.key));
    refitCamera();
    return res.key;
  }
  if (res.status === 'exists') return res.key;
  if (res.status === 'full' && res.first) {
    console.info(`[scene] ${agent}: no planet, the dynamic planet limit (${dynamic.max}) is reached`);
  }
  return null;
}

/** Show a status and message on a dynamic planet's label (badge, state and message box), like app.js does for registered nodes. */
function showDynamicStatus(body, status, message) {
  if (!body.node || !body.badgeEl) return;
  body.node.dataset.status = status;
  body.badgeEl.textContent = status;
  body.badgeEl.className = `badge ${BADGE_CLASS[status] || 's-idle'}`;
  const text = String(message || '');
  body.msgEl.textContent = text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/* ---------- per-frame updates ---------- */

/**
 * Ease one body: glow, halo, aura, and (planets) the look of its mood: spin, energy ring, jitter and halo tint.
 * The sun and the beacon use the glow and halo only.
 */
function updateBody(b, dt) {
  const flashing = sim.time < b.flashUntil;
  const mood = statusMood(b.status, flashing);

  // Target glow from the status: active = bright, flash after COMPLETED, error = red tint
  let target = IDLE_LEVEL;
  if (b.state === 'active') target = ACTIVE_LEVEL;
  else if (flashing) target = FLASH_LEVEL;
  if (b.error) target = Math.max(target, ERROR_LEVEL);
  b.level += (target - b.level) * Math.min(1, dt * 4);
  b.errorAmt += ((b.error ? 1 : 0) - b.errorAmt) * Math.min(1, dt * 6);
  b.impact = Math.max(0, b.impact - dt * 1.4);
  const glow = b.level + b.impact * 0.6;

  // Shader uniforms: every set that has the key gets it (sun, planet surface, atmosphere, energy ring)
  b.uniformSets.forEach((u) => {
    if (u.uGlow) u.uGlow.value = glow;
    if (u.uTime) u.uTime.value = sim.time;
    if (u.uError) u.uError.value = b.errorAmt;
  });

  // Halo: the sun has a wide warm halo, planets a soft pale glow that brightens when active
  // Thinking pulse (planets): the halo breathes like a heartbeat while a live instance is thinking. Reduced motion: a static glow.
  b.pulseAmt += ((b.thinking ? 1 : 0) - b.pulseAmt) * Math.min(1, dt * PULSE_EASE);
  const pulse = b.pulseAmt * (REDUCED_MOTION ? PULSE_STATIC : heartbeat(sim.time + b.pulseOffset, PULSE_PERIOD));
  b.haloMat.opacity = clamp((b.kind === 'sun' ? 0.3 + 0.3 * glow : 0.16 + 0.3 * glow) + PULSE_HALO_OPACITY * pulse, 0, 1);
  const hs = b.radius * (b.haloBase + 2.0 * glow) * (1 + PULSE_HALO_SCALE * pulse);
  b.halo.scale.set(hs, hs, 1);

  if (b.kind === 'planet' || b.kind === 'beacon') {
    // Planet look: eased toward the target of the mood (pale blue / pale yellow / red aura)
    const look = planetLook(mood);
    const k = Math.min(1, dt * LOOK_EASE);
    b.spin += (look.spin - b.spin) * k;
    b.energyAmt += (look.energy - b.energyAmt) * k;
    b.jitterAmt += (look.jitter - b.jitterAmt) * Math.min(1, dt * 6);
    tmpTint.setHex(look.tint);
    b.tint.lerp(tmpTint, k);
    b.haloMat.color.copy(b.tint);
    b.surface.rotation.y += b.spin * dt;

    // Energy ring: opacity follows the mood, radius follows the number of open tasks (store.js)
    const growTarget = ENERGY_PER_TASK * Math.min(b.openTasks, ENERGY_MAX_TASKS);
    b.ringGrow += (growTarget - b.ringGrow) * k;
    if (b.energy) {
      b.energy.scale.setScalar(b.radius * (b.ringScale + b.ringGrow));
      b.energyU.uOpacity.value = 0.85 * b.energyAmt;
      b.energy.visible = b.energyAmt > 0.01;
    }

    // Error aura: dark red, only in the error mood
    b.auraMat.opacity = 0.6 * b.errorAmt;
    const as = b.radius * (4.4 + 0.25 * Math.sin(sim.time * 5));
    b.aura.scale.set(as, as, 1);

    updateMoons(b, dt);   // planets only: the owner star has no moon rig (updateMoons returns at once)
    pulseMoons(b, dt);    // thinking pulse of the moons, applied on top of the size that updateMoons just set
  }

  // Position: planets orbit the sun, the owner star floats a little at its fixed place, the sun stays at the origin
  if (b.orbit) {
    b.orbit.angle += b.orbit.speed * dt;
    satellitePosition(b.orbit, sim.time, b.group.position);
  } else if (b.home) {
    b.group.position.set(b.home.x, b.home.y + Math.sin(sim.time * 0.9) * 0.08, b.home.z);
  }
  // Error mood: the planet shakes. Fixed sine sums (no random), so the motion is the same every run.
  if (b.surface && b.jitterAmt > 0.001) {
    const j = JITTER_AMPLITUDE * b.jitterAmt;
    b.group.position.x += j * (Math.sin(sim.time * 47) + 0.5 * Math.sin(sim.time * 83));
    b.group.position.y += j * Math.sin(sim.time * 61 + 1.3);
  }
}

/**
 * Comets: flight along the path, head and tail positions, envelope. A finished comet triggers its arrival effect.
 * Returns the number of pulled comets (debris falling into the black hole) for updateBlackHole().
 */
function updateComets() {
  let pulling = 0;
  comets.forEach((c) => {
    if (!c.active) {
      c.head.visible = false;
      c.tail.visible = false;
      return;
    }
    const elapsed = sim.time - c.start;
    // Stop when the flight is over, or when a body of the comet no longer exists
    if (elapsed >= c.duration || !bodies.has(c.from) || (c.to !== BLACK_HOLE_STEP && !bodies.has(c.to))) {
      if (elapsed >= c.duration) cometArrived(c);
      c.active = false;
      c.head.visible = false;
      c.tail.visible = false;
      return;
    }
    if (c.pull) pulling += 1;

    cometEndpoints(c);
    const s = cometProgress(elapsed, c.duration, c.pull);
    const env = cometEnvelope(elapsed, c.duration);

    // Head: shrinks while it is pulled into the black hole
    cometPoint(c.A, c.B, s, c.lift, c.P);
    const size = COMET_HEAD_SIZE * (c.pull ? 1 - 0.7 * s : 1);
    c.head.position.copy(c.P);
    c.head.scale.set(size, size, 1);
    c.headMat.opacity = env;
    c.head.visible = true;

    // Tail: samples on the path behind the head, brightness = tail alpha times the envelope
    fillTail(s, COMET_TAIL_LENGTH, c.samples);
    const pos = c.positions;
    const alphas = c.alphas;
    for (let i = 0; i < c.samples.length; i++) {
      const sm = c.samples[i];
      cometPoint(c.A, c.B, sm.s, c.lift, tmpV);
      pos[i * 3] = tmpV.x;
      pos[i * 3 + 1] = tmpV.y;
      pos[i * 3 + 2] = tmpV.z;
      alphas[i] = sm.alpha * env;
    }
    c.geo.attributes.position.needsUpdate = true;
    c.geo.attributes.aAlpha.needsUpdate = true;
    c.tail.visible = true;
  });
  return pulling;
}

/** Black hole: the disk swirls faster while debris falls in, and pulses when a comet arrives. */
function updateBlackHole(dt, pulling) {
  if (!blackHole) return;
  blackHole.flash = Math.max(0, blackHole.flash - dt * 1.6);
  blackHole.pulling = (blackHole.pulling || 0) + (((pulling > 0 ? 1 : 0) - (blackHole.pulling || 0)) * Math.min(1, dt * 3));
  blackHole.diskU.uTime.value = sim.time;
  blackHole.diskU.uPull.value = blackHole.pulling;
  blackHole.diskU.uFlash.value = blackHole.flash;
  blackHole.photonMat.opacity = clamp(0.85 + 0.15 * blackHole.flash, 0, 1);
  blackHole.lensMat.opacity = clamp(0.28 + 0.25 * blackHole.flash, 0, 1);
  blackHole.haloMat.opacity = clamp(0.28 + 0.25 * blackHole.pulling + 0.35 * blackHole.flash, 0, 1);
}

/** Sun effects: streak and flare follow the glow, and the shock ring expands after a dispatch. */
function updateSunFx() {
  const sun = bodies.get(SUN_STEP);
  const glow = sun.level + sun.impact * 0.6;
  sun.streakMat.opacity = clamp(0.18 + 0.25 * glow, 0, 1);
  sun.flareMat.opacity = clamp((sun.impact - 0.15) * 1.1, 0, 0.9);
  const p = (sim.time - sunShock.start) / SHOCK_SECONDS;
  if (p >= 0 && p < 1) {
    const e = 1 - Math.pow(1 - p, 3);            // ease out
    const s = sun.radius * (1.3 + 2.2 * e);
    sun.shock.visible = true;
    sun.shock.scale.set(s, s, 1);
    sun.shock.quaternion.copy(camera.quaternion); // the ring faces the camera
    sun.shockMat.opacity = 0.5 * (1 - p);
  } else {
    sun.shock.visible = false;
  }
}

/**
 * Camera: slow drift + user drag + eased zoom. The camera looks at viewLook, whose height is solved per pitch and
 * aspect by fitViewAtPitch() so the projected orbit system is centred vertically (see the CAMERA_FIT block).
 * A planet focus or a release starts a fly-to: the look-at point moves on an ease-in-out curve over FLIGHT_SECONDS.
 */
function updateCamera(dt) {
  const drift = REDUCED_MOTION ? 0 : 1; // no drift when the user asks for reduced motion
  const yaw = cam.yawUser + drift * Math.sin(sim.time * 0.05) * 0.22;
  cam.yaw = yaw;
  const pitchWanted = clamp(BASE_PITCH + cam.pitchUser + drift * Math.sin(sim.time * 0.07) * 0.03, CAMERA_PITCH_MIN, CAMERA_PITCH_MAX);
  cam.dist += (cam.distTarget - cam.dist) * Math.min(1, dt * 5);
  // Pitch-aware framing: the fit gives the look-at height and the distance that keep the whole orbit system inside
  // the frame at this pitch. The solve is cached (CAMERA_FIT block) and may be reused for a pitch within
  // FIT_PITCH_TOLERANCE of the wanted one, so the camera uses the pitch the solve was made for: solve and camera agree.
  const fit = camFit.solve(camera.aspect, FOV_RAD, pitchWanted);
  const pitch = fit.pitch;
  // Look-at point: the fitted base point, or the focused planet (which moves on its orbit)
  const focusBody = focusStep ? bodies.get(focusStep) : null;
  tmpLook.set(LOOK_AT.x, fit.lookY, LOOK_AT.z);
  const goal = focusBody ? focusBody.group.position : tmpLook;
  if (flight) {
    const k = clamp((sim.time - flight.start) / flight.duration, 0, 1);
    tmpFly.lerpVectors(flight.from, goal, easeInOutCubic(k));
    viewLook.copy(tmpFly);
    if (k >= 1) flight = null;
  } else {
    viewLook.lerp(goal, 1 - Math.exp(-dt * FOCUS_EASE));
  }
  // The fitted distance scale only applies to the fitted view; a focused planet uses its own distance
  const pitchScale = focusBody ? 1 : fit.distance / fitDist;
  const d = cam.dist * pitchScale;
  camera.position.set(
    viewLook.x + d * Math.cos(pitch) * Math.sin(yaw),
    viewLook.y + d * Math.sin(pitch),
    viewLook.z + d * Math.cos(pitch) * Math.cos(yaw),
  );
  camera.lookAt(viewLook);
}

/** Begin a fly-to from the current look-at point (focus, release and the reset view use it). */
function startFlight() {
  flight = { from: viewLook.clone(), start: sim.time, duration: FLIGHT_SECONDS };
}

/* ---------- labels ---------- */

// HTML labels, one frame: updateLabels() (projection, occlusion, fixed-side anchors and the fade of LABEL_LAYOUT)
// is the function after this comment.



/**
 * HTML labels, one frame: project every body, detect occlusion, place each label on its fixed side (labelRect),
 * fade the farther label of every overlap (labelTargetOpacity), then write the transforms and the opacity.
 * Labels are DOM elements above the canvas, so no planet or the sun can cover them.
 * A label is hidden only when its body is behind the camera; a body off the edge gets its label pinned to the edge.
 * A label is compact (name chip) unless its planet is hovered or focused: then it shows the detail, status and message.
 */
function updateLabels(dt) {
  if (fallbackActive) return; // list layout is shown: the label transforms must stay cleared (see FALLBACK block)
  // Pass 1: world positions of every labelled body
  const worldPos = new Map();
  bodies.forEach((b, step) => {
    b.group.getWorldPosition(tmpV);
    worldPos.set(step, { x: tmpV.x, y: tmpV.y, z: tmpV.z });
  });

  // Pass 2: projection and depth (reads only; labels are measured after the visibility writes)
  const shown = [];
  const camPos = camera.position;
  const halfH = viewH / 2;
  // Registered labels first (fixed order), then the dynamic planets in arrival order
  [...LABEL_ORDER, ...dynamic.keys()].forEach((step) => {
    const b = bodies.get(step);
    if (!b || !b.node) return;
    const wp = worldPos.get(step);
    tmpV.set(wp.x, wp.y, wp.z);
    const dist = tmpV.distanceTo(camPos);
    const pxPerUnit = halfH / (dist * Math.tan(FOV_RAD / 2)); // CSS px per world unit at this depth
    tmpV.project(camera);                                     // normalised device coordinates
    const inFront = tmpV.z < 1;
    const sx = (tmpV.x * 0.5 + 0.5) * viewW;
    const sy = (-tmpV.y * 0.5 + 0.5) * viewH;
    shown.push({ step, b, wp, inFront, sx, sy, pxPerUnit, dist });
  });

  // Occluders: the sun and every planet with its own radius (the label of a body is never its own occluder)
  const occluders = [];
  bodies.forEach((b, step) => {
    const wp = worldPos.get(step);
    occluders.push({ step, x: wp.x, y: wp.y, z: wp.z, r: b.radius });
  });

  // Visibility writes first, so a label that was hidden has a real size when it is measured
  shown.forEach((s) => { s.b.node.hidden = !s.inFront; });
  const front = shown.filter((s) => s.inFront);
  front.forEach((s) => {
    const others = occluders.filter((o) => o.step !== s.step);
    s.occluded = bodyOccluded(camPos, s.wp, s.b.radius, others);
  });

  // Labels: fixed side, anchor clamped to the view (a body off the edge pins its label to the edge)
  const view = { w: viewW, h: viewH };
  const items = front.map((s) => {
    const ax = labelClamp(s.sx, LABEL_EDGE, viewW - LABEL_EDGE);
    const ay = labelClamp(s.sy, LABEL_EDGE, viewH - LABEL_EDGE);
    // Expanded labels are taller: measure the current size (the class is set below, so use the last frame's size)
    const w = s.b.info.offsetWidth;
    const h = s.b.info.offsetHeight;
    // Gap between the body centre and the label: the body's on-screen radius plus a small offset
    const gap = s.b.radius * s.pxPerUnit + 14;
    const side = labelSideOf(s.step);
    return {
      id: s.step,
      ax,
      ay,
      rect: labelRect(side, ax, ay, w, h, gap, view),
      depth: s.dist,
      pinned: s.step === hover.step || s.step === focusStep,
    };
  });

  // Fade: the farther label of every overlap; eased toward the target so nothing flickers
  const targets = labelTargetOpacity(items, labelTargetState, LABEL_GAP_PAD);
  const next = new Map();
  items.forEach((it) => {
    const to = targets.get(it.id);
    next.set(it.id, to);
    labelState.set(it.id, labelOpacityStep(labelState.get(it.id), to, dt));
  });
  labelTargetState = next;

  // Writes: anchor, label offset, opacity, compact / expanded and occlusion markers
  const byStep = new Map(items.map((it) => [it.id, it]));
  front.forEach((s) => {
    const it = byStep.get(s.step);
    const r = it.rect;
    s.b.node.style.transform = `translate(${it.ax.toFixed(1)}px, ${it.ay.toFixed(1)}px)`;
    s.b.info.style.transform = `translate(${(r.x - it.ax).toFixed(1)}px, ${(r.y - it.ay).toFixed(1)}px)`;
    s.b.info.style.opacity = labelState.get(s.step).toFixed(3);
    s.b.node.classList.toggle('is-occluded', !!s.occluded);
    s.b.node.classList.toggle('is-expanded', it.pinned);
  });
}



/* ---------- quality: pixel ratio, presets and the adaptive governor ---------- */

// Applies a pixel ratio to the renderer and the composer, then resizes (stellar/quality.js). It skips a ratio that is
// already applied: setPixelRatio() and setSize() reset the canvas backing store even for the same value.
const pixelRatioApplier = createPixelRatioApplier((pr) => {
  renderer.setPixelRatio(pr);
  composer.setPixelRatio(pr);
  resize();
});

/**
 * Apply the current preset's pixel ratio (effectivePixelRatio: the preset cap, then its pixelScale, then the global
 * limits). Does nothing when the ratio did not change, e.g. high <-> ultra on a 1x or 1.5x screen.
 */
function applyPixelRatio() {
  if (!renderer || !composer) return;
  const preset = QUALITY_PRESETS[qualityLevel];
  pixelRatioApplier.apply(effectivePixelRatio(preset, window.devicePixelRatio));
}

/** Set a quality level: bloom, cinematic pass, particle count and pixel ratio all follow the preset. */
function applyQuality(level) {
  qualityLevel = clamp(level, 0, QUALITY_PRESETS.length - 1);
  const preset = QUALITY_PRESETS[qualityLevel];
  if (bloomPass) {
    bloomPass.enabled = preset.bloomStrength > 0;
    bloomPass.strength = preset.bloomStrength;
  }
  if (cinematicPass) cinematicPass.enabled = preset.cinematic;
  particleSets.forEach(({ geo, count }) => {
    geo.setDrawRange(0, Math.max(1, Math.floor(count * preset.particleScale)));
  });
  applyPixelRatio();
  if (container) container.dataset.quality = preset.name; // visible in the DOM for QA
}

/** Highest level the governor may reach. */
function maxQualityLevel() {
  return QUALITY_PRESETS.length - 1;
}

/**
 * True when the next level up has a different renderer pixel ratio than the applied one, so the step would resize
 * the canvas. (high -> ultra on a 2x screen: 1.5 -> 2.) The steps on a 1x or 1.5x screen do not resize.
 */
function climbChangesResize() {
  const next = QUALITY_PRESETS[qualityLevel + 1];
  if (!next) return false;
  return effectivePixelRatio(next, window.devicePixelRatio) !== pixelRatioApplier.value;
}

/** Change the level and ignore the next frames while the new level warms up. */
function changeQuality(level, now) {
  applyQuality(level);
  governor.settleUntil = now + GOVERNOR.settleSeconds * 1000;
  governor.frames = 0;
  governor.windowStart = now;
}

/**
 * Adaptive governor: called once per frame with the rAF timestamp (ms).
 * Averages FPS over GOVERNOR.windowSeconds. Below minFps, step down one level. At or above stableFps for
 * GOVERNOR.stableWindows windows in a row, step up one level (unless the level was recently too heavy).
 */
function governorTick(now) {
  if (!qualityAuto) return;
  const g = governor;
  if (now < g.settleUntil) {
    g.windowStart = now;
    g.frames = 0;
    return;
  }
  g.frames += 1;
  const elapsed = (now - g.windowStart) / 1000;
  if (elapsed < GOVERNOR.windowSeconds) return;

  const fps = g.frames / elapsed;
  g.windowStart = now;
  g.frames = 0;

  if (fps < GOVERNOR.minFps) {
    g.stableWindows = 0;
    if (qualityLevel > 0) {
      g.capLevel = qualityLevel;                              // do not climb straight back to this level
      g.capUntil = now + GOVERNOR.capSeconds * 1000;
      changeQuality(qualityLevel - 1, now);
    }
  } else if (fps >= GOVERNOR.stableFps) {
    g.stableWindows += 1;
    const canClimb = qualityLevel < maxQualityLevel()
      && (now > g.capUntil || qualityLevel + 1 < g.capLevel);
    // A step up that changes the pixel ratio costs a canvas resize: it waits for more stable windows (see GOVERNOR)
    const needed = climbChangesResize() ? GOVERNOR.resizeStableWindows : GOVERNOR.stableWindows;
    if (canClimb && g.stableWindows >= needed) {
      g.stableWindows = 0;
      changeQuality(qualityLevel + 1, now);
    }
  } else {
    g.stableWindows = 0;
  }
}

/** Resize renderer, composer and camera to the stage. */
function resize() {
  if (!renderer || !composer || !camera) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w < 2 || h < 2) return;
  viewW = w;
  viewH = h;
  renderer.setSize(w, h, false);   // canvas = CSS size x pixel ratio (full device resolution)
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  fitDist = fitDistance(w / h);
  // The target follows the fit and the user zoom ratio, so the view keeps its framing when the stage changes size
  cam.distTarget = baseDist() * clamp(cam.zoom, ZOOM_MIN_FACTOR, ZOOM_MAX_FACTOR);
  if (!stageSized) {
    cam.dist = cam.distTarget;   // first real size: no easing from the placeholder distance
    stageSized = true;
  }

  // Point sprites: world size -> device pixels (device px per unit at distance 1)
  const pxScale = renderer.domElement.height * 0.5;
  scaleUniforms.forEach((u) => { u.value = pxScale; });
  devicePx.value = renderer.getPixelRatio();
}

/**
 * Distance at which the whole orbit system (every satellite with its bob, extent and label room) fits the view
 * at the default pitch, for this aspect ratio, with the look-at height solved for that view (CAMERA_FIT block).
 * Both axes are checked. Returns the distance only (uncached: it runs on resize, not per frame).
 */
function fitDistance(aspect) {
  return fitViewAtPitch(aspect, FOV_RAD, BASE_PITCH, LOOK_AT.y, {}).distance;
}

/**
 * Apply a prefers-reduced-motion value (at start and whenever the OS setting changes).
 *   reduced: running beams and bursts stop at once and new ones are refused (fx.setReducedMotion), animations slow down
 *            (TIME_SCALE), camera drift stops, and a thinking moon / planet keeps a static glow instead of a pulse.
 *   normal:  everything above is back. REDUCED_MOTION and TIME_SCALE are read on every frame, so no restart is needed.
 */
function applyReducedMotion(reduced) {
  REDUCED_MOTION = !!reduced;
  TIME_SCALE = REDUCED_MOTION ? 0.35 : 1;
  if (fx) fx.setReducedMotion(REDUCED_MOTION);
}

/** Follow the OS setting live (matchMedia "change" event; addListener is the fallback of old Safari). */
function watchReducedMotion() {
  const onChange = (e) => applyReducedMotion(e.matches);
  if (typeof reducedMotionQuery.addEventListener === 'function') reducedMotionQuery.addEventListener('change', onChange);
  else if (typeof reducedMotionQuery.addListener === 'function') reducedMotionQuery.addListener(onChange);
}

/** Watch for a change of devicePixelRatio (window moved to another monitor, browser zoom). */
function watchDevicePixelRatio() {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  mq.addEventListener('change', () => {
    applyPixelRatio();      // effectivePixelRatio() reads the new devicePixelRatio
    watchDevicePixelRatio(); // re-arm for the next change
  }, { once: true });
}



/* ---------- render loop ---------- */

/** One frame: governor, advance the simulation, update the scene, render through the composer. */
function frame(now) {
  if (!running) return;
  rafId = requestAnimationFrame(frame);
  governorTick(now);

  const dt = clamp((now - lastFrame) / 1000, 0, 0.05);
  lastFrame = now;
  const simDt = dt * TIME_SCALE;
  sim.time += simDt;

  bodies.forEach((b) => updateBody(b, simDt));
  const pulling = updateComets();
  updateBlackHole(simDt, pulling);
  updateCamera(simDt);
  // Hover pick: at most one per frame, after the camera moved, so it tests against the camera this frame shows
  const pending = takeHoverPointer(hover);   // one pick per frame; a press or a leave already dropped it
  if (pending && !cam.dragging) hover.step = pickPlanetStep(pending);
  if (pending) moonPointer = pending;
  // Moon hover: picked every frame from the last pointer position, so the tip follows a moving moon under a still pointer
  moonHover = moonPointer && !cam.dragging ? pickMoon(moonPointer) : null;
  updateMoonTip();
  // Read the store a few times per second: a moon times out, or a planet goes idle, with no event to trigger it
  moonClock += dt;
  if (moonClock >= MOON_REFRESH_SECONDS) {
    moonClock = 0;
    refreshPlanets(null, null);
    refreshActivityAll();   // a call expires, or an instance times out, with no event
  }
  updateSunFx();
  if (fx) fx.update(sim.time, camera);   // beams and bursts (pooled; follow their anchors)
  backdrop.update(sim.time, cam.yaw, simDt);
  updateLabels(dt);
  refreshQualityLabel();
  if (cinematicPass) cinematicPass.uniforms.uTime.value = now / 1000; // grain uses real time
  composer.render();
}

function start() {
  if (running) return;
  running = true;
  lastFrame = performance.now();
  // Restart the governor window (the tab may have been hidden for a long time)
  governor.windowStart = lastFrame;
  governor.frames = 0;
  governor.stableWindows = 0;
  governor.settleUntil = lastFrame + GOVERNOR.settleSeconds * 1000;
  rafId = requestAnimationFrame(frame);
}

function stop() {
  running = false;
  cancelAnimationFrame(rafId);
}

/* ---------- public hooks (window.workspaceScene) ---------- */

/**
 * Store the status of a body: glow state, error flag and the COMPLETED flash. Used for planets by refreshPlanet (status
 * derived from the open instances) and, through setNodeStatus, for the sun and the owner star.
 */
function setBodyStatus(step, status) {
  const b = bodies.get(step);
  if (!b) return;
  const active = status === 'PROCESSING' || status === 'WORKING';
  b.status = status;
  b.state = active ? 'active' : 'idle';
  b.error = status === 'ERROR';
  b.flashUntil = status === 'COMPLETED' ? sim.time + COMPLETE_FLASH_SECONDS : 0;
}

/**
 * Public hook (app.js calls it for every event with a pipelineStep). It drives the sun and the owner star. A planet is
 * ignored here on purpose: its status is derived from its open instances in refreshPlanet, because the status of the latest
 * event is wrong when several instances of one agent run (one finishing would turn the planet idle).
 */
function setNodeStatus(step, status) {
  if (isPlanetKey(step)) return;
  setBodyStatus(step, status);
}

/**
 * Dispatch: a comet from one body to the other (app.js calls it for every PROCESSING handoff, not during the
 * replay burst). The sun flares and sends out a shock ring when it is the sender. The receiving body flares
 * when the comet arrives.
 */
function handoff(from, to) {
  if (from === to || !bodies.has(from) || !bodies.has(to)) return;
  launchComet('dispatch', from, to);
  if (from === SUN_STEP) {
    const sun = bodies.get(SUN_STEP);
    sun.impact = Math.max(sun.impact, SUN_FLARE_DISPATCH);
    sunShock.start = sim.time;
  }
}

/**
 * Event bus (app.js dispatches 'workspace:event' for every applied event and for the replayed history).
 * The HUD store takes every event. Result and failure comets are drawn only for live events (replay is false).
 */
function onWorkspaceEvent(e) {
  const detail = e && e.detail;
  if (!detail || !detail.event || !store) return;
  const ev = detail.event;
  store.ingest(ev);

  // Body of the event: a pipeline step (registered agents, sun, beacon) or, for any other agent, its dynamic planet.
  // A dynamic agent gets its planet on the first event (ensureDynamicPlanet); beyond the cap there is no body.
  const step = stepOfEvent(ev);
  const bodyKey = step || ensureDynamicPlanet(ev.agent);
  if (bodyKey && isDynamicKey(bodyKey) && bodies.has(bodyKey)) {
    const active = ev.status === 'PROCESSING' || ev.status === 'WORKING';
    // Dispatch comet from the sun, the same as app.js draws for a registered planet (not during the replay burst)
    if (active && !detail.replay) handoff(SUN_STEP, bodyKey);
  }

  // Planets (registered and dynamic): status, running-task count (energy ring) and moons come from the store. A registered
  // planet starts following it with its first live event. Every planet is re-read, since an end event with a tool_use_id can
  // close the task of another agent (a failure reported by the caller).
  const planetKey = AGENT_STEP[ev.agent] || dynamicKeyOf(ev.agent);
  if (planetKey && bodies.has(planetKey) && !detail.replay) bodies.get(planetKey).tracking = true;
  refreshPlanets(ev, planetKey);
  if (!detail.replay) {
    visualIntentsForEvent(ev).forEach((intent) => {
      if (intent.kind === 'result') launchComet('result', intent.step, SUN_STEP);
      else if (intent.kind === 'failure') launchComet('failure', intent.step, BLACK_HOLE_STEP);
    });
  }
  refreshHud();
}

/**
 * Take the model suffixes (the `agents` object of GET /api/agents, published by app.js) into stellar/model.js, then redraw
 * what shows a name here: the dynamic planet labels and the open HUD. The registered labels are written by app.js.
 */
function applyModels(agents) {
  setAgentModels(agents);
  dynamic.keys().forEach((key) => {
    const body = bodies.get(key);
    const nameEl = body && body.info ? body.info.querySelector('.node-name') : null;
    const agent = agentOfBodyKey(key);
    if (nameEl && agent) nameEl.textContent = withModel(agent, agent);
    const modelEl = body && body.info ? body.info.querySelector('.node-model') : null;
    if (modelEl && agent) modelEl.textContent = chipTextOf(agent, agent);   // compact 3D label: Model-Effort, else the name
  });
  refreshHud();
}

/** Push the store snapshot of the focused planet into the HUD (no-op when nothing is focused). */
function refreshHud() {
  if (!hud || !store || !focusStep) return;
  hud.show(store.snapshot(agentOfBodyKey(focusStep)));
}

/** Distance the camera aims for: the focus distance while a planet is focused, otherwise the fitted distance. */
function baseDist() {
  return focusStep ? FOCUS_DISTANCE : fitDist;
}

/** Focus a planet: the camera flies to it, then follows it while it orbits, and the HUD shows its state. */
function focusOn(step) {
  if (!isPlanetKey(step) || !bodies.has(step)) return;
  focusStep = step;
  cam.zoom = 1;
  cam.distTarget = FOCUS_DISTANCE;
  startFlight();
  refreshHud();
}

/** Release the focus: the camera flies back to the fitted view and the HUD closes. */
function release() {
  focusStep = null;
  cam.distTarget = fitDist * clamp(cam.zoom, ZOOM_MIN_FACTOR, ZOOM_MAX_FACTOR);
  startFlight();
  if (hud) hud.hide();
}

/**
 * The planet under a pointer event, or null (empty space, the sun, or a zero-size canvas).
 * Shared by the click (focus) and the hover (label detail) handlers.
 */
function pickPlanetStep(e) {
  const dom = renderer.domElement;
  const rect = dom.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  pickNdc.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  pickRay.setFromCamera(pickNdc, camera);
  const surfaces = [];
  bodies.forEach((b) => { if (b.kind === 'planet' && b.surface) surfaces.push(b.surface); });
  const hit = pickRay.intersectObjects(surfaces, false)[0];
  const step = hit ? hit.object.userData.step : null;
  return step && isPlanetKey(step) ? step : null;
}

/** Click handling: a click on a planet focuses it. A click on anything else releases the focus. */
function handleClick(e) {
  const dom = renderer.domElement;
  const rect = dom.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;   // no real stage size: ignore the click (keeps the focus)
  const step = pickPlanetStep(e);
  if (step) focusOn(step);
  else release();
}

/** Every body back to idle, comets off, black hole calm, HUD closed and the HUD store cleared ("ล้างหน้าจอ" and page load). */
function reset() {
  bodies.forEach((b) => {
    b.status = 'IDLE';
    b.state = 'idle';
    b.error = false;
    b.flashUntil = 0;
    b.impact = 0;
    b.openTasks = 0;
    if (b.kind === 'planet') {
      clearMoons(b);                                   // no instance survives a reset (the store is cleared below)
      b.tracking = !!b.badgeEl;                        // a registered planet waits for its next live event again
    }
    if (b.badgeEl) showDynamicStatus(b, 'IDLE', '');   // dynamic planets: clear the label badge and message too
  });
  comets.forEach((c) => { c.active = false; });
  if (activity) activity.clear();
  if (fx) fx.clear();
  bodies.forEach((b) => { b.thinking = false; b.pulseAmt = 0; });
  if (blackHole) blackHole.flash = 0;
  sunShock.start = -1e9;
  if (store) store.reset();
  release();
  refreshHud();
}

/* ---------- quality button (HUD in the stage) ---------- */

/** Cycle the quality mode: auto -> low -> medium -> high -> auto. A fixed level turns the governor off. */
function cycleQuality() {
  const order = ['auto', 0, 1, 2];
  const current = qualityAuto ? 'auto' : qualityLevel;
  const next = order[(order.indexOf(current) + 1) % order.length];
  if (next === 'auto') {
    qualityAuto = true;
    changeQuality(qualityLevel, performance.now());
  } else {
    qualityAuto = false;
    applyQuality(next);
  }
  refreshQualityLabel(true);
}

/** Write the current mode into the quality button (only when it changes). */
function refreshQualityLabel(force = false) {
  if (!qualityBtn) return;
  const preset = QUALITY_PRESETS[qualityLevel].name;
  const want = qualityAuto ? `auto · ${preset}` : preset;
  if (!force && want === shownQuality) return;
  shownQuality = want;
  qualityBtn.textContent = `Quality: ${want}`;
  qualityBtn.setAttribute('aria-label', `Render quality: ${want}. Click to change.`);
}

/* ---------- boot ---------- */

/** True when a WebGL context can be created in this browser. */
function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch (_err) {
    return false;
  }
}

// FALLBACK:BEGIN
/* ---------- fallback: the list layout (no 3D) ---------- */
// showFallback() can run after the scene was already drawing (lost WebGL context). The label transforms written
// by updateLabels() are inline styles, and inline styles beat the fallback CSS ("transform: none"), so they must
// be cleared. This block is read by test/workspace-fallback.test.js (it runs the functions in a sandbox), so keep it
// self-contained: it only uses the module variables named in the test.

let fallbackActive = false;     // true once the list layout is shown: updateLabels() must not write any more

/** Remove every inline position and fade written by updateLabels(), and the label state markers. */
function resetLabelPositions() {
  bodies.forEach((b) => {
    if (b.node) {
      b.node.style.transform = '';          // inline anchor transform (would override the fallback CSS)
      b.node.hidden = false;                // may have been hidden while its body was behind the camera
      b.node.classList.remove('is-occluded', 'is-expanded');
    }
    if (b.info) {
      b.info.style.transform = '';          // inline label offset
      b.info.style.opacity = '';            // inline fade (the list layout shows every label at full opacity)
    }
  });
  labelState.clear();                       // forget the eased label opacities
  labelTargetState = null;                  // forget the fade hysteresis
  hover.step = null;                        // no hover detail in the list layout
}

/** Show the list layout (no 3D) and tell the user why. */
function showFallback() {
  fallbackActive = true;                    // stop writing label positions from now on
  stop();                                   // no more frames (safe when the loop never started)
  resetLabelPositions();
  if (stageEl) stageEl.classList.add('no-webgl');
  if (fallbackEl) fallbackEl.hidden = false;
  window.workspaceScene = undefined;
}
// FALLBACK:END

/** Read QUALITY_LEVEL: a number fixes the level, anything else means 'auto' (governor on). */
function initialQuality() {
  if (typeof QUALITY_LEVEL === 'number' && Number.isInteger(QUALITY_LEVEL)) {
    return { auto: false, level: clamp(QUALITY_LEVEL, 0, maxQualityLevel()) };
  }
  return { auto: true, level: AUTO_START_LEVEL };
}

/**
 * Tell app.js that this module has finished booting: the 'workspace:event' listener is registered and the store
 * is ready. app.js buffers the SSE events until this event, so the replayed history is not lost.
 * active = true when the 3D scene is running, false when the list layout is shown (no store then).
 */
function announceReady(active) {
  if (typeof window.CustomEvent !== 'function' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new window.CustomEvent('workspace:scene-ready', { detail: { active } }));
}

/** Build the whole scene into #scene and bind the HTML labels from #label-layer. */
function buildScene() {
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.setClearColor(0x02030a, 1);
  renderer.toneMapping = THREE.NeutralToneMapping; // keeps the brand hues (ACES washed them out to white)
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  world = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 2000);

  // Deep-space backdrop first, then the sun, the beacon, the planets, the black hole and the comet pool
  buildBackdrop();
  buildBodies();
  // Activity effects: pooled beams and bursts (built once), and the tracker of running tool calls
  fx = createEffects({ parent: world, register: registerParticles, reducedMotion: REDUCED_MOTION });
  activity = createActivityTracker();

  // Post-processing: scene (MSAA target) -> bloom -> output (tone mapping, sRGB) -> cinematic (last)
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: MSAA_SAMPLES });
  composer = new EffectComposer(renderer, target);
  // Sky first: the dome is drawn at half resolution and upscaled into the buffer (SkyPass clears its depth)
  skyPass = new SkyPass(backdrop.skyScene, camera, { scale: SKY_SCALE });
  composer.addPass(skyPass);
  // Scene pass draws on top of the sky: no colour clear (clear = false), the sky already covers every pixel
  const scenePass = new RenderPass(world, camera);
  scenePass.clear = false;
  composer.addPass(scenePass);
  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.6, 0.8); // threshold: only the hot parts (sun, comets, black hole) bloom
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  cinematicPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uAberration: { value: 0.005 },
      uGrain: { value: 0.025 },
      uVignette: { value: 0.45 },
    },
    vertexShader: CINEMATIC_VERT,
    fragmentShader: CINEMATIC_FRAG,
  });
  composer.addPass(cinematicPass);

  // HTML labels: bind each .node[data-step] to its body
  layer.querySelectorAll('.node[data-step]').forEach((node) => {
    const body = bodies.get(node.dataset.step);
    if (!body) return;
    body.node = node;
    body.info = node.querySelector('.node-info');
    if (body.kind === 'planet') attachMoreChip(body);   // "+N" chip of the moons (registered planets; dynamic ones get it in buildDynamicPlanet)
  });

  // Hover tip of a moon (text is set with textContent only)
  moonTipEl = document.createElement('div');
  moonTipEl.className = 'moon-tip';
  layer.appendChild(moonTipEl);

  // Quality: fixed level or the adaptive governor (see QUALITY_LEVEL at the top)
  const initial = initialQuality();
  qualityAuto = initial.auto;
  applyQuality(initial.level);
  governor.settleUntil = performance.now() + GOVERNOR.settleSeconds * 1000;
  watchDevicePixelRatio();
  qualityBtn = document.getElementById('quality-toggle');
  if (qualityBtn) qualityBtn.addEventListener('click', cycleQuality);
  refreshQualityLabel(true);

  // Resize follows the stage size
  new ResizeObserver(() => resize()).observe(container);
  resize();

  // Mouse: drag to orbit, wheel to zoom (limited), double-click to reset the view
  const dom = renderer.domElement;
  dom.style.touchAction = 'none';
  // A press and a leave clear the hover (hover.step and any pending pick), see bindHoverClear in stellar/hover.js
  bindHoverClear(dom, hover);
  // The moon hover follows the same rule: a leave or a press (a drag is not a hover) drops it
  const clearMoonPointer = () => { moonPointer = null; moonHover = null; };
  dom.addEventListener('pointerleave', clearMoonPointer);
  dom.addEventListener('pointerdown', clearMoonPointer);
  dom.addEventListener('pointerdown', (e) => {
    cam.dragging = true;     // a drag is not a hover: the label detail follows the pointer again after the drag
    cam.lastX = e.clientX;
    cam.lastY = e.clientY;
    cam.downX = e.clientX;   // where the press started: a small move is a click, a bigger one a drag
    cam.downY = e.clientY;
    dom.setPointerCapture(e.pointerId);
  });
  dom.addEventListener('pointermove', (e) => {
    if (!cam.dragging) {
      // Hover (no button down): only remember the position. The pick itself runs once per frame in frame().
      setHoverPointer(hover, e.clientX, e.clientY);
      return;
    }
    cam.yawUser -= (e.clientX - cam.lastX) * 0.006;
    cam.pitchUser = clamp(cam.pitchUser - (e.clientY - cam.lastY) * 0.004, -0.25, 0.85);
    cam.lastX = e.clientX;
    cam.lastY = e.clientY;
  });
  const endDrag = () => { cam.dragging = false; };
  dom.addEventListener('pointerup', (e) => {
    const moved = Math.hypot(e.clientX - cam.downX, e.clientY - cam.downY);
    if (moved <= CLICK_MAX_MOVE) handleClick(e);   // click: focus a planet, or release on empty space
    endDrag();
  });
  dom.addEventListener('pointercancel', endDrag);
  dom.addEventListener('wheel', (e) => {
    e.preventDefault(); // zoom the scene, not the page
    cam.zoom = clamp(cam.zoom * (1 + e.deltaY * 0.001), ZOOM_MIN_FACTOR, ZOOM_MAX_FACTOR);
    cam.distTarget = baseDist() * cam.zoom;
  }, { passive: false });
  dom.addEventListener('dblclick', () => {
    cam.yawUser = 0;
    cam.pitchUser = 0;
    cam.zoom = 1;
    cam.distTarget = fitDist;
    release();   // the reset view also drops the planet focus (and flies back to the fitted view)
  });

  // Lost WebGL context: stop the loop and switch to the list layout
  dom.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    contextLost = true;
    stop();
    showFallback();
  });

  // Pause the render loop while the tab is hidden (resume when visible again, unless the context was lost)
  document.addEventListener('visibilitychange', () => {
    if (!renderer || contextLost) return;
    if (document.hidden) stop();
    else start();
  });

  // Stellar layer: per-agent store, planet HUD (markup in index.html), workspace event bus from app.js, Esc to release
  store = createStore();
  const hudEl = document.getElementById('planet-hud');
  hud = hudEl ? createHud(hudEl, { onClose: release }) : null;
  window.addEventListener('workspace:event', onWorkspaceEvent);
  window.addEventListener('workspace:event', onEventEffects);   // after onWorkspaceEvent (listeners run in order): reads the close it caused
  window.addEventListener('workspace:activity', onActivity);
  window.addEventListener('pagehide', () => { if (fx) { fx.dispose(); fx = null; } });   // free the effect pools
  watchReducedMotion();   // prefers-reduced-motion changes apply live (beams / bursts off, static glow)
  // Model labels: app.js loads GET /api/agents once. Take what is there already, then follow the 'workspace:models' event.
  applyModels(window.workspaceModels);
  window.addEventListener('workspace:models', (e) => applyModels(e.detail));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') release();
  });

  // Start with every body idle and the first frame drawn
  reset();
  start();
}

/** Entry point: start the 3D scene or fall back to the list layout. */
function boot() {
  stageEl = document.getElementById('stage');
  container = document.getElementById('scene');
  layer = document.getElementById('label-layer');
  fallbackEl = document.getElementById('webgl-fallback');
  if (!stageEl || !container || !layer) {   // markup missing: keep the list layout
    announceReady(false);
    return;
  }

  if (!webglAvailable()) {
    showFallback();
    announceReady(false);
    return;
  }
  try {
    buildScene();
  } catch (err) {
    console.error('[scene] the 3D scene could not start, showing the list view:', err);
    showFallback();
    announceReady(false);
    return;
  }
  stageEl.classList.remove('no-webgl');
  window.workspaceScene = Object.freeze({ setNodeStatus, handoff, reset });
  announceReady(true);
}

boot();

/**
 * stellar/dynamic.js - Dynamic planets: a planet for every agent that is not registered (the five team planets are
 * fixed in scene.js). Pure: no DOM, no THREE. Used by scene.js and test/stellar-dynamic.test.js.
 *
 *   dynamicLook(agent)            deterministic look of an agent: surface type, colours, start angle and speed.
 *                                 The same name always gives the same look (FNV-1a hash of the name).
 *   createDynamicRegistry(max)    the planets in arrival order, at most `max` of them (MAX_DYNAMIC_PLANETS).
 *                                 add(agent) creates the entry on the first event; agents beyond the cap are refused
 *                                 and listed in refused(). Nothing is removed while the page is open.
 *   cssHex(n)                     0xRRGGBB number -> "#rrggbb" for inline CSS.
 *
 * Orbit radius and label placement are layout rules, not data: they are in scene.js (ORBIT_LAYOUT, LABEL_LAYOUT).
 */
import { dynamicKeyOf } from './model.js';

// Cap on dynamic planets. Beyond it an agent gets no planet: its events still reach the log and the HUD store
// (scene.js does not draw it). Four rings keep the fitted camera view close to the registered system: the fit distance
// at aspect 1.0 is 95.5 with 4 dynamic planets, against 133.5 with 8 (measured with the CAMERA_FIT block, see README).
export const MAX_DYNAMIC_PLANETS = 4;

// Surface types, same numbers as SURFACE in stellar/bodies.js (CIRCUIT, BANDS, CONTINENTS, MARBLE).
// Kept here as plain numbers so this module does not import THREE. test/stellar-dynamic.test.js checks them.
export const DYNAMIC_SURFACE_TYPES = Object.freeze([0, 1, 2, 3]);

/** FNV-1a 32-bit hash of a string (over its code points). Stable across runs and browsers. */
export function hashName(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** HSL to 0xRRGGBB. h in degrees (any value), s and l in 0..1. */
export function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) { r = c; g = x; } else if (hue < 120) { r = x; g = c; } else if (hue < 180) { g = c; b = x; }
  else if (hue < 240) { g = x; b = c; } else if (hue < 300) { r = x; b = c; } else { r = c; b = x; }
  const to8 = (v) => Math.round((v + m) * 255);
  return (to8(r) << 16) | (to8(g) << 8) | to8(b);
}

/** 0xRRGGBB number to a CSS colour string "#rrggbb". */
export function cssHex(n) {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * Deterministic look of a dynamic planet, derived from the agent name only:
 *   hue      0..359 from the hash; the colours are a palette around it (dark base, mid surface, light highlight)
 *   surface  one of the four surface types, chosen by the hash
 *   color    orbit line and comet colour; atmo = rim and energy ring colour; c0, c1, c2 = surface colours
 *   angle    start angle on the orbit plane (radians, 0..2pi)
 *   speed    orbit speed (radians per simulated second): 0.070..0.100, like the registered planets
 * @param {string} agent  agent id (the name seen in the events)
 */
export function dynamicLook(agent) {
  const h = hashName(agent);
  const hue = h % 360;
  return {
    hue,
    surface: DYNAMIC_SURFACE_TYPES[(h >>> 9) % DYNAMIC_SURFACE_TYPES.length],
    color: hslToHex(hue, 0.9, 0.65),
    atmo: hslToHex(hue, 0.85, 0.6),
    c0: hslToHex(hue, 0.6, 0.12),
    c1: hslToHex(hue + 30, 0.7, 0.4),
    c2: hslToHex(hue + 180, 0.9, 0.8),
    angle: ((h >>> 12) % 6283) / 1000,
    speed: 0.07 + ((h >>> 20) % 31) / 1000,
  };
}

/**
 * Registry of the dynamic planets, in arrival order. The index of an entry is its orbit ring (0 = innermost).
 * @param {number} [max]  cap (default MAX_DYNAMIC_PLANETS)
 * @returns {{ add, get, keys, size, max, refused }}
 *   add(agent)  -> { status, key, index, first? }
 *                  status 'added'   new planet (index = its ring)
 *                         'exists'  the agent already has a planet (same key and index)
 *                         'full'    cap reached: no planet, the agent is recorded in refused(); first = true only
 *                                   the first time this agent is refused
 *                         'ignored' the agent has a registered planet, or no usable name
 *   get(key)    -> { key, agent, index, look } or undefined
 *   keys()      -> body keys in arrival order (a new array)
 *   size()      -> number of planets
 *   refused()   -> agent ids refused by the cap, in the order they first came (a new array)
 */
export function createDynamicRegistry(max = MAX_DYNAMIC_PLANETS) {
  const entries = new Map();    // key -> { key, agent, index, look }
  const refusedSet = new Set(); // agent ids refused by the cap

  function add(agent) {
    const key = dynamicKeyOf(agent);
    if (!key) return { status: 'ignored', key: null, index: -1 };
    if (entries.has(key)) {
      const e = entries.get(key);
      return { status: 'exists', key, index: e.index };
    }
    if (entries.size >= max) {
      const first = !refusedSet.has(agent);   // true once per agent: the caller logs the first refusal only
      refusedSet.add(agent);
      return { status: 'full', key, index: -1, first };
    }
    const entry = { key, agent, index: entries.size, look: dynamicLook(agent) };
    entries.set(key, entry);
    return { status: 'added', key, index: entry.index };
  }

  return {
    add,
    get: (key) => entries.get(key),
    keys: () => Array.from(entries.keys()),
    size: () => entries.size,
    max,
    refused: () => Array.from(refusedSet),
  };
}

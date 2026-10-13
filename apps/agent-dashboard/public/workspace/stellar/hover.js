/**
 * stellar/hover.js - Hover state of the Stellar Universe scene (scene.js). No THREE, no document or window.
 *
 * state.step     planet under the pointer (its label shows the detail), or null
 * state.pointer  latest pointer position ({ clientX, clientY }) waiting for the hover pick, or null
 *
 * pointermove only stores the position (setHoverPointer). scene.js frame() takes it once per frame
 * (takeHoverPointer) and runs the pick, so a burst of pointer events costs one raycast, not one per event.
 * bindHoverClear() drops the hover when the pointer leaves the canvas or a press starts (a drag is not a hover).
 */

/** New hover state: nothing pinned, nothing pending. */
export function createHoverState() {
  return { step: null, pointer: null };
}

/** pointermove without a button: remember the position for the next frame. */
export function setHoverPointer(state, clientX, clientY) {
  state.pointer = { clientX, clientY };
}

/** Take the pending pointer: returns it and clears it. Returns null when none is waiting. */
export function takeHoverPointer(state) {
  const pointer = state.pointer;
  state.pointer = null;
  return pointer;
}

/** Forget the hover: no planet is pinned and no pick is pending. */
export function clearHover(state) {
  state.step = null;
  state.pointer = null;
}

/**
 * Clear the hover on pointerleave and pointerdown of `target` (any EventTarget, the canvas in scene.js).
 * Returns a function that removes both listeners.
 */
export function bindHoverClear(target, state) {
  const clear = () => clearHover(state);
  target.addEventListener('pointerleave', clear);
  target.addEventListener('pointerdown', clear);
  return () => {
    target.removeEventListener('pointerleave', clear);
    target.removeEventListener('pointerdown', clear);
  };
}

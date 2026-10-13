'use strict';
/**
 * stellar-sky-pass.test.js - Behaviour of the half-resolution sky pass (public/workspace/stellar/sky-pass.js):
 *   - setSize() gives the sky target ceil(w * scale) x ceil(h * scale), never less than 1 px
 *   - the same size does not reallocate the target (no 'dispose' on the render target); a real change does
 *   - dispose() frees the target, the copy material and the full-screen quad
 * Three.js is imported in Node (the vendor folder has a package.json with "type": "module"). No GPU is needed:
 * WebGLRenderTarget and materials only allocate on first use in a renderer, and this test never renders.
 * Reallocation is observed through the 'dispose' event that WebGLRenderTarget.setSize() fires for a real change.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WORKSPACE_DIR = path.join(__dirname, '..', 'public', 'workspace');

/** Load the sky pass and Three.js once per test file (ES modules). */
async function load() {
  const skyPass = await import(pathToFileURL(path.join(WORKSPACE_DIR, 'stellar', 'sky-pass.js')).href);
  const THREE = await import(pathToFileURL(path.join(WORKSPACE_DIR, 'vendor', 'three', 'three.module.min.js')).href);
  return { SkyPass: skyPass.SkyPass, THREE };
}

/** Build a SkyPass with an empty sky scene and a default camera (nothing is rendered). */
async function makePass(options) {
  const { SkyPass, THREE } = await load();
  return new SkyPass(new THREE.Scene(), new THREE.PerspectiveCamera(), options);
}

/** Count the 'dispose' events fired by an object (three.js fires one when a target or material is freed). */
function countDispose(object) {
  const counter = { count: 0 };
  object.addEventListener('dispose', () => { counter.count += 1; });
  return counter;
}

test('setSize: the sky target is ceil(w * 0.5) x ceil(h * 0.5) by default', async () => {
  const pass = await makePass();
  assert.equal(pass.scale, 0.5, 'default scale is half resolution per axis');

  pass.setSize(1001, 601);
  assert.equal(pass.target.width, 501, 'odd width rounds up');
  assert.equal(pass.target.height, 301, 'odd height rounds up');
  assert.equal(pass.target.texture.image.width, 501, 'texture carries the same width');
  assert.equal(pass.target.texture.image.height, 301, 'texture carries the same height');

  pass.setSize(1920, 1080);
  assert.equal(pass.target.width, 960, 'even size is exactly half');
  assert.equal(pass.target.height, 540, 'even size is exactly half');
  pass.dispose();
});

test('setSize: a custom scale is applied, and tiny sizes never go below 1 px', async () => {
  const pass = await makePass({ scale: 0.25 });
  pass.setSize(1000, 400);
  assert.equal(pass.target.width, 250);
  assert.equal(pass.target.height, 100);

  pass.setSize(0, 1);
  assert.equal(pass.target.width, 1, 'zero width is clamped to 1');
  assert.equal(pass.target.height, 1, 'height 1 at scale 0.25 is clamped to 1');
  pass.dispose();
});

test('setSize: the same size does not reallocate the target', async () => {
  const pass = await makePass();
  pass.setSize(1280, 720);
  const disposes = countDispose(pass.target);

  pass.setSize(1280, 720);
  pass.setSize(1280, 720);
  assert.equal(disposes.count, 0, 'no dispose for an unchanged size');
  assert.equal(pass.target.width, 640);
  pass.dispose();
});

test('setSize: a real size change reallocates the target once', async () => {
  const pass = await makePass();
  pass.setSize(1280, 720);
  const disposes = countDispose(pass.target);

  pass.setSize(1000, 720);
  assert.equal(disposes.count, 1, 'one dispose for the old GPU texture');
  assert.equal(pass.target.width, 500);

  pass.setSize(1000, 720);
  assert.equal(disposes.count, 1, 'repeating the new size does not dispose again');
  pass.dispose();
});

test('dispose: frees the target, the copy material and the full-screen quad', async () => {
  const pass = await makePass();
  pass.setSize(800, 600);
  const targetDisposes = countDispose(pass.target);
  const materialDisposes = countDispose(pass.copyMaterial);
  let quadDisposes = 0;
  const quadDispose = pass.quad.dispose.bind(pass.quad);
  pass.quad.dispose = () => { quadDisposes += 1; quadDispose(); };

  pass.dispose();
  assert.equal(targetDisposes.count, 1, 'render target disposed');
  assert.equal(materialDisposes.count, 1, 'copy material disposed');
  assert.equal(quadDisposes, 1, 'full-screen quad disposed');
});

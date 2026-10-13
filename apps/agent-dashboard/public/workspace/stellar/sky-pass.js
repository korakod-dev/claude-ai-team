/**
 * stellar/sky-pass.js - Half-resolution sky pass for the Stellar Universe composer (scene.js). Browser module (imports THREE).
 *
 * The sky dome (SKY_FRAG, two-layer fbm) is the most expensive shader per pixel, and its output is smooth, so it
 * does not need full resolution. This pass:
 *   1. draws the sky dome into a render target at `scale` of the composer size (0.5 = a quarter of the pixels),
 *   2. copies that target into the composer read buffer with bilinear filtering (the upscale to full screen),
 *   3. clears the depth of the read buffer, so the scene pass after it starts with a clean depth buffer.
 * The scene pass (RenderPass, colour clear OFF) then draws stars, dust, planets and effects on top, as before.
 *
 * The sky is drawn with the same camera as the scene pass, so orientation and projection match. The target has no
 * depth buffer (the sky never writes depth) and HalfFloat precision, the same as the composer buffers.
 *
 * Resize: EffectComposer calls setSize() on every pass (addPass, composer.setSize, setPixelRatio), with the full
 * effective size in device pixels. This pass sets its own target to `scale` of that size. WebGLRenderTarget.setSize()
 * disposes the old GPU texture and the renderer allocates the new one on next use, so resizing does not leak.
 * Only a real size change touches the target. dispose() frees the target and the quad (page teardown).
 */
import * as THREE from '../vendor/three/three.module.min.js';
import { Pass, FullScreenQuad } from '../vendor/three/addons/postprocessing/Pass.js';
import { CopyShader } from '../vendor/three/addons/shaders/CopyShader.js';

export class SkyPass extends Pass {
  /**
   * skyScene  THREE.Scene that holds only the sky dome (stellar/backdrop.js)
   * camera    the camera the scene pass uses (same orientation and projection)
   * options.scale  size of the sky target relative to the composer size (default 0.5 = half resolution per axis)
   */
  constructor(skyScene, camera, options = {}) {
    super();
    this.skyScene = skyScene;
    this.camera = camera;
    this.scale = options.scale ?? 0.5;

    // Output goes into the read buffer and the scene pass draws on top of it
    this.needsSwap = false;
    this.clear = false;

    // Half-resolution sky target: no depth buffer (the sky never writes depth), no MSAA (the sky is smooth)
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      samples: 0,
    });
    this.target.texture.minFilter = THREE.LinearFilter; // bilinear upscale
    this.target.texture.magFilter = THREE.LinearFilter;

    // Upscale copy: a full-screen quad that samples the sky target
    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.copyMaterial.uniforms.tDiffuse.value = this.target.texture;
    this.quad = new FullScreenQuad(this.copyMaterial);
  }

  /** Called by EffectComposer with the full effective size (device px). The sky target gets `scale` of it. */
  setSize(width, height) {
    const w = Math.max(1, Math.ceil(width * this.scale));
    const h = Math.max(1, Math.ceil(height * this.scale));
    if (w === this.target.width && h === this.target.height) return; // same size: keep the GPU texture
    this.target.setSize(w, h);   // disposes the old GPU texture; the renderer allocates the new one on next use
  }

  /** Draw the sky at half resolution, then upscale it into the read buffer. */
  render(renderer, writeBuffer, readBuffer) {
    // 1. Sky dome into the half-resolution target (renderer.render clears the target first)
    renderer.setRenderTarget(this.target);
    renderer.render(this.skyScene, this.camera);

    // 2. Upscale into the read buffer; clear its depth so the scene pass starts clean.
    // The quad covers every pixel, so its own colour clear is skipped (autoClear off, restored after).
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clear(false, true, false);
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.quad.render(renderer);
    renderer.autoClear = oldAutoClear;
  }

  /** Free the GPU resources of this pass. */
  dispose() {
    this.target.dispose();
    this.copyMaterial.dispose();
    this.quad.dispose();
  }
}

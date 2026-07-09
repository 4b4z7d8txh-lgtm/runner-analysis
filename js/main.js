/* ==========================================================================
   main.js — boot + requestAnimationFrame loop. The stride-cycle phase clock
   advances with the live cadence; renderer and analytics both read the model
   directly each frame, so every input change lands within one frame (<100ms).
   ========================================================================== */
(function () {
  "use strict";

  const R = window.RunSim;

  let phi = 0;        // stride-cycle phase ∈ [0,1): 0 = left-foot contact
  let lastT = 0;

  function frame(t) {
    const dt = Math.min(80, lastT ? t - lastT : 16); // clamp tab-switch jumps
    lastT = t;

    // cadence spm → stride cycles (2 steps) per ms
    phi = (phi + dt * R.model.state.cadenceSpm / 120000) % 1;

    R.controls.tickAutoplay(dt); // advance the course position if playing

    const eff = R.model.efficiency(); // one evaluation shared per frame

    R.renderer.render(phi, {
      eff,
      ghost: document.getElementById("ghostToggle").checked,
      figureStyle: document.getElementById("figureStyle").value,
      scroll: document.getElementById("scrollToggle").checked,
    }, dt);

    R.analytics.update(t, eff);

    requestAnimationFrame(frame);
  }

  window.addEventListener("DOMContentLoaded", () => {
    R.renderer.init(document.getElementById("simCanvas"));
    R.analytics.refreshColors();
    R.controls.init();
    requestAnimationFrame(frame);
  });
})();

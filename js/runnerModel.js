/* ==========================================================================
   runnerModel.js — anthropometrics, parameter state, and every biomechanics
   formula in the simulator (Section 3 of the spec). Tune numbers here.

   All ranges are evidence-informed heuristics from running-biomechanics
   guidelines, not rigid physiological law. Comments cite the intent of each
   rule so the constants can be retuned without re-deriving them.
   ========================================================================== */
(function () {
  "use strict";

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ---------- anthropometric auto-suggestion ratios (× height) ---------- */
  const RATIOS = { leg: 0.50, torso: 0.30, arm: 0.44, foot: 0.15 };

  /* ---------- experience level → cadence & stride-factor defaults ------- */
  const EXPERIENCE = {
    beginner:     { cadenceBase: 166, cadenceTarget: [165, 175], strideFactorBias: -0.02 },
    intermediate: { cadenceBase: 172, cadenceTarget: [170, 180], strideFactorBias: 0.00 },
    advanced:     { cadenceBase: 178, cadenceTarget: [175, 185], strideFactorBias: 0.01 },
    elite:        { cadenceBase: 184, cadenceTarget: [180, 190], strideFactorBias: 0.02 },
  };

  /* ---------- surface → contact-time & energy modifiers ------------------ */
  /* gctFactor multiplies ideal ground contact time (soft = longer contact);
     energyFactor scales the efficiency penalty for running on that surface. */
  const SURFACES = {
    road:  { label: "Road",  gctFactor: 1.00, energyFactor: 1.00 },
    track: { label: "Track", gctFactor: 0.97, energyFactor: 0.98 },
    grass: { label: "Grass", gctFactor: 1.05, energyFactor: 1.04 },
    trail: { label: "Trail", gctFactor: 1.08, energyFactor: 1.06 },
    sand:  { label: "Sand",  gctFactor: 1.18, energyFactor: 1.15 },
  };

  /* ---------- mutable simulation state ----------------------------------- */
  const state = {
    // anthropometrics (cm / kg)
    heightCm: 175, weightKg: 70,
    legLenCm: 88, torsoLenCm: 53, armLenCm: 77, footLenCm: 26,
    experience: "intermediate",
    // which anthropometric fields the user has overridden (height stops
    // auto-updating them once touched)
    overridden: { legLenCm: false, torsoLenCm: false, armLenCm: false, footLenCm: false },

    // terrain
    surface: "road",
    gradePct: 0,
    profileMode: false,
    profilePos: 0, // 0–100 % along the elevation profile

    // running characteristics (Speed = Cadence × Stride is always enforced)
    speedKmh: 10,
    cadenceSpm: 164,
    strideLenM: 10 * 1000 / 60 / 164, // ≈1.02 m
    footStrike: "midfoot",
    vertOscCm: 8,
    gctMs: 220,

    // posture overrides
    trunkLeanDeg: 6,
    kneeLiftDeg: 62,
    overstrideCm: 4,
    armSwingDeg: 42,
    hipDropDeg: 2,
  };

  /* =======================================================================
     Speed–Cadence–Stride triad (formula 1)
     Speed (m/min) = Cadence (steps/min) × Stride length (m).
     Changing any one recalculates so the identity always holds:
       speed   → hold cadence, recompute stride
       cadence → hold speed,   recompute stride
       stride  → hold cadence, recompute speed
     ======================================================================= */
  function setSpeed(kmh) {
    state.speedKmh = clamp(kmh, 6, 24);
    state.strideLenM = speedMPerMin() / state.cadenceSpm;
  }
  function setCadence(spm) {
    state.cadenceSpm = clamp(spm, 140, 200);
    state.strideLenM = speedMPerMin() / state.cadenceSpm;
  }
  function setStride(m) {
    state.strideLenM = clamp(m, 0.5, 2.6);
    state.speedKmh = clamp(state.strideLenM * state.cadenceSpm * 60 / 1000, 6, 24);
    // re-derive stride in case the speed clamp bit, keeping the triad exact
    state.strideLenM = speedMPerMin() / state.cadenceSpm;
  }
  function speedMPerMin() { return state.speedKmh * 1000 / 60; }

  /* ---------- height change re-suggests untouched segment lengths -------- */
  function setHeight(cm) {
    state.heightCm = cm;
    if (!state.overridden.legLenCm)   state.legLenCm   = Math.round(cm * RATIOS.leg);
    if (!state.overridden.torsoLenCm) state.torsoLenCm = Math.round(cm * RATIOS.torso);
    if (!state.overridden.armLenCm)   state.armLenCm   = Math.round(cm * RATIOS.arm);
    if (!state.overridden.footLenCm)  state.footLenCm  = Math.round(cm * RATIOS.foot * 10) / 10;
  }

  /* =======================================================================
     Elevation profile mode: flat → uphill → downhill → flat course.
     Returns grade (%) at position t ∈ [0,100]; segments blend linearly so
     scrubbing the timeline changes grade continuously.
     ======================================================================= */
  const PROFILE = [
    { until: 20, grade: 0 },   // flat warm-up
    { until: 45, grade: 10 },  // climb
    { until: 55, grade: 10 },  // crest
    { until: 80, grade: -9 },  // descent
    { until: 100, grade: 0 },  // flat finish
  ];
  // an uploaded GPX course (grade[]/elev[] sampled at 0..100 %) overrides the
  // synthetic profile when present
  let course = null;
  function setCourse(c) { course = c; }
  function clearCourse() { course = null; }
  function getCourse() { return course; }

  function sampleAt(arr, t) {
    const x = clamp(t, 0, 100) / 100 * (arr.length - 1);
    const i = Math.floor(x), f = x - i;
    return i + 1 < arr.length ? lerp(arr[i], arr[i + 1], f) : arr[i];
  }

  function profileGrade(t) {
    if (course) return sampleAt(course.grade, t);
    let prevEnd = 0, prevGrade = PROFILE[0].grade;
    for (const seg of PROFILE) {
      if (t <= seg.until) {
        const f = (t - prevEnd) / Math.max(1e-6, seg.until - prevEnd);
        return lerp(prevGrade, seg.grade, f);
      }
      prevEnd = seg.until; prevGrade = seg.grade;
    }
    return 0;
  }

  // elevation (m) at course position t ∈ [0,100]; only meaningful with a course
  function profileElev(t) { return course ? sampleAt(course.elev, t) : 0; }

  /* =======================================================================
     Ideal-posture model (formulas 2–7). Computed for the CURRENT speed,
     grade, surface and runner — drives the ghost overlay, the reset-to-ideal
     button, and the deviation penalties in the efficiency score.
     ======================================================================= */
  function ideal() {
    const exp = EXPERIENCE[state.experience];
    const surf = SURFACES[state.surface];
    const g = state.gradePct;
    const v = state.speedKmh;

    // (3) cadence guideline: experience base, rising gently with speed…
    let cad = exp.cadenceBase + (v - 10) * 1.1;
    // (4) …+5–10 spm uphill, −5–10 spm downhill (scaled by grade severity)
    cad += clamp(g, -15, 15) / 15 * (g >= 0 ? 8 : 8);
    cad = clamp(cad, 150, 200);

    // (2) optimal stride ≈ height × stride factor; factor grows with speed
    // (0.43–0.50 distance → 0.50–0.70 sprint-style)
    const speedT = clamp((v - 8) / 14, 0, 1); // 8 km/h → 22 km/h
    const strideFactor = clamp(lerp(0.44, 0.62, speedT) + exp.strideFactorBias, 0.40, 0.70);
    const strideByHeight = state.heightCm / 100 * strideFactor;
    // the triad must also hold at the ideal cadence — blend the two estimates
    const strideByTriad = speedMPerMin() / cad;
    const stride = (strideByHeight + strideByTriad) / 2;

    // (5) trunk lean: ~6° forward on the flat, +1° per +2% uphill grade
    // (max ~15°); more upright — never leaning back — on downhills
    const lean = clamp(6 + (g >= 0 ? g / 2 : g / 3), 1, 15);

    // (7) ground contact time: shorter with speed, longer on soft surfaces
    // and uphill; ideal band ~200–250 ms
    let gct = clamp(340 - v * 9.5, 150, 300);
    gct *= surf.gctFactor;
    gct *= 1 + Math.max(0, g) * 0.006;
    gct = clamp(gct, 150, 300);

    // vertical oscillation: falls as cadence/speed rise (~9 cm easy → ~5 fast)
    const vo = clamp(9.2 - (v - 8) * 0.22 - Math.max(0, cad - 170) * 0.03, 4.5, 9.5);

    // knee lift grows with speed: ~55° easy jog → ~105° sprinting
    const kneeLift = clamp(lerp(55, 105, speedT) + Math.max(0, g) * 0.6, 45, 110);

    // foot should land close to under the centre of mass (slightly ahead)
    const overstride = clamp(3 - Math.max(0, g) * 0.15, 0, 4);

    // arm swing scales with speed; hips stay level
    const armSwing = clamp(30 + v * 2.2, 25, 85);
    const hipDrop = 2;

    return {
      cadenceSpm: cad, strideLenM: stride, trunkLeanDeg: lean, gctMs: gct,
      vertOscCm: vo, kneeLiftDeg: kneeLift, overstrideCm: overstride,
      armSwingDeg: armSwing, hipDropDeg: hipDrop,
      // the ~200–250 ms guideline, re-centred on the speed/terrain ideal
      gctBand: [clamp(gct - 25, 150, 300), clamp(gct + 25, 150, 300)],
      cadenceBand: exp.cadenceTarget,
    };
  }

  /* =======================================================================
     Efficiency score (formula 8): 0–100 composite running-economy index.
     100 minus weighted deviation penalties; each penalty is capped so no
     single factor dominates, and every one is reported for the dashboard.
     ======================================================================= */
  function efficiency() {
    const id = ideal();
    const surf = SURFACES[state.surface];
    const p = {};

    // cadence deviation from ideal (per spm, capped)
    p.cadence = clamp(Math.abs(state.cadenceSpm - id.cadenceSpm) * 0.55, 0, 22);

    // stride-length deviation (% of ideal stride)
    p.stride = clamp(Math.abs(state.strideLenM - id.strideLenM) / id.strideLenM * 45, 0, 15);

    // vertical oscillation: excess bounce is wasted vertical work
    p.vertOsc = clamp(Math.max(0, state.vertOscCm - id.vertOscCm) * 3 +
                      Math.max(0, id.vertOscCm - state.vertOscCm) * 0.8, 0, 14);

    // trunk lean appropriateness for the current grade
    p.lean = clamp(Math.abs(state.trunkLeanDeg - id.trunkLeanDeg) * 1.1, 0, 12);

    // (6) overstriding: braking penalty ramps once the foot lands >~5 cm
    // ahead of the COM and steepens past the 10–15 cm flag zone
    const os = state.overstrideCm;
    p.overstride = clamp(Math.max(0, os - 5) * 1.6 + Math.max(0, os - 12) * 1.2 +
                         Math.max(0, -os) * 0.8, 0, 24);

    // ground contact time vs the speed/terrain-adjusted ideal
    p.gct = clamp(Math.abs(state.gctMs - id.gctMs) / 9, 0, 10);

    // lateral hip drop beyond ~4° reads as a stability leak
    p.hipDrop = clamp(Math.max(0, state.hipDropDeg - 4) * 1.6, 0, 10);

    let score = 100;
    for (const k in p) score -= p[k];
    // soft surfaces make every flaw cost more
    score = 100 - (100 - score) * surf.energyFactor;
    score = clamp(Math.round(score), 0, 100);

    // overstride flag levels for the warning indicator (formula 6)
    const overstrideLevel = os > 15 ? 2 : os > 10 ? 1 : 0;

    return { score, penalties: p, ideal: id, overstrideLevel };
  }

  /* =======================================================================
     Scenario presets — sensible full parameter sets per the spec.
     ======================================================================= */
  const PRESETS = {
    flatRoadEasy: {
      surface: "road", gradePct: 0, speedKmh: 10, cadenceSpm: 172,
      footStrike: "midfoot", vertOscCm: 8, gctMs: 245,
      trunkLeanDeg: 6, kneeLiftDeg: 60, overstrideCm: 3, armSwingDeg: 40, hipDropDeg: 2,
    },
    uphillTrail: {
      surface: "trail", gradePct: 12, speedKmh: 8, cadenceSpm: 180,
      footStrike: "forefoot", vertOscCm: 6.5, gctMs: 265,
      trunkLeanDeg: 12, kneeLiftDeg: 72, overstrideCm: 1, armSwingDeg: 52, hipDropDeg: 2,
    },
    downhillRoad: {
      surface: "road", gradePct: -9, speedKmh: 15, cadenceSpm: 176,
      footStrike: "midfoot", vertOscCm: 7, gctMs: 200,
      trunkLeanDeg: 3, kneeLiftDeg: 68, overstrideCm: 8, armSwingDeg: 48, hipDropDeg: 2,
    },
    sprintTrack: {
      surface: "track", gradePct: 0, speedKmh: 23, cadenceSpm: 196,
      footStrike: "forefoot", vertOscCm: 5.5, gctMs: 160,
      trunkLeanDeg: 8, kneeLiftDeg: 105, overstrideCm: 2, armSwingDeg: 80, hipDropDeg: 1,
    },
  };

  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    Object.assign(state, p);
    setCadence(p.cadenceSpm); // re-derive stride so the triad holds
  }

  /* snap posture + running characteristics to the computed ideal */
  function resetToIdeal() {
    const id = ideal();
    state.cadenceSpm = clamp(Math.round(id.cadenceSpm), 140, 200);
    state.strideLenM = speedMPerMin() / state.cadenceSpm;
    state.vertOscCm = clamp(Math.round(id.vertOscCm * 10) / 10, 4, 12);
    state.gctMs = clamp(Math.round(id.gctMs), 150, 300);
    state.trunkLeanDeg = Math.round(id.trunkLeanDeg * 2) / 2;
    state.kneeLiftDeg = Math.round(id.kneeLiftDeg);
    state.overstrideCm = Math.round(id.overstrideCm * 2) / 2;
    state.armSwingDeg = Math.round(id.armSwingDeg);
    state.hipDropDeg = id.hipDropDeg;
  }

  window.RunSim = window.RunSim || {};
  window.RunSim.model = {
    state, RATIOS, EXPERIENCE, SURFACES, PRESETS, PROFILE,
    setSpeed, setCadence, setStride, setHeight, speedMPerMin,
    profileGrade, profileElev, ideal, efficiency, applyPreset, resetToIdeal,
    setCourse, clearCourse, getCourse,
    clamp, lerp,
  };
})();

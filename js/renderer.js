/* ==========================================================================
   renderer.js — canvas scene: procedural gait-cycle kinematics, the stick
   figure (+ optional silhouette skin), the ideal ghost overlay, tilted &
   scrolling terrain, and the braking-force overstride visual.

   Kinematics are stylised forward kinematics: joint-angle curves are simple
   piecewise cosine eases over the stride cycle, parameterised by the model
   state so every slider visibly changes the animation.
   ========================================================================== */
(function () {
  "use strict";

  const M = () => window.RunSim.model;
  const DEG = Math.PI / 180;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const ease = t => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1));
  const asinDeg = x => Math.asin(clamp(x, -1, 1)) / DEG;

  let canvas, ctx, dpr = 1, W = 0, H = 0;
  let colors = {};
  let groundScroll = 0; // world distance scrolled (cm)

  /* foot-strike pattern → ankle angle at contact (+ = dorsiflexed, toes up) */
  const STRIKE_ANKLE = { heel: 18, midfoot: 4, forefoot: -10 };
  /* knee flexion at contact per strike (heel strikers land straighter) */
  const STRIKE_KNEE = { heel: 8, midfoot: 14, forefoot: 20 };

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext("2d");
    refreshColors();
    resize();
    window.addEventListener("resize", resize);
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    W = Math.max(200, rect.width);
    H = Math.max(200, rect.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }

  /* canvas can't use CSS vars directly — snapshot them on init/theme change */
  function refreshColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = name => cs.getPropertyValue(name).trim();
    colors = {
      sky: v("--sky"), ground: v("--ground"),
      ink: v("--text-primary"), soft: v("--text-muted"),
      grid: v("--grid"), baseline: v("--baseline"),
      series1: v("--series-1"), ghost: v("--series-5"),
      serious: v("--status-serious"), critical: v("--status-critical"),
    };
  }

  /* =======================================================================
     Gait kinematics: joint angles for one leg at leg-phase t ∈ [0,1)
     (t = 0 is initial contact). Angles in degrees from vertical-down,
     positive = forward (runner faces +x).
     ======================================================================= */
  function legPose(t, p) {
    const effLeg = p.legLenCm * 0.95; // knee is never fully straight
    const d = p.duty;                 // stance fraction of the stride cycle

    // thigh at contact: set by how far ahead of the COM the foot lands
    const thighContact = asinDeg(p.overstrideCm / effLeg) + 4;
    // thigh at toe-off: stance sweep covers the ground travelled during
    // contact (speed × GCT), so extension grows with speed and stride
    const sweepCm = p.speedCmS * p.gctMs / 1000;
    const thighExt = clamp(asinDeg(sweepCm / effLeg - Math.sin(thighContact * DEG)), 8, 55);
    // swing peak: knee-lift drive
    const thighPeak = clamp(p.kneeLiftDeg * 0.55, 18, 65);

    const kneeContact = STRIKE_KNEE[p.footStrike];
    const ankleContact = STRIKE_ANKLE[p.footStrike];

    const mid = d + 0.42 * (1 - d);   // peak leg-fold moment in swing
    const late = d + 0.72 * (1 - d);  // start of forward reach

    let thigh, knee, ankle;
    if (t < d) {
      // ---- stance: thigh sweeps contact → extension; knee loads & unloads
      const s = t / d;
      thigh = thighContact + (-thighExt - thighContact) * ease(s);
      knee = kneeContact + 16 * Math.sin(Math.PI * s) + 4 * s;
      ankle = ankleContact + (-26 - ankleContact) * ease(Math.max(0, s - 0.35) / 0.65);
    } else if (t < mid) {
      // ---- early swing: heel folds toward glutes, thigh starts forward
      const s = (t - d) / (mid - d);
      const kneeToeOff = kneeContact + 4; // matches the end of stance
      thigh = -thighExt + (thighPeak + thighExt) * ease(s);
      knee = kneeToeOff + (p.kneeLiftDeg - kneeToeOff) * ease(s);
      ankle = -26 + (8 + 26) * ease(s);
    } else if (t < late) {
      // ---- mid swing: thigh holds near peak, knee begins to extend
      const s = (t - mid) / (late - mid);
      thigh = thighPeak;
      knee = p.kneeLiftDeg + (kneeContact + 22 - p.kneeLiftDeg) * ease(s);
      ankle = 8;
    } else {
      // ---- late swing: leg reaches & retracts to the contact pose
      const s = (t - late) / (1 - late);
      thigh = thighPeak + (thighContact - thighPeak) * ease(s);
      knee = kneeContact + 22 - 22 * ease(s);
      ankle = 8 + (ankleContact - 8) * ease(s);
    }
    return { thigh, knee, ankle };
  }

  /* arm swing is counter-phase to the same-side leg */
  function armPose(tLeg, p) {
    const shoulder = -p.armSwingDeg * 0.5 * Math.cos(2 * Math.PI * tLeg);
    const elbow = 82 + 18 * Math.sin(2 * Math.PI * tLeg); // stays ~90° flexed
    return { shoulder, elbow };
  }

  /* gather the per-frame animation parameters for a figure */
  function figureParams(src, ideal) {
    const cycleMs = 120000 / src.cadenceSpm; // full stride = 2 steps
    return {
      legLenCm: M().state.legLenCm, torsoLenCm: M().state.torsoLenCm,
      armLenCm: M().state.armLenCm, footLenCm: M().state.footLenCm,
      cadenceSpm: src.cadenceSpm,
      duty: clamp(src.gctMs / cycleMs, 0.18, 0.5),
      gctMs: src.gctMs,
      speedCmS: M().state.speedKmh * 100000 / 3600, // shared speed for both figures
      overstrideCm: src.overstrideCm,
      kneeLiftDeg: src.kneeLiftDeg,
      footStrike: src.footStrike || M().state.footStrike,
      trunkLeanDeg: src.trunkLeanDeg,
      armSwingDeg: src.armSwingDeg,
      vertOscCm: src.vertOscCm,
      hipDropDeg: src.hipDropDeg,
    };
  }

  /* =======================================================================
     Figure geometry: joint positions (px) from the pose at stride-phase φ.
     ======================================================================= */
  function computeFigure(phi, p, scale, cx, groundY) {
    const pt = (x, y) => ({ x, y });
    const dir = a => ({ x: Math.sin(a * DEG), y: Math.cos(a * DEG) });

    const thighLen = p.legLenCm * 0.53 * scale;
    const shinLen = p.legLenCm * 0.47 * scale;
    const torsoLen = p.torsoLenCm * scale;
    const upperArm = p.armLenCm * 0.5 * scale;
    const forearm = p.armLenCm * 0.42 * scale;
    const footLen = p.footLenCm * scale;
    const headR = M().state.heightCm * 0.062 * scale;

    // pelvis bob: lowest at mid-stance, highest mid-flight (twice per cycle)
    const bounce = 0.5 - 0.5 * Math.cos(4 * Math.PI * (phi - p.duty / 2));
    const hipBase = groundY - p.legLenCm * 0.93 * scale;
    const hip = pt(cx, hipBase - p.vertOscCm * scale * bounce);

    const legs = [phi % 1, (phi + 0.5) % 1].map(t => {
      const a = legPose(t, p);
      const knee = pt(hip.x + thighLen * dir(a.thigh).x, hip.y + thighLen * dir(a.thigh).y);
      const shinA = a.thigh - a.knee;
      const ankle = pt(knee.x + shinLen * dir(shinA).x, knee.y + shinLen * dir(shinA).y);
      const footA = shinA + 90 - a.ankle; // ~perpendicular to shin ± dorsiflexion
      const f = dir(footA);
      const heel = pt(ankle.x - footLen * 0.28 * f.x, ankle.y - footLen * 0.28 * f.y);
      const toe = pt(ankle.x + footLen * 0.72 * f.x, ankle.y + footLen * 0.72 * f.y);
      return { t, knee, ankle, heel, toe, inStance: t < p.duty };
    });

    // trunk leans forward from the hip; slight extra sway with the bounce
    const trunkA = -(p.trunkLeanDeg + 1.5 * Math.sin(4 * Math.PI * phi));
    const up = dir(trunkA);
    const shoulder = pt(hip.x - torsoLen * up.x, hip.y - torsoLen * up.y);
    const neck = pt(shoulder.x - headR * 0.5 * up.x, shoulder.y - headR * 0.5 * up.y);
    const head = pt(neck.x - headR * 1.1 * up.x + headR * 0.25, neck.y - headR * 1.1 * up.y);

    const arms = [phi % 1, (phi + 0.5) % 1].map(t => {
      const a = armPose(t, p);
      const armA = a.shoulder + p.trunkLeanDeg; // hangs off the leaning trunk
      const elbow = pt(shoulder.x + upperArm * dir(armA).x, shoulder.y + upperArm * dir(armA).y);
      // elbow flexes FORWARD (+): the forearm stays in front of the body across
      // the whole swing, hand tracking up toward the chest — never behind.
      const foreA = armA + a.elbow;
      const wrist = pt(elbow.x + forearm * dir(foreA).x, elbow.y + forearm * dir(foreA).y);
      return { elbow, wrist };
    });

    // pelvis bar tilts with lateral hip drop (a frontal-plane cue, hinted)
    const pTilt = p.hipDropDeg * 0.7 * Math.sin(4 * Math.PI * phi) * DEG;
    const pw = 9 * scale;
    const pelvis = {
      a: pt(hip.x - pw * Math.cos(pTilt), hip.y - pw * Math.sin(pTilt)),
      b: pt(hip.x + pw * Math.cos(pTilt), hip.y + pw * Math.sin(pTilt)),
    };

    return { hip, shoulder, neck, head, headR, legs, arms, pelvis };
  }

  /* =======================================================================
     Drawing helpers
     ======================================================================= */
  function seg(a, b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
  function joint(pnt, r) { ctx.beginPath(); ctx.arc(pnt.x, pnt.y, r, 0, Math.PI * 2); ctx.fill(); }

  /* ---- Vector skeleton: thin bones + joint dots ------------------------- */
  function drawSkeleton(fig, stroke, jointFill, alpha) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 3;

    // far side dimmer for depth
    ctx.globalAlpha = alpha * 0.45;
    const L1 = fig.legs[1], A1 = fig.arms[1];
    seg(fig.hip, L1.knee); seg(L1.knee, L1.ankle); seg(L1.heel, L1.toe);
    seg(fig.shoulder, A1.elbow); seg(A1.elbow, A1.wrist);

    ctx.globalAlpha = alpha;
    const L0 = fig.legs[0], A0 = fig.arms[0];
    seg(fig.hip, L0.knee); seg(L0.knee, L0.ankle); seg(L0.heel, L0.toe);
    seg(fig.hip, fig.shoulder);
    seg(fig.pelvis.a, fig.pelvis.b);
    seg(fig.shoulder, fig.neck);
    ctx.beginPath(); ctx.arc(fig.head.x, fig.head.y, fig.headR, 0, Math.PI * 2); ctx.stroke();
    seg(fig.shoulder, A0.elbow); seg(A0.elbow, A0.wrist);

    if (jointFill) {
      ctx.fillStyle = jointFill;
      for (const p of [fig.hip, fig.shoulder, L0.knee, L0.ankle, A0.elbow, A0.wrist]) joint(p, 3.5);
    }
    ctx.restore();
  }

  /* ---- Realistic body: fleshed limbs as rounded capsules + torso + head -- */
  function capsule(a, b, thickCm, scale) {
    ctx.lineWidth = thickCm * scale;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  function limbSet(fig, i, scale) {
    const L = fig.legs[i], A = fig.arms[i];
    capsule(fig.hip, L.knee, 15, scale);   // thigh
    capsule(L.knee, L.ankle, 10, scale);   // shin
    capsule(L.ankle, L.toe, 7, scale);     // foot
    capsule(L.heel, L.toe, 6, scale);
    capsule(fig.shoulder, A.elbow, 9, scale);  // upper arm
    capsule(A.elbow, A.wrist, 6.5, scale);     // forearm
  }
  function drawSilhouette(fig, fill, alpha, scale) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = fill;
    ctx.fillStyle = fill;

    // far limbs, dimmed for depth
    ctx.globalAlpha = alpha * 0.5;
    limbSet(fig, 1, scale);

    // torso as a rounded barrel along the spine, then near limbs, neck, head
    ctx.globalAlpha = alpha;
    capsule(fig.hip, fig.shoulder, 27, scale);
    limbSet(fig, 0, scale);
    capsule(fig.shoulder, fig.neck, 9, scale);
    ctx.beginPath(); ctx.arc(fig.head.x, fig.head.y, fig.headR * 1.18, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /* Draw the live figure in the requested style: vector, realistic, or both */
  function drawFigure(fig, style, bodyFill, skeletonStroke, jointFill, alpha, scale) {
    if (style === "realistic" || style === "both") {
      drawSilhouette(fig, bodyFill, style === "both" ? alpha * 0.45 : alpha, scale);
    }
    if (style === "vector" || style === "both") {
      // in "both" the body already carries identity, so drop the joint dots
      drawSkeleton(fig, skeletonStroke, style === "both" ? null : jointFill, alpha);
    }
  }

  /* terrain band, tilted by grade and scrolling with speed */
  function drawGround(groundY, cx, gradePct, surface, scale, strideLenM) {
    const slope = Math.atan(gradePct / 100);
    ctx.save();
    ctx.translate(cx, groundY);
    ctx.rotate(-slope); // uphill to the right of the runner

    // ground fill
    ctx.fillStyle = colors.ground;
    ctx.fillRect(-W * 1.6, 0, W * 3.2, H);
    ctx.strokeStyle = colors.baseline;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-W * 1.6, 0); ctx.lineTo(W * 1.6, 0); ctx.stroke();

    // scrolling surface texture
    const off = -(groundScroll * scale) % 60;
    ctx.strokeStyle = colors.soft;
    ctx.fillStyle = colors.soft;
    ctx.globalAlpha = 0.55;
    for (let x = -W * 1.2 + off; x < W * 1.2; x += 60) {
      switch (surface) {
        case "road": // dashed centre line
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(x, 14); ctx.lineTo(x + 24, 14); ctx.stroke();
          break;
        case "track": // lane line + tick
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x + 60, 10); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, 16); ctx.stroke();
          break;
        case "trail": // scattered stones
          for (let i = 0; i < 3; i++) {
            const jx = x + ((i * 37 + 13) % 52), jy = 8 + ((i * 23 + x * 0.13) % 14 + 14) % 14;
            ctx.beginPath(); ctx.arc(jx, jy, 2.2, 0, Math.PI * 2); ctx.fill();
          }
          break;
        case "grass": // short blades
          ctx.lineWidth = 1.5;
          for (let i = 0; i < 5; i++) {
            const jx = x + i * 12;
            ctx.beginPath(); ctx.moveTo(jx, 2); ctx.lineTo(jx + 2, -5); ctx.stroke();
          }
          break;
        case "sand": // stippling
          for (let i = 0; i < 6; i++) {
            const jx = x + ((i * 29 + 7) % 58), jy = 5 + ((i * 17 + x * 0.31) % 16 + 16) % 16;
            ctx.beginPath(); ctx.arc(jx, jy, 1.3, 0, Math.PI * 2); ctx.fill();
          }
          break;
      }
    }

    // ---- metre ruler: ticks + labels in world distance, scrolling with the
    // runner so the foot's travel per step (the stride) is measurable ---------
    ctx.globalAlpha = 1;
    const halfWorldCm = (W / scale) * 1.2;
    const firstM = Math.floor((groundScroll - halfWorldCm) / 100);
    const lastM = Math.ceil((groundScroll + halfWorldCm) / 100);
    ctx.textAlign = "center";
    ctx.font = "600 10px system-ui, sans-serif";
    for (let m = firstM; m <= lastM; m++) {
      const x = (m * 100 - groundScroll) * scale;
      ctx.strokeStyle = colors.baseline;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 11); ctx.stroke();
      ctx.fillStyle = colors.soft;
      ctx.fillText(`${m} m`, x, 23);
      const xh = (m * 100 + 50 - groundScroll) * scale; // half-metre minor tick
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xh, 0); ctx.lineTo(xh, 6); ctx.stroke();
    }

    // ---- stride bracket under the runner: current stride length to scale ----
    const swPx = strideLenM * 100 * scale;
    const by = 34;
    ctx.strokeStyle = colors.series1;
    ctx.fillStyle = colors.series1;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-swPx / 2, by); ctx.lineTo(swPx / 2, by); ctx.stroke();
    for (const ex of [-swPx / 2, swPx / 2]) {
      ctx.beginPath(); ctx.moveTo(ex, by - 5); ctx.lineTo(ex, by + 5); ctx.stroke();
    }
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.fillText(`stride ${strideLenM.toFixed(2)} m`, 0, by + 16);
    ctx.textAlign = "start";
    ctx.restore();
  }

  /* braking-force arrow at the landing foot when overstriding */
  function drawBrakingVector(fig, level, osCm, scale) {
    // show the arrow during early stance (the braking half of contact)
    const stanceLeg = fig.legs.find(L => L.inStance && L.t < 0.18);
    if (!stanceLeg) return;
    const len = clamp((osCm - 8) * 3.2 * scale, 12, 90);
    const from = stanceLeg.ankle;
    ctx.save();
    ctx.strokeStyle = level >= 2 ? colors.critical : colors.serious;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y - 4);
    ctx.lineTo(from.x - len, from.y - 4 - len * 0.25);
    ctx.stroke();
    // arrowhead
    const ax = from.x - len, ay = from.y - 4 - len * 0.25;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + 9, ay - 4);
    ctx.lineTo(ax + 8, ay + 6);
    ctx.closePath(); ctx.fill();
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.fillText("braking", ax, ay - 8);
    ctx.restore();
  }

  /* =======================================================================
     Frame render
     ======================================================================= */
  function render(phi, opts, dtMs) {
    const st = M().state;
    const eff = opts.eff; // efficiency() result computed once per frame

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // sky
    ctx.fillStyle = colors.sky;
    ctx.fillRect(0, 0, W, H);

    // FIXED px-per-cm scale (independent of runner height) so the figure is
    // drawn to scale: a taller runner is visibly taller on the canvas. The
    // divisor is tuned so the 140–210 cm range fits the stage with margin.
    const scale = H / 300;
    const cx = W * 0.46;
    const groundY = H * 0.82;

    if (opts.scroll) groundScroll += st.speedKmh * 100000 / 3600 * (dtMs / 1000);
    drawGround(groundY, cx, st.gradePct, st.surface, scale, st.strideLenM);

    // ghost first (behind the live runner), sharing the same phase clock —
    // always a faint skeleton, whatever style the live figure uses
    if (opts.ghost) {
      const gp = figureParams(Object.assign({}, eff.ideal, { footStrike: "midfoot" }), true);
      const gfig = computeFigure(phi, gp, scale, cx, groundY);
      drawSkeleton(gfig, colors.ghost, null, 0.32);
    }

    const p = figureParams(st, false);
    const fig = computeFigure(phi, p, scale, cx, groundY);

    // COM plumb line — makes the foot-strike offset visible
    ctx.save();
    ctx.strokeStyle = colors.soft;
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(fig.hip.x, fig.hip.y); ctx.lineTo(fig.hip.x, groundY); ctx.stroke();
    ctx.restore();

    drawFigure(fig, opts.figureStyle, colors.series1, colors.ink, colors.series1, 1, scale);

    if (eff.overstrideLevel > 0) drawBrakingVector(fig, eff.overstrideLevel, st.overstrideCm, scale);

    // grade readout on the slope
    ctx.fillStyle = colors.soft;
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillText(`${st.gradePct > 0 ? "+" : ""}${st.gradePct.toFixed(1)}% ${M().SURFACES[st.surface].label}`, 14, groundY + 26);
  }

  window.RunSim = window.RunSim || {};
  window.RunSim.renderer = { init, render, refreshColors, resize };
})();

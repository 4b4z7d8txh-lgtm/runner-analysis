/* ==========================================================================
   renderer.js — canvas scene: fluid procedural running via foot-target +
   2-bone inverse kinematics, a cartoon-person skin, a vector skeleton, the
   ideal ghost overlay, tilted/scrolling terrain with a metre ruler + stride
   bracket, and the overstride braking visual.

   Locomotion model (why it looks natural, not like stepped phases):
   - The contact foot is PLANTED and slides backward exactly at ground speed
     (no foot-slip) through the stance fraction of the cycle.
   - The swing foot follows a smooth C1 Hermite arc back to the next contact,
     lifting on a sine hump.
   - Knees/ankles are solved by IK from hip → foot every frame, so joint
     angles are continuous (no piecewise eases meeting at hard seams).
   ========================================================================== */
(function () {
  "use strict";

  const M = () => window.RunSim.model;
  const DEG = Math.PI / 180;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  let canvas, ctx, dpr = 1, W = 0, H = 0;
  let colors = {};
  let groundScroll = 0; // world distance scrolled (cm)

  /* foot pitch at contact by strike pattern (+ = toe-up / heel first) */
  const STRIKE_PITCH = { heel: 14, midfoot: 2, forefoot: -8 };

  /* cartoon palette — illustration colours, deliberately outside the data
     palette (this is a character drawing, not an encoded series) */
  const TOON = {
    skin: "#e8b48c", skinDark: "#c9986f",
    hair: "#39291d",
    shirt: "#2f7ed8", shirtDark: "#215ea3",
    shorts: "#2b3140", shortsDark: "#20242f",
    shoe: "#e8632c", sole: "#f4f4f2",
    line: "#2a2018",
  };

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
     Foot trajectory (hip-relative, cm). phase ∈ [0,1), 0 = initial contact.
     Returns forward offset fx and height above ground lift.
     ======================================================================= */
  function footPath(phase, p) {
    const S = p.stepLenCm;
    const duty = p.duty;
    const xC = p.overstrideCm;      // foot ahead of COM at contact
    const sweep = 2 * S * duty;     // ground travel while planted (= no slip)
    if (phase < duty) {
      // planted: slides straight back with the ground
      return { fx: xC - 2 * S * phase, lift: 0, planted: true };
    }
    // swing: C1 Hermite in x (tangents match the stance slide at both ends),
    // sine hump in lift → continuous velocity through take-off and plant.
    // Stance velocity is dx/dφ = -2S; in u-space that is -2S·(1-duty), so both
    // endpoint tangents use that value → no speed jump at toe-off or plant.
    const u = (phase - duty) / (1 - duty);
    const xTakeoff = xC - sweep;
    const m = -2 * S * (1 - duty); // dx/du at both endpoints
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u;
    const h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
    const fx = h00 * xTakeoff + h10 * m + h01 * xC + h11 * m;
    const lift = p.footClearCm * Math.sin(Math.PI * u);
    return { fx, lift, planted: false };
  }

  function footPitch(phase, p) {
    const strike = STRIKE_PITCH[p.footStrike];
    if (phase < p.duty) return strike * (1 - phase / p.duty); // flattens through stance
    const u = (phase - p.duty) / (1 - p.duty);
    return strike * u + 13 * Math.sin(Math.PI * u); // dorsiflex mid-swing → strike
  }

  /* 2-bone IK: knee for hip→ankle, chosen on the forward (+x) side */
  function solveKnee(hip, ankle, L1, L2) {
    let dx = ankle.x - hip.x, dy = ankle.y - hip.y;
    let d = Math.hypot(dx, dy) || 1e-3;
    const maxD = (L1 + L2) * 0.985, minD = Math.abs(L1 - L2) + 2;
    const dc = clamp(d, minD, maxD);
    const ux = dx / d, uy = dy / d;
    const ank = { x: hip.x + ux * dc, y: hip.y + uy * dc }; // clamp → heel lifts on over-reach
    const a = Math.acos(clamp((L1 * L1 + dc * dc - L2 * L2) / (2 * L1 * dc), -1, 1));
    const base = Math.atan2(uy, ux);
    const k1 = { x: hip.x + Math.cos(base + a) * L1, y: hip.y + Math.sin(base + a) * L1 };
    const k2 = { x: hip.x + Math.cos(base - a) * L1, y: hip.y + Math.sin(base - a) * L1 };
    const knee = k1.x >= k2.x ? k1 : k2; // knee points forward
    return { knee, ankle: ank };
  }

  /* arm swing: counter-phase to the same-side leg, elbow flexed, hand forward */
  function armPose(phase, p) {
    const shoulder = -p.armSwingDeg * 0.5 * Math.cos(2 * Math.PI * phase);
    const elbow = 78 + 22 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase)); // 78°→100°
    return { shoulder, elbow };
  }

  /* gather per-frame animation parameters for a figure */
  function figureParams(src) {
    const st = M().state;
    const cycleMs = 120000 / src.cadenceSpm; // full stride = 2 steps
    return {
      legLenCm: st.legLenCm, torsoLenCm: st.torsoLenCm,
      armLenCm: st.armLenCm, footLenCm: st.footLenCm,
      cadenceSpm: src.cadenceSpm,
      duty: clamp(src.gctMs / cycleMs, 0.18, 0.46),
      stepLenCm: src.strideLenM * 100,
      overstrideCm: src.overstrideCm,
      footClearCm: clamp(6 + src.kneeLiftDeg * 0.28, 12, 44),
      footStrike: src.footStrike || st.footStrike,
      trunkLeanDeg: src.trunkLeanDeg,
      armSwingDeg: src.armSwingDeg,
      vertOscCm: src.vertOscCm,
      hipDropDeg: src.hipDropDeg,
    };
  }

  /* =======================================================================
     Figure geometry: joint positions (px) at stride-phase φ.
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
    const ankleH = p.footLenCm * 0.34 * scale; // ankle height above sole
    const headR = M().state.heightCm * 0.058 * scale;

    // hip: rides high (legs near-extended, upright running posture) and bobs
    // twice per cycle, dipping only slightly through each mid-stance
    const bob = Math.cos(4 * Math.PI * (phi - p.duty / 2)); // +1 at mid-stance
    const hipHeight = p.legLenCm * 0.955 * scale - p.vertOscCm * 0.5 * scale * (1 + bob) * 0.6;
    const hip = pt(cx, groundY - hipHeight);

    const legs = [phi % 1, (phi + 0.5) % 1].map(t => {
      const f = footPath(t, p);
      const soleY = groundY - f.lift * scale;
      const ankle0 = pt(hip.x + f.fx * scale, soleY - ankleH);
      const { knee, ankle } = solveKnee(hip, ankle0, thighLen, shinLen);
      // foot drawn from the resolved ankle, pitched by strike/swing
      const pitch = footPitch(t, p) * DEG;
      const sole = pt(ankle.x, ankle.y + ankleH);
      const rot = (px, py) => pt(
        ankle.x + (px - ankle.x) * Math.cos(pitch) - (py - ankle.y) * Math.sin(pitch),
        ankle.y + (px - ankle.x) * Math.sin(pitch) + (py - ankle.y) * Math.cos(pitch));
      const heel = rot(sole.x - footLen * 0.30, sole.y);
      const toe = rot(sole.x + footLen * 0.70, sole.y);
      return { t, knee, ankle, heel, toe, inStance: f.planted };
    });

    // trunk leans forward from the hip, with a gentle counter-rotation sway
    const trunkA = -(p.trunkLeanDeg + 1.2 * Math.sin(4 * Math.PI * phi));
    const up = dir(trunkA);
    const shoulder = pt(hip.x - torsoLen * up.x, hip.y - torsoLen * up.y);
    const neck = pt(shoulder.x - headR * 0.55 * up.x, shoulder.y - headR * 0.55 * up.y);
    const head = pt(neck.x - headR * 1.05 * up.x + headR * 0.30, neck.y - headR * 1.05 * up.y);

    const arms = [phi % 1, (phi + 0.5) % 1].map(t => {
      const a = armPose(t, p);
      const armA = a.shoulder + p.trunkLeanDeg;
      const elbow = pt(shoulder.x + upperArm * dir(armA).x, shoulder.y + upperArm * dir(armA).y);
      const foreA = armA + a.elbow; // elbow flexes forward → hand stays in front
      const wrist = pt(elbow.x + forearm * dir(foreA).x, elbow.y + forearm * dir(foreA).y);
      return { elbow, wrist };
    });

    // pelvis bar with a hint of lateral drop
    const pTilt = p.hipDropDeg * 0.7 * Math.sin(4 * Math.PI * phi) * DEG;
    const pw = 9 * scale;
    const pelvis = {
      a: pt(hip.x - pw * Math.cos(pTilt), hip.y - pw * Math.sin(pTilt)),
      b: pt(hip.x + pw * Math.cos(pTilt), hip.y + pw * Math.sin(pTilt)),
    };

    return { hip, shoulder, neck, head, headR, legs, arms, pelvis, scale, headTilt: trunkA };
  }

  /* =======================================================================
     Drawing helpers
     ======================================================================= */
  function seg(a, b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
  function joint(p, r) { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); }
  function lerpPt(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
  function capsule(a, b, w) { ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }

  /* ---- Vector skeleton --------------------------------------------------- */
  function drawSkeleton(fig, stroke, jointFill, alpha) {
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = stroke; ctx.lineWidth = 3;

    ctx.globalAlpha = alpha * 0.45; // far side, dimmed
    const L1 = fig.legs[1], A1 = fig.arms[1];
    seg(fig.hip, L1.knee); seg(L1.knee, L1.ankle); seg(L1.heel, L1.toe);
    seg(fig.shoulder, A1.elbow); seg(A1.elbow, A1.wrist);

    ctx.globalAlpha = alpha;
    const L0 = fig.legs[0], A0 = fig.arms[0];
    seg(fig.hip, L0.knee); seg(L0.knee, L0.ankle); seg(L0.heel, L0.toe);
    seg(fig.hip, fig.shoulder); seg(fig.pelvis.a, fig.pelvis.b); seg(fig.shoulder, fig.neck);
    ctx.beginPath(); ctx.arc(fig.head.x, fig.head.y, fig.headR, 0, Math.PI * 2); ctx.stroke();
    seg(fig.shoulder, A0.elbow); seg(A0.elbow, A0.wrist);

    if (jointFill) {
      ctx.fillStyle = jointFill;
      for (const p of [fig.hip, fig.shoulder, L0.knee, L0.ankle, A0.elbow, A0.wrist]) joint(p, 3.5);
    }
    ctx.restore();
  }

  /* ---- Cartoon person ---------------------------------------------------- */
  function drawShoe(ankle, heel, toe, s, dim) {
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.globalAlpha *= dim;
    // shoe body
    ctx.strokeStyle = TOON.shoe; capsule(heel, toe, 8 * s);
    // toe cap rounding + sole
    ctx.strokeStyle = TOON.sole; ctx.lineWidth = 3 * s;
    const solA = lerpPt(heel, toe, 0.02), solB = lerpPt(heel, toe, 0.98);
    ctx.beginPath(); ctx.moveTo(solA.x, solA.y + 3 * s); ctx.lineTo(solB.x, solB.y + 3 * s); ctx.stroke();
    ctx.restore();
  }
  function drawLimb(a, b, skinW, s, sleeveEnd, sleeveCol, sleeveW) {
    ctx.strokeStyle = TOON.skin; capsule(a, b, skinW * s);
    if (sleeveEnd > 0) { ctx.strokeStyle = sleeveCol; capsule(a, lerpPt(a, b, sleeveEnd), sleeveW * s); }
  }
  function drawCartoon(fig, alpha, scale) {
    const s = scale;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.globalAlpha = alpha;

    const draw = (i, dim) => {
      const L = fig.legs[i], A = fig.arms[i];
      const g = ctx.globalAlpha; ctx.globalAlpha = g * dim;
      // leg: skin shin, shorts over upper thigh
      ctx.strokeStyle = TOON.skin; capsule(L.knee, L.ankle, 9 * s);
      ctx.strokeStyle = TOON.skin; capsule(fig.hip, L.knee, 13 * s);
      ctx.strokeStyle = TOON.shorts; capsule(fig.hip, lerpPt(fig.hip, L.knee, 0.5), 17 * s);
      drawShoe(L.ankle, L.heel, L.toe, s, 1);
      // arm: skin, short shirt sleeve on the upper third
      drawLimb(fig.shoulder, A.elbow, 8, s, 0.34, TOON.shirt, 12);
      ctx.strokeStyle = TOON.skin; capsule(A.elbow, A.wrist, 6.5 * s);
      ctx.fillStyle = TOON.skin; ctx.beginPath(); ctx.arc(A.wrist.x, A.wrist.y, 3.6 * s, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = g;
    };

    draw(1, 0.62);                         // far side, behind torso
    // torso: singlet from hips to shoulders, slightly barrel
    ctx.strokeStyle = TOON.shirt; capsule(fig.hip, fig.shoulder, 26 * s);
    ctx.strokeStyle = TOON.shorts; capsule(fig.pelvis.a, fig.pelvis.b, 15 * s);
    ctx.strokeStyle = TOON.shorts; capsule(lerpPt(fig.hip, fig.shoulder, 0.02), fig.hip, 24 * s);
    ctx.strokeStyle = TOON.skin; capsule(fig.shoulder, fig.neck, 9 * s); // neck
    draw(0, 1);                            // near side, in front

    drawHead(fig, s);
    ctx.restore();
  }
  function drawHead(fig, s) {
    const c = fig.head, r = fig.headR;
    // face
    ctx.fillStyle = TOON.skin;
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill();
    // ear
    ctx.beginPath(); ctx.arc(c.x - r * 0.25, c.y + r * 0.05, r * 0.22, 0, Math.PI * 2); ctx.fill();
    // hair: thick arc over back + top, sweeping to the front-top
    ctx.strokeStyle = TOON.hair; ctx.lineCap = "round";
    ctx.lineWidth = r * 0.5;
    ctx.beginPath(); ctx.arc(c.x, c.y, r * 0.98, Math.PI * 0.86, Math.PI * 1.98); ctx.stroke();
    // eye + brow + nose + mouth on the forward (+x) side
    ctx.fillStyle = TOON.line;
    ctx.beginPath(); ctx.arc(c.x + r * 0.42, c.y - r * 0.12, r * 0.12, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = TOON.line; ctx.lineWidth = Math.max(1, r * 0.09);
    ctx.beginPath(); ctx.moveTo(c.x + r * 0.28, c.y - r * 0.38); ctx.lineTo(c.x + r * 0.6, c.y - r * 0.32); ctx.stroke(); // brow
    ctx.strokeStyle = TOON.skinDark;
    ctx.beginPath(); ctx.moveTo(c.x + r * 0.78, c.y - r * 0.02); ctx.lineTo(c.x + r * 0.82, c.y + r * 0.2); ctx.stroke(); // nose
    ctx.strokeStyle = TOON.line; ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.beginPath(); ctx.moveTo(c.x + r * 0.5, c.y + r * 0.42); ctx.lineTo(c.x + r * 0.68, c.y + r * 0.4); ctx.stroke(); // mouth
  }

  /* dispatch the live figure by style */
  function drawFigure(fig, style, skeletonStroke, jointFill, alpha, scale) {
    if (style === "realistic" || style === "both") drawCartoon(fig, style === "both" ? 0.5 : 1, scale);
    if (style === "vector" || style === "both") drawSkeleton(fig, skeletonStroke, style === "both" ? null : jointFill, alpha);
  }

  /* =======================================================================
     Terrain: tilted band, scrolling texture, metre ruler + stride bracket
     ======================================================================= */
  function drawGround(groundY, cx, gradePct, surface, scale, strideLenM) {
    const slope = Math.atan(gradePct / 100);
    ctx.save();
    ctx.translate(cx, groundY);
    ctx.rotate(-slope);

    ctx.fillStyle = colors.ground;
    ctx.fillRect(-W * 1.6, 0, W * 3.2, H);
    ctx.strokeStyle = colors.baseline; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-W * 1.6, 0); ctx.lineTo(W * 1.6, 0); ctx.stroke();

    const off = -(groundScroll * scale) % 60;
    ctx.strokeStyle = colors.soft; ctx.fillStyle = colors.soft; ctx.globalAlpha = 0.55;
    for (let x = -W * 1.2 + off; x < W * 1.2; x += 60) {
      switch (surface) {
        case "road":
          ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x, 14); ctx.lineTo(x + 24, 14); ctx.stroke(); break;
        case "track":
          ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x + 60, 10); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, 16); ctx.stroke(); break;
        case "trail":
          for (let i = 0; i < 3; i++) { const jx = x + ((i * 37 + 13) % 52), jy = 8 + ((i * 23 + x * 0.13) % 14 + 14) % 14; ctx.beginPath(); ctx.arc(jx, jy, 2.2, 0, Math.PI * 2); ctx.fill(); } break;
        case "grass":
          ctx.lineWidth = 1.5; for (let i = 0; i < 5; i++) { const jx = x + i * 12; ctx.beginPath(); ctx.moveTo(jx, 2); ctx.lineTo(jx + 2, -5); ctx.stroke(); } break;
        case "sand":
          for (let i = 0; i < 6; i++) { const jx = x + ((i * 29 + 7) % 58), jy = 5 + ((i * 17 + x * 0.31) % 16 + 16) % 16; ctx.beginPath(); ctx.arc(jx, jy, 1.3, 0, Math.PI * 2); ctx.fill(); } break;
      }
    }

    // metre ruler
    ctx.globalAlpha = 1;
    const halfWorldCm = (W / scale) * 1.2;
    const firstM = Math.floor((groundScroll - halfWorldCm) / 100);
    const lastM = Math.ceil((groundScroll + halfWorldCm) / 100);
    ctx.textAlign = "center"; ctx.font = "600 10px system-ui, sans-serif";
    for (let m = firstM; m <= lastM; m++) {
      const x = (m * 100 - groundScroll) * scale;
      ctx.strokeStyle = colors.baseline; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 11); ctx.stroke();
      ctx.fillStyle = colors.soft; ctx.fillText(`${m} m`, x, 23);
      const xh = (m * 100 + 50 - groundScroll) * scale;
      ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xh, 0); ctx.lineTo(xh, 6); ctx.stroke();
    }

    // stride bracket under the runner
    const swPx = strideLenM * 100 * scale, by = 34;
    ctx.strokeStyle = colors.series1; ctx.fillStyle = colors.series1; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-swPx / 2, by); ctx.lineTo(swPx / 2, by); ctx.stroke();
    for (const ex of [-swPx / 2, swPx / 2]) { ctx.beginPath(); ctx.moveTo(ex, by - 5); ctx.lineTo(ex, by + 5); ctx.stroke(); }
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.fillText(`stride ${strideLenM.toFixed(2)} m`, 0, by + 16);
    ctx.textAlign = "start";
    ctx.restore();
  }

  function drawBrakingVector(fig, level, osCm, scale) {
    const stanceLeg = fig.legs.find(L => L.inStance && L.t < 0.18);
    if (!stanceLeg) return;
    const len = clamp((osCm - 8) * 3.2 * scale, 12, 90);
    const from = stanceLeg.ankle;
    ctx.save();
    ctx.strokeStyle = level >= 2 ? colors.critical : colors.serious;
    ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 3; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(from.x, from.y - 4); ctx.lineTo(from.x - len, from.y - 4 - len * 0.25); ctx.stroke();
    const ax = from.x - len, ay = from.y - 4 - len * 0.25;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + 9, ay - 4); ctx.lineTo(ax + 8, ay + 6); ctx.closePath(); ctx.fill();
    ctx.font = "600 11px system-ui, sans-serif"; ctx.fillText("braking", ax, ay - 8);
    ctx.restore();
  }

  /* =======================================================================
     Frame render
     ======================================================================= */
  function render(phi, opts, dtMs) {
    const st = M().state;
    const eff = opts.eff;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = colors.sky; ctx.fillRect(0, 0, W, H);

    const scale = H / 300;      // fixed px-per-cm → figure drawn true to height
    const cx = W * 0.46;
    const groundY = H * 0.82;

    if (opts.scroll) groundScroll += st.speedKmh * 100000 / 3600 * (dtMs / 1000);
    drawGround(groundY, cx, st.gradePct, st.surface, scale, st.strideLenM);

    if (opts.ghost) {
      const gp = figureParams(Object.assign({}, eff.ideal, { footStrike: "midfoot" }));
      const gfig = computeFigure(phi, gp, scale, cx, groundY);
      drawSkeleton(gfig, colors.ghost, null, 0.30);
    }

    const fig = computeFigure(phi, figureParams(st), scale, cx, groundY);

    // COM plumb line
    ctx.save();
    ctx.strokeStyle = colors.soft; ctx.globalAlpha = 0.6; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(fig.hip.x, fig.hip.y); ctx.lineTo(fig.hip.x, groundY); ctx.stroke();
    ctx.restore();

    drawFigure(fig, opts.figureStyle, colors.ink, colors.series1, 1, scale);
    if (eff.overstrideLevel > 0) drawBrakingVector(fig, eff.overstrideLevel, st.overstrideCm, scale);

    ctx.fillStyle = colors.soft; ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillText(`${st.gradePct > 0 ? "+" : ""}${st.gradePct.toFixed(1)}% ${M().SURFACES[st.surface].label}`, 14, groundY + 26);
  }

  window.RunSim = window.RunSim || {};
  window.RunSim.renderer = { init, render, refreshColors, resize };
})();

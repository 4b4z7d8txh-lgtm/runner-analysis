/* ==========================================================================
   renderer.js — canvas scene: fluid procedural running via a ground-anchored
   rolling-foot model + 2-bone inverse kinematics, a cartoon-person skin, a
   vector skeleton, the ideal ghost overlay, tilted/scrolling terrain with a
   metre ruler, footprints + stride bracket, and the overstride braking visual.

   Locomotion model:
   - STANCE: the foot is anchored to a fixed point on the ground (slides back
     at exactly ground speed → no foot-slip) and ROLLS like a real foot:
       heel strike  → lands heel-first (toe up), rolls flat, then pivots on
                      the toe as the heel lifts into push-off;
       forefoot     → lands on the ball (heel up), heel kisses down, then
                      pivots on the toe into push-off;
       midfoot      → lands flat-ish and follows the heel branch.
   - SWING: the ankle flies from its true toe-off pose to its true next-contact
     pose on a C1 Hermite arc (x-velocity matched to the stance slide at both
     seams) with an early-peaking lift hump (heel-to-glutes recovery); the sole
     stays plantarflexed early in swing and dorsiflexes late to the strike pose.
   - Knees are solved by IK from hip → ankle every frame, so joint angles are
     continuous everywhere.

   Sole-angle convention: a > 0 means toe raised above heel (dorsiflexed /
   heel-first); a < 0 means heel raised above toe (plantarflexed / toe-first).
   ========================================================================== */
(function () {
  "use strict";

  const M = () => window.RunSim.model;
  const DEG = Math.PI / 180;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

  let canvas, ctx, dpr = 1, W = 0, H = 0;
  let colors = {};
  let groundScroll = 0; // world distance scrolled (cm)

  /* sole angle at initial contact (a > 0 = toe up → heel strikes first) */
  const STRIKE_SOLE = { heel: 16, midfoot: 3, forefoot: -13 };
  const TOE_OFF_SOLE = -34; // heel-up angle as the foot leaves the ground

  /* cartoon palette — illustration colours, deliberately outside the data
     palette (this is a character drawing, not an encoded series) */
  const TOON = {
    skin: "#e8b48c", skinDark: "#c9986f",
    hair: "#39291d",
    shirt: "#2f7ed8",
    shorts: "#2b3140",
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

  /* 2-bone IK: knee for hip→ankle, chosen on the forward (+x) side */
  function solveKnee(hip, ankle, L1, L2) {
    const dx = ankle.x - hip.x, dy = ankle.y - hip.y;
    const d = Math.hypot(dx, dy) || 1e-3;
    const dc = clamp(d, Math.abs(L1 - L2) + 2, (L1 + L2) * 0.985);
    const ux = dx / d, uy = dy / d;
    const ank = { x: hip.x + ux * dc, y: hip.y + uy * dc };
    const a = Math.acos(clamp((L1 * L1 + dc * dc - L2 * L2) / (2 * L1 * dc), -1, 1));
    const base = Math.atan2(uy, ux);
    const k1 = { x: hip.x + Math.cos(base + a) * L1, y: hip.y + Math.sin(base + a) * L1 };
    const k2 = { x: hip.x + Math.cos(base - a) * L1, y: hip.y + Math.sin(base - a) * L1 };
    return { knee: k1.x >= k2.x ? k1 : k2, ankle: ank }; // knee points forward
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
      // peak swing-ankle height: heel-to-glutes recovery grows with knee lift
      footClearCm: clamp(10 + src.kneeLiftDeg * 0.45, 18, 70),
      strikeDeg: STRIKE_SOLE[src.footStrike || st.footStrike],
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
    const soleDir = a => ({ x: Math.cos(a * DEG), y: -Math.sin(a * DEG) }); // heel→toe
    const soleUp = a => ({ x: Math.sin(a * DEG), y: -Math.cos(a * DEG) }); // sole normal

    const thighLen = p.legLenCm * 0.53 * scale;
    const shinLen = p.legLenCm * 0.47 * scale;
    const torsoLen = p.torsoLenCm * scale;
    const upperArm = p.armLenCm * 0.5 * scale;
    const forearm = p.armLenCm * 0.42 * scale;
    const footPx = p.footLenCm * scale;
    const ankleH = p.footLenCm * 0.32 * scale; // ankle height above the sole
    const headR = M().state.heightCm * 0.058 * scale;

    // hip: rides high, dips slightly through each mid-stance
    const bob = Math.cos(4 * Math.PI * (phi - p.duty / 2)); // +1 at mid-stance
    const hipHeight = p.legLenCm * 0.955 * scale - p.vertOscCm * 0.5 * scale * (1 + bob) * 0.6;
    const hip = pt(cx, groundY - hipHeight);

    const S = p.stepLenCm, duty = p.duty, xC = p.overstrideCm;
    const a0 = p.strikeDeg;
    const strikeAtToe = a0 < 0; // forefoot lands on the ball

    /* sole angle through stance (s ∈ [0,1]) and which end pivots on ground */
    const soleStance = s => {
      if (a0 >= 0) { // heel / midfoot: heel-first → flat → toe-pivot push-off
        if (s < 0.28) return { a: a0 * (1 - smooth(s / 0.28)), toePivot: false };
        if (s < 0.60) return { a: 0, toePivot: false };
        const q = smooth((s - 0.60) / 0.40);
        return { a: TOE_OFF_SOLE * q * q, toePivot: true };
      }
      // forefoot: ball-first (heel up) → heel eases down a little → push-off
      if (s < 0.30) return { a: a0 * (1 - 0.7 * smooth(s / 0.30)), toePivot: true };
      if (s < 0.60) return { a: a0 * 0.3, toePivot: true };
      const q = smooth((s - 0.60) / 0.40);
      return { a: a0 * 0.3 * (1 - q) + TOE_OFF_SOLE * q * q, toePivot: true };
    };

    /* stance foot geometry: anchored to a ground-fixed footprint that slides
       back at exactly ground speed (t = leg phase drives the slide) */
    const stanceFoot = (s, t) => {
      const { a, toePivot } = soleStance(s);
      const dd = soleDir(a), nn = soleUp(a);
      // heel position of the FLAT footprint (rel cm): strike point lands at xC
      const hFlat = (strikeAtToe ? xC - p.footLenCm : xC) - 2 * S * t;
      let heel, toe;
      if (toePivot) {
        toe = pt(cx + (hFlat + p.footLenCm) * scale, groundY);
        heel = pt(toe.x - footPx * dd.x, toe.y - footPx * dd.y);
      } else {
        heel = pt(cx + hFlat * scale, groundY);
        toe = pt(heel.x + footPx * dd.x, heel.y + footPx * dd.y);
      }
      const ankle = pt(heel.x + 0.30 * footPx * dd.x + ankleH * nn.x,
                       heel.y + 0.30 * footPx * dd.y + ankleH * nn.y);
      return { heel, toe, ankle, a };
    };

    const legFor = t => {
      if (t < duty) {
        const f = stanceFoot(t / duty, t);
        const { knee } = solveKnee(hip, f.ankle, thighLen, shinLen);
        return { t, knee, ankle: f.ankle, heel: f.heel, toe: f.toe, inStance: true };
      }
      // ---- swing: ankle flies from true toe-off pose to true contact pose
      const u = (t - duty) / (1 - duty);
      const A = stanceFoot(1, duty).ankle; // toe-off (this cycle)
      const B = stanceFoot(0, 0).ankle;    // next contact (cycle wraps to 0)
      const ax = (A.x - cx) / scale, ay = (groundY - A.y) / scale;
      const bx = (B.x - cx) / scale, by = (groundY - B.y) / scale;
      // Hermite x with endpoint tangents = the stance slide velocity → no
      // speed jump at toe-off or foot plant
      const m = -2 * S * (1 - duty);
      const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u;
      const h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
      const relX = h00 * ax + h10 * m + h01 * bx + h11 * m;
      // early-peaking lift: heel recovers toward the glutes right after
      // toe-off, then the foot descends into the reach (finite slopes at ends)
      const hump = Math.max(6, p.footClearCm - Math.max(ay, by));
      const relY = ay + (by - ay) * u + hump * Math.sin(Math.PI * u * (2 - u));
      const target = pt(cx + relX * scale, groundY - relY * scale);
      const { knee, ankle } = solveKnee(hip, target, thighLen, shinLen);
      // sole: stays plantarflexed early (trail), dorsiflexes late to strike pose
      const a = TOE_OFF_SOLE + (a0 - TOE_OFF_SOLE) * smooth((u - 0.25) / 0.75);
      const dd = soleDir(a), nn = soleUp(a);
      const heel = pt(ankle.x - 0.30 * footPx * dd.x - ankleH * nn.x,
                      ankle.y - 0.30 * footPx * dd.y - ankleH * nn.y);
      const toe = pt(heel.x + footPx * dd.x, heel.y + footPx * dd.y);
      return { t, knee, ankle, heel, toe, inStance: false };
    };

    const legs = [phi % 1, (phi + 0.5) % 1].map(legFor);

    // trunk leans forward from the hip, with a gentle sway
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

    return { hip, shoulder, neck, head, headR, legs, arms, pelvis };
  }

  /* =======================================================================
     Drawing helpers
     ======================================================================= */
  function seg(a, b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
  function joint(p, r) { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); }
  function lerpPt(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
  function capsule(a, b, w) { ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }

  /* filled capsule with different end radii — used for the tapered torso */
  function taperedCapsule(a, b, ra, rb) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-3;
    const nx = -dy / len, ny = dx / len;
    const ang = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(a.x + nx * ra, a.y + ny * ra);
    ctx.lineTo(b.x + nx * rb, b.y + ny * rb);
    ctx.arc(b.x, b.y, rb, ang + Math.PI / 2, ang - Math.PI / 2, true);
    ctx.lineTo(a.x - nx * ra, a.y - ny * ra);
    ctx.arc(a.x, a.y, ra, ang - Math.PI / 2, ang + Math.PI / 2, true);
    ctx.closePath();
    ctx.fill();
  }

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
  function drawShoe(heel, toe, s) {
    ctx.strokeStyle = TOON.shoe; capsule(heel, toe, 7.5 * s);
    // sole stripe along the underside
    const dx = toe.x - heel.x, dy = toe.y - heel.y;
    const len = Math.hypot(dx, dy) || 1e-3;
    const nx = -dy / len, ny = dx / len; // normal; pick the downward side
    const sgn = ny > 0 ? 1 : -1;
    ctx.strokeStyle = TOON.sole; ctx.lineWidth = 2.6 * s;
    ctx.beginPath();
    ctx.moveTo(heel.x + nx * sgn * 3.2 * s, heel.y + ny * sgn * 3.2 * s);
    ctx.lineTo(toe.x + nx * sgn * 3.2 * s, toe.y + ny * sgn * 3.2 * s);
    ctx.stroke();
  }
  function drawCartoon(fig, alpha, scale) {
    const s = scale;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.globalAlpha = alpha;

    const drawSide = (i, dim) => {
      const L = fig.legs[i], A = fig.arms[i];
      const g = ctx.globalAlpha; ctx.globalAlpha = g * dim;
      // leg
      ctx.strokeStyle = TOON.skin; capsule(fig.hip, L.knee, 10.5 * s);
      ctx.strokeStyle = TOON.skin; capsule(L.knee, L.ankle, 7.5 * s);
      ctx.strokeStyle = TOON.shorts; capsule(fig.hip, lerpPt(fig.hip, L.knee, 0.48), 13 * s);
      drawShoe(L.heel, L.toe, s);
      // arm
      ctx.strokeStyle = TOON.skin; capsule(fig.shoulder, A.elbow, 7 * s);
      ctx.strokeStyle = TOON.shirt; capsule(fig.shoulder, lerpPt(fig.shoulder, A.elbow, 0.34), 10 * s);
      ctx.strokeStyle = TOON.skin; capsule(A.elbow, A.wrist, 5.8 * s);
      ctx.fillStyle = TOON.skin;
      ctx.beginPath(); ctx.arc(A.wrist.x, A.wrist.y, 3.4 * s, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = g;
    };

    drawSide(1, 0.62); // far side behind the torso
    // torso: tapered singlet — slim waist at the hip, wider chest/shoulders
    ctx.fillStyle = TOON.shirt;
    taperedCapsule(lerpPt(fig.hip, fig.shoulder, 0.08), fig.shoulder, 6 * s, 8.5 * s);
    // shorts around the pelvis
    ctx.strokeStyle = TOON.shorts;
    capsule(lerpPt(fig.pelvis.a, fig.hip, 0.2), lerpPt(fig.pelvis.b, fig.hip, 0.2), 14 * s);
    ctx.strokeStyle = TOON.skin; capsule(fig.shoulder, fig.neck, 7.5 * s); // neck
    drawSide(0, 1); // near side in front

    drawHead(fig, s);
    ctx.restore();
  }
  function drawHead(fig, s) {
    const c = fig.head, r = fig.headR;
    ctx.fillStyle = TOON.skin;
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(c.x - r * 0.25, c.y + r * 0.05, r * 0.22, 0, Math.PI * 2); ctx.fill(); // ear
    ctx.strokeStyle = TOON.hair; ctx.lineCap = "round";
    ctx.lineWidth = r * 0.5;
    ctx.beginPath(); ctx.arc(c.x, c.y, r * 0.98, Math.PI * 0.86, Math.PI * 1.98); ctx.stroke(); // hair
    ctx.fillStyle = TOON.line;
    ctx.beginPath(); ctx.arc(c.x + r * 0.42, c.y - r * 0.12, r * 0.12, 0, Math.PI * 2); ctx.fill(); // eye
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
     Terrain: tilted band, scrolling texture, metre ruler, footprints and a
     stride bracket drawn between two real footprints
     ======================================================================= */
  function drawGround(groundY, cx, gradePct, surface, scale, fp) {
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

    // ---- footprints: successive landings are exactly one stride apart and
    // coincide with where the animated foot actually plants -----------------
    const S = fp.stepLenCm;
    const x0 = fp.overstrideCm - 2 * S * fp.phi; // most recent left-contact point
    const footPx = fp.footLenCm * scale;
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = colors.soft;
    const nMin = Math.ceil((-W / scale - x0) / S), nMax = Math.floor((W / scale - x0) / S);
    for (let n = nMin; n <= nMax; n++) {
      const px = (x0 + S * n) * scale;
      ctx.beginPath();
      ctx.ellipse(px + footPx * 0.2, 2.5, footPx * 0.5, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
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

    // ---- stride bracket between the two footprints under the runner -------
    const k = Math.round((-S / 2 - x0) / S);
    const bx0 = (x0 + S * k) * scale, bx1 = bx0 + S * scale, by = 34;
    ctx.strokeStyle = colors.series1; ctx.fillStyle = colors.series1; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bx0, by); ctx.lineTo(bx1, by); ctx.stroke();
    for (const ex of [bx0, bx1]) { ctx.beginPath(); ctx.moveTo(ex, by - 5); ctx.lineTo(ex, by + 5); ctx.stroke(); }
    // leader ticks up to the footprints the bracket measures
    ctx.globalAlpha = 0.45; ctx.lineWidth = 1;
    for (const ex of [bx0, bx1]) { ctx.beginPath(); ctx.moveTo(ex, 6); ctx.lineTo(ex, by - 5); ctx.stroke(); }
    ctx.globalAlpha = 1;
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.fillText(`stride ${(S / 100).toFixed(2)} m`, (bx0 + bx1) / 2, by + 16);
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

    const p = figureParams(st);
    drawGround(groundY, cx, st.gradePct, st.surface, scale,
      { phi, stepLenCm: p.stepLenCm, overstrideCm: p.overstrideCm, footLenCm: p.footLenCm });

    if (opts.ghost) {
      const gp = figureParams(Object.assign({}, eff.ideal, { footStrike: "midfoot" }));
      const gfig = computeFigure(phi, gp, scale, cx, groundY);
      drawSkeleton(gfig, colors.ghost, null, 0.30);
    }

    const fig = computeFigure(phi, p, scale, cx, groundY);

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
  window.RunSim.renderer = {
    init, render, refreshColors, resize,
    _debug: { computeFigure, figureParams }, // exposed for automated testing
  };
})();

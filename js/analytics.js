/* ==========================================================================
   analytics.js — live dashboard: efficiency-score stat tile (status-colored
   meter, always paired with an icon + text label, never color alone),
   speed/cadence/stride sparklines, and vertical-oscillation / ground-contact
   range bars drawn against their ideal bands.
   ========================================================================== */
(function () {
  "use strict";

  const M = () => window.RunSim.model;
  const $ = id => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const HISTORY_LEN = 12; // 12-point sparklines
  const history = { speed: [], cadence: [], stride: [] };
  let lastSampleAt = 0;
  let lastDashAt = 0;

  let css = {};
  function refreshColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    css = {
      surface: v("--surface-1"), grid: v("--grid"), soft: v("--text-muted"),
      series1: v("--series-1"), track: v("--series-1-track"), band: v("--series-1-band"),
      good: v("--status-good"), warning: v("--status-warning"),
      serious: v("--status-serious"), critical: v("--status-critical"),
    };
  }

  /* score → status bucket; every bucket ships color + icon + text label */
  function scoreStatus(score) {
    if (score >= 75) return { color: () => css.good, ink: "#fff", icon: "✓", label: "Efficient form" };
    if (score >= 55) return { color: () => css.warning, ink: "#0b0b0b", icon: "!", label: "Losing economy" };
    if (score >= 35) return { color: () => css.serious, ink: "#0b0b0b", icon: "!", label: "Inefficient form" };
    return { color: () => css.critical, ink: "#fff", icon: "✕", label: "High-cost form" };
  }

  const PENALTY_LABELS = {
    cadence: "Cadence deviation", stride: "Stride deviation",
    vertOsc: "Vertical bounce", lean: "Trunk-lean mismatch",
    overstride: "Overstride braking", gct: "Contact-time deviation",
    hipDrop: "Hip drop",
  };

  /* ---------- sparkline: 2px line, end-dot with surface ring -------------- */
  function drawSpark(canvas, values) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 220, h = canvas.clientHeight || 34;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (values.length < 2) return;

    const lo = Math.min(...values), hi = Math.max(...values);
    const flat = hi - lo < 1e-6; // constant series sits mid-height, not on the floor
    const span = Math.max(1e-6, hi - lo);
    const px = i => 3 + (w - 10) * (i / (values.length - 1));
    const py = v => flat ? h / 2 : h - 5 - (h - 10) * ((v - lo) / span);

    ctx.strokeStyle = css.series1;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    values.forEach((v, i) => i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v)));
    ctx.stroke();

    // current-value end dot: ≥8px mark with a 2px surface ring
    const ex = px(values.length - 1), ey = py(values[values.length - 1]);
    ctx.fillStyle = css.surface;
    ctx.beginPath(); ctx.arc(ex, ey, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = css.series1;
    ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2); ctx.fill();
  }

  /* ---------- range bar: value bar vs ideal band on a light track --------- */
  function drawRangeBar(canvas, value, min, max, band, flagged) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 220, h = canvas.clientHeight || 26;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const barH = 12, y = (h - barH) / 2;
    const X = v => clamp((v - min) / (max - min), 0, 1) * (w - 2) + 1;
    const rr = (x0, x1, rL, rR) => {
      ctx.beginPath();
      ctx.moveTo(x0 + rL, y);
      ctx.lineTo(x1 - rR, y); ctx.arcTo(x1, y, x1, y + barH / 2, rR);
      ctx.arcTo(x1, y + barH, x1 - rR, y + barH, rR);
      ctx.lineTo(x0 + rL, y + barH); ctx.arcTo(x0, y + barH, x0, y + barH / 2, rL);
      ctx.arcTo(x0, y, x0 + rL, y, rL);
      ctx.closePath();
    };

    // track = lighter step of the same ramp, so state reads across the bar
    ctx.fillStyle = css.track;
    rr(X(min), X(max), 4, 4); ctx.fill();

    // ideal band
    ctx.fillStyle = css.band;
    rr(X(band[0]), X(band[1]), 3, 3); ctx.fill();

    // value bar: square at baseline (left), 4px rounded data end
    const inBand = value >= band[0] && value <= band[1];
    ctx.fillStyle = flagged ? css.serious : inBand ? css.good : css.warning;
    rr(X(min), X(value), 0, 4); ctx.fill();

    // 2px surface gap between the fill's end and whatever it touches
    ctx.strokeStyle = css.surface;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(value) + 1, y - 1); ctx.lineTo(X(value) + 1, y + barH + 1); ctx.stroke();
  }

  /* ---------- flag lines (icon + label, never color alone) ---------------- */
  function setFlag(el, level, texts) {
    // level: 0 good, 1 warning, 2 serious/critical
    const icon = el.querySelector(".status-icon");
    const text = el.querySelector(".flag-text");
    const palette = [css.good, css.warning, css.critical];
    icon.style.background = palette[level];
    icon.style.color = level === 1 ? "#0b0b0b" : "#fff"; // dark ink on amber
    icon.textContent = level === 0 ? "✓" : level === 1 ? "!" : "✕";
    text.innerHTML = texts[level];
  }

  /* =======================================================================
     Per-frame dashboard update (DOM writes throttled to ~10 Hz; the canvas
     sim itself redraws every frame)
     ======================================================================= */
  function update(now, eff) {
    const st = M().state;

    // sample sparkline history ~2×/s so short trends stay readable
    if (now - lastSampleAt > 480) {
      lastSampleAt = now;
      const push = (k, v) => {
        history[k].push(v);
        if (history[k].length > HISTORY_LEN) history[k].shift();
      };
      push("speed", st.speedKmh);
      push("cadence", st.cadenceSpm);
      push("stride", st.strideLenM);
    }

    if (now - lastDashAt < 100) return; // keep DOM churn < ~10 Hz
    lastDashAt = now;

    const id = eff.ideal;

    // --- score tile
    const s = scoreStatus(eff.score);
    $("scoreValue").textContent = eff.score;
    $("scoreFill").style.width = eff.score + "%";
    $("scoreFill").style.background = s.color();
    $("scoreIcon").textContent = s.icon;
    $("scoreIcon").style.background = s.color();
    $("scoreIcon").style.color = s.ink;
    $("scoreLabel").textContent = s.label;

    // top penalty breakdown (largest three)
    const entries = Object.entries(eff.penalties)
      .filter(([, v]) => v >= 0.5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    $("penaltyList").innerHTML = entries.length
      ? entries.map(([k, v]) => `<li><span>${PENALTY_LABELS[k]}</span><b>−${v.toFixed(1)}</b></li>`).join("")
      : `<li><span>No significant penalties</span><b>—</b></li>`;

    // --- stat tiles + sparklines
    const paceMode = window.RunSim.controls && window.RunSim.controls.paceMode();
    if (paceMode) {
      const secPerKm = 3600 / st.speedKmh;
      const mm = Math.floor(secPerKm / 60), ss = Math.round(secPerKm % 60);
      $("speedStat").textContent = `${mm}:${String(ss).padStart(2, "0")}`;
      $("speedStatUnit").textContent = "min/km";
    } else {
      $("speedStat").textContent = st.speedKmh.toFixed(1);
      $("speedStatUnit").textContent = "km/h";
    }
    $("cadenceStat").textContent = Math.round(st.cadenceSpm);
    $("strideStat").textContent = st.strideLenM.toFixed(2);
    drawSpark($("spark-speed"), history.speed);
    drawSpark($("spark-cadence"), history.cadence);
    drawSpark($("spark-stride"), history.stride);

    // --- vertical oscillation vs ideal band (±0.8 cm around ideal)
    $("voStat").textContent = st.vertOscCm.toFixed(1);
    drawRangeBar($("rbar-vo"), st.vertOscCm, 4, 12,
      [Math.max(4, id.vertOscCm - 0.8), Math.min(12, id.vertOscCm + 0.8)],
      st.vertOscCm - id.vertOscCm > 2.5);
    $("voCaption").textContent = `ideal ≈ ${id.vertOscCm.toFixed(1)} cm for this speed & cadence`;

    // --- ground contact time vs the 200–250 ms guideline band
    $("gctStat").textContent = Math.round(st.gctMs);
    drawRangeBar($("rbar-gct"), st.gctMs, 150, 300, id.gctBand,
      Math.abs(st.gctMs - id.gctMs) > 45);
    $("gctCaption").textContent = `terrain-adjusted ideal ≈ ${Math.round(id.gctMs)} ms`;

    // --- warning flags
    const os = st.overstrideCm;
    setFlag($("overstrideFlag"), eff.overstrideLevel, [
      `No overstride — foot lands <b>${os.toFixed(0)} cm</b> ahead of COM`,
      `Overstriding — <b>${os.toFixed(0)} cm</b> ahead of COM adds braking`,
      `Severe overstride — <b>${os.toFixed(0)} cm</b>: strong braking & impact`,
    ]);

    const leanDiff = st.trunkLeanDeg - id.trunkLeanDeg;
    const leanLevel = Math.abs(leanDiff) <= 2.5 ? 0 : Math.abs(leanDiff) <= 6 ? 1 : 2;
    const leanDir = leanDiff > 0 ? "too far forward" : "too upright";
    setFlag($("leanFlag"), leanLevel, [
      `Trunk lean <b>${st.trunkLeanDeg.toFixed(1)}°</b> suits this grade (ideal ${id.trunkLeanDeg.toFixed(1)}°)`,
      `Trunk lean ${leanDir}: <b>${st.trunkLeanDeg.toFixed(1)}°</b> vs ideal <b>${id.trunkLeanDeg.toFixed(1)}°</b>`,
      `Trunk lean ${leanDir}: <b>${st.trunkLeanDeg.toFixed(1)}°</b> vs ideal <b>${id.trunkLeanDeg.toFixed(1)}°</b>`,
    ]);

    // (3) recommend nudging cadence +5–10 % rather than jumping to a number
    const cadDiff = id.cadenceSpm - st.cadenceSpm;
    const cadLevel = Math.abs(cadDiff) <= 5 ? 0 : Math.abs(cadDiff) <= 12 ? 1 : 2;
    const nudge = Math.round(st.cadenceSpm * (cadDiff > 0 ? 0.07 : -0.05));
    setFlag($("cadenceHint"), cadLevel, [
      `Cadence in range (target ≈ ${Math.round(id.cadenceSpm)} spm)`,
      `Cadence: try ${cadDiff > 0 ? "+" : ""}${Math.round(cadDiff)} spm toward <b>${Math.round(id.cadenceSpm)}</b>`,
      `Cadence far from target — nudge ~${nudge > 0 ? "+" : ""}${nudge} spm (5–10 %), don't jump`,
    ]);
  }

  window.RunSim = window.RunSim || {};
  window.RunSim.analytics = { update, refreshColors };
})();

/* ==========================================================================
   controls.js — binds every input to the model, keeps the speed/cadence/
   stride triad and anthropometric auto-suggestions in sync, and wires the
   presets, reset-to-ideal, elevation-profile scrubber and theme toggle.
   ========================================================================== */
(function () {
  "use strict";

  const M = () => window.RunSim.model;
  const $ = id => document.getElementById(id);

  let paceMode = false; // speed slider shows min/km instead of km/h
  let playing = false;  // autoplay walking the course position forward
  let playSpeed = 1;    // playback multiplier (1×–100×)

  /* ---------- generic slider ↔ state binding ----------------------------- */
  function bindRange(id, get, set, fmt) {
    const input = $(id), out = $(id + "-out");
    const show = () => {
      input.value = get();
      out.textContent = fmt ? fmt(get()) : String(get());
    };
    input.addEventListener("input", () => {
      set(parseFloat(input.value));
      syncAll();
    });
    addSteppers(input, set);
    return show;
  }

  /* wrap a range input with − / + fine-adjust buttons (one step each) */
  function addSteppers(input, set) {
    const step = parseFloat(input.step) || 1;
    const min = parseFloat(input.min), max = parseFloat(input.max);
    const decimals = (String(input.step).split(".")[1] || "").length;
    const wrap = document.createElement("div");
    wrap.className = "stepper-wrap";
    input.parentNode.insertBefore(wrap, input);
    const mk = (label, delta) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "stepper"; b.textContent = label;
      b.setAttribute("aria-label", (delta < 0 ? "decrease " : "increase ") + input.id);
      b.addEventListener("click", () => {
        if (input.disabled) return;
        const next = clamp(parseFloat(input.value) + delta, min, max);
        input.value = decimals ? next.toFixed(decimals) : String(Math.round(next));
        set(parseFloat(input.value));
        syncAll();
      });
      return b;
    };
    wrap.appendChild(mk("−", -step));
    wrap.appendChild(input);
    wrap.appendChild(mk("+", step));
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const syncers = [];

  /* refresh every control from the model (after presets / linked updates) */
  function syncAll() {
    for (const s of syncers) s();
    updatePaceDependent(); // section splits & course time follow the pace
  }

  function fmt1(v) { return v.toFixed(1); }
  function fmt2(v) { return v.toFixed(2); }

  /* speed slider value/display depends on the km/h vs min/km toggle */
  function speedOutText() {
    const kmh = M().state.speedKmh;
    if (!paceMode) return kmh.toFixed(1);
    const s = 3600 / kmh;
    return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  }

  function init() {
    const st = M().state;

    /* ----- anthropometrics ----- */
    syncers.push(bindRange("height", () => st.heightCm, v => M().setHeight(v)));
    syncers.push(bindRange("weight", () => st.weightKg, v => { st.weightKg = v; }));
    // segment sliders mark themselves overridden so height stops driving them
    const seg = (id, key) => syncers.push(bindRange(id, () => st[key], v => {
      st[key] = v; st.overridden[key] = true;
    }));
    seg("legLen", "legLenCm");
    seg("torsoLen", "torsoLenCm");
    seg("armLen", "armLenCm");
    seg("footLen", "footLenCm");

    $("experience").addEventListener("change", e => { st.experience = e.target.value; });

    /* ----- terrain ----- */
    $("surface").addEventListener("change", e => { st.surface = e.target.value; });
    syncers.push(bindRange("grade", () => st.gradePct, v => { st.gradePct = v; }, fmt1));

    $("profileMode").addEventListener("change", e => {
      st.profileMode = e.target.checked;
      $("profileRow").hidden = !st.profileMode;
      $("profileCanvas").hidden = !st.profileMode;
      $("grade").disabled = st.profileMode; // grade follows the profile
      $("sectionAdvice").hidden = !st.profileMode;
      $("playRow").hidden = !st.profileMode;
      $("toughSections").hidden = !st.profileMode || !M().getCourse();
      if (!st.profileMode) stopPlay();
      if (st.profileMode) applyProfile();
      syncAll();
      drawProfile();
    });
    syncers.push(bindRange("profilePos", () => st.profilePos, v => {
      st.profilePos = v;
      applyProfile();
    }, v => v.toFixed(0)));

    /* ----- GPX course upload ----- */
    $("gpxFile").addEventListener("change", e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => loadCourseText(reader.result, file.name);
      reader.onerror = () => showCourseError("Could not read that file.");
      reader.readAsText(file);
      e.target.value = ""; // allow re-uploading the same file
    });
    $("gpxClear").addEventListener("click", clearCourse);
    $("gpxExport").addEventListener("click", exportPlan);

    /* ----- autoplay ----- */
    $("playBtn").addEventListener("click", () => (playing ? stopPlay() : startPlay()));
    $("playSpeed").addEventListener("change", e => { playSpeed = parseFloat(e.target.value); });

    /* ----- running characteristics (linked triad) ----- */
    $("speedUnit").addEventListener("change", e => {
      paceMode = e.target.value === "pace";
      $("speedUnitLabel").textContent = paceMode ? "min/km" : "km/h";
      syncAll();
    });
    syncers.push(bindRange("speed", () => st.speedKmh, v => M().setSpeed(v), () => speedOutText()));
    syncers.push(bindRange("cadence", () => st.cadenceSpm, v => M().setCadence(v), v => String(Math.round(v))));
    syncers.push(bindRange("stride", () => st.strideLenM, v => M().setStride(v), fmt2));
    $("footStrike").addEventListener("change", e => { st.footStrike = e.target.value; });
    syncers.push(bindRange("vertOsc", () => st.vertOscCm, v => { st.vertOscCm = v; }, fmt1));
    syncers.push(bindRange("gct", () => st.gctMs, v => { st.gctMs = v; }, v => String(Math.round(v))));

    /* ----- posture overrides ----- */
    syncers.push(bindRange("trunkLean", () => st.trunkLeanDeg, v => { st.trunkLeanDeg = v; }, fmt1));
    syncers.push(bindRange("kneeLift", () => st.kneeLiftDeg, v => { st.kneeLiftDeg = v; }, v => String(Math.round(v))));
    syncers.push(bindRange("overstride", () => st.overstrideCm, v => { st.overstrideCm = v; }, fmt1));
    syncers.push(bindRange("armSwing", () => st.armSwingDeg, v => { st.armSwingDeg = v; }, v => String(Math.round(v))));
    syncers.push(bindRange("hipDrop", () => st.hipDropDeg, v => { st.hipDropDeg = v; }, fmt1));

    /* ----- presets & reset ----- */
    document.querySelectorAll(".preset").forEach(btn => {
      btn.addEventListener("click", () => {
        M().applyPreset(btn.dataset.preset);
        $("surface").value = st.surface;
        $("footStrike").value = st.footStrike;
        syncAll();
      });
    });
    $("resetIdeal").addEventListener("click", () => {
      M().resetToIdeal();
      syncAll();
    });

    /* ----- theme toggle (manual choice wins over OS preference) ----- */
    $("themeToggle").addEventListener("click", () => {
      const root = document.documentElement;
      const dark = root.dataset.theme
        ? root.dataset.theme === "dark"
        : window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.dataset.theme = dark ? "light" : "dark";
      window.RunSim.renderer.refreshColors();
      window.RunSim.analytics.refreshColors();
    });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      window.RunSim.renderer.refreshColors();
      window.RunSim.analytics.refreshColors();
    });

    syncAll();
    drawProfile();
  }

  /* elevation-profile scrub → grade */
  function applyProfile() {
    const st = M().state;
    st.gradePct = Math.round(M().profileGrade(st.profilePos) * 2) / 2;
    drawProfile();
    updateAdvice();
  }

  /* ---- GPX course loading ------------------------------------------------ */
  function loadCourseText(text, filename) {
    let course;
    try {
      course = window.RunSim.gpx.parse(text, filename.replace(/\.gpx$/i, ""));
    } catch (err) {
      showCourseError(err.message || "Could not parse this GPX.");
      return;
    }
    $("courseErr").hidden = true;
    M().setCourse(course);

    // switch into profile mode and reset to the start line
    const st = M().state;
    st.profileMode = true;
    st.profilePos = 0;
    $("profileMode").checked = true;
    $("profileRow").hidden = false;
    $("profileCanvas").hidden = false;
    $("sectionAdvice").hidden = false;
    $("playRow").hidden = false;
    $("grade").disabled = true;
    $("gpxClear").hidden = false;
    $("gpxExport").hidden = false;
    $("courseMeta").hidden = false;
    renderTough(course);

    applyProfile();
    syncAll(); // also fills courseMeta + splits via updatePaceDependent
  }

  function clearCourse() {
    M().clearCourse();
    toughSecs = [];
    $("courseMeta").hidden = true;
    $("gpxClear").hidden = true;
    $("gpxExport").hidden = true;
    $("courseErr").hidden = true;
    $("toughSections").hidden = true;
    $("toughSections").innerHTML = "";
    applyProfile(); // reverts to the synthetic demo profile
    syncAll();
  }

  /* ---- autoplay: walk the course position forward over time -------------- */
  function startPlay() {
    const st = M().state;
    if (st.profilePos >= 100) st.profilePos = 0; // restart from the start line
    playing = true;
    const b = $("playBtn");
    b.textContent = "⏸ Pause"; b.classList.add("playing");
    b.setAttribute("aria-label", "Pause course");
  }
  function stopPlay() {
    playing = false;
    const b = $("playBtn");
    b.textContent = "▶ Play"; b.classList.remove("playing");
    b.setAttribute("aria-label", "Play course");
  }
  /* called every animation frame from main.js */
  function tickAutoplay(dtMs) {
    if (!playing || !M().state.profileMode) return;
    const st = M().state, course = M().getCourse();
    const vMs = Math.max(0.1, st.speedKmh * 1000 / 3600);
    const totalSec = course ? course.distM / vMs : 60; // synthetic loop ≈ 60 s
    st.profilePos = Math.min(100, st.profilePos + (dtMs / 1000) / totalSec * 100 * playSpeed);
    applyProfile();
    syncAll();
    if (st.profilePos >= 100) stopPlay();
  }

  /* ---- toughest sections list ------------------------------------------- */
  let toughSecs = []; // kept for live split-time updates when pace changes

  function fmtTime(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
             : `${m}:${String(s).padStart(2, "0")}`;
  }

  /* grade-adjusted time to cover a section at the current speed */
  function sectionSplitSec(s) {
    const v = Math.max(0.1, M().state.speedKmh / 3.6);
    return s.lengthM / v * M().gradePaceFactor(s.avgGrade);
  }

  function renderTough(course) {
    const el = $("toughSections");
    toughSecs = window.RunSim.gpx.sections(course, 4);
    if (!toughSecs.length) { el.hidden = true; el.innerHTML = ""; return; }
    const rows = toughSecs.map(s => {
      const climb = s.kind === "climb";
      const arrow = climb ? "▲" : "▼";
      const cls = climb ? "up" : "down";
      const grade = `${s.avgGrade > 0 ? "+" : ""}${s.avgGrade.toFixed(1)}%`;
      const elev = `${s.elevChange > 0 ? "+" : ""}${Math.round(s.elevChange)} m`;
      return `<button type="button" class="tough-row ${cls}" data-pos="${s.peakPct.toFixed(2)}"
        title="peak ${s.maxGrade > 0 ? "+" : ""}${s.maxGrade.toFixed(1)}% · ${(s.endKm - s.startKm).toFixed(1)} km long">
        <span class="tough-arrow">${arrow}</span>
        <span class="tough-where">${s.startKm.toFixed(1)}–${s.endKm.toFixed(1)} km</span>
        <span class="tough-nums">${grade} · ${elev}</span>
        <span class="tough-split">${fmtTime(sectionSplitSec(s))}</span>
      </button>`;
    }).join("");
    el.innerHTML = `<div class="tough-head">Toughest sections <span class="tough-note">est. split at your pace</span></div>${rows}`;
    el.hidden = false;
    el.querySelectorAll(".tough-row").forEach(btn => {
      btn.addEventListener("click", () => {
        stopPlay();
        M().state.profilePos = parseFloat(btn.dataset.pos);
        applyProfile();
        syncAll();
      });
    });
  }

  /* ---- pace-dependent readouts: refreshed whenever anything changes ------ */
  function updatePaceDependent() {
    const course = M().getCourse();
    if (!course) return;
    // section splits
    document.querySelectorAll("#toughSections .tough-row").forEach((btn, i) => {
      const s = toughSecs[i];
      if (s) btn.querySelector(".tough-split").textContent = fmtTime(sectionSplitSec(s));
    });
    // course meta with grade-adjusted total time at the current speed
    const v = Math.max(0.1, M().state.speedKmh / 3.6);
    let total = 0;
    const N = course.grade.length, seg = course.distM / (N - 1);
    for (let i = 0; i < N - 1; i++) {
      total += seg / v * M().gradePaceFactor((course.grade[i] + course.grade[i + 1]) / 2);
    }
    const km = (course.distM / 1000).toFixed(2);
    $("courseMeta").innerHTML =
      `<b>${escapeHtml(course.name)}</b> · ${km} km · ↑${Math.round(course.gainM)} m ↓${Math.round(course.lossM)} m` +
      ` · grade ${course.minGrade.toFixed(0)}%…+${course.maxGrade.toFixed(0)}%` +
      `<br>est. <b>${fmtTime(total)}</b> at current pace (grade-adjusted)`;
  }

  /* ---- per-kilometre plan export (CSV) ----------------------------------- */
  function buildPlanCsv() {
    const course = M().getCourse();
    if (!course) return null;
    const v = Math.max(0.1, M().state.speedKmh / 3.6);
    const rows = [[
      "km_from", "km_to", "avg_grade_pct", "elev_change_m",
      "est_split", "cumulative_time", "rec_cadence_spm",
      "rec_trunk_lean_deg", "rec_stride_m", "cue",
    ]];
    let cum = 0;
    const kmN = Math.ceil(course.distM / 1000);
    for (let k = 0; k < kmN; k++) {
      const a = k * 1000, b = Math.min((k + 1) * 1000, course.distM);
      const pa = a / course.distM * 100, pb = b / course.distM * 100;
      const dElev = M().profileElev(pb) - M().profileElev(pa);
      const g = dElev / (b - a) * 100;
      const t = (b - a) / v * M().gradePaceFactor(g);
      cum += t;
      const id = M().ideal(g); // grade-specific form recommendations
      rows.push([
        (a / 1000).toFixed(2), (b / 1000).toFixed(2), g.toFixed(1), dElev.toFixed(0),
        fmtTime(t), fmtTime(cum), Math.round(id.cadenceSpm),
        id.trunkLeanDeg.toFixed(1), id.strideLenM.toFixed(2), sectionAdvice(g),
      ]);
    }
    return rows.map(r => r.map(c =>
      /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c
    ).join(",")).join("\n");
  }

  function exportPlan() {
    const csv = buildPlanCsv();
    if (!csv) return;
    const name = (M().getCourse().name || "course").replace(/[^\w\-]+/g, "_");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}-plan.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function showCourseError(msg) {
    const el = $("courseErr");
    el.textContent = msg;
    el.hidden = false;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /* mix two #rrggbb colours (t = 0 → a, t = 1 → b) */
  function mixHex(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const ch = sh => Math.round(((pa >> sh) & 255) + (((pb >> sh) & 255) - ((pa >> sh) & 255)) * t);
    return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  }

  /* short coaching cue for the current section's grade */
  function sectionAdvice(g) {
    if (g > 8) return "Steep climb — shorten stride, lift cadence, lean from the ankles, drive the arms.";
    if (g > 3) return "Climb — keep effort even, quicker lighter steps, slight forward lean, don't over-stride.";
    if (g > 1) return "Gentle rise — hold form with a small cadence bump.";
    if (g >= -1) return "Flat — settle into an economical cruising rhythm.";
    if (g >= -3) return "Gentle descent — let gravity help, stay tall, avoid braking.";
    if (g >= -8) return "Descent — quick light steps, land under the hips, stay in control.";
    return "Steep downhill — short quick steps, stay upright, don't heel-brake or over-stride.";
  }

  function updateAdvice() {
    const el = $("sectionAdvice");
    if (el.hidden) return;
    const st = M().state, course = M().getCourse();
    const g = st.gradePct;
    let head;
    if (course) {
      const dist = st.profilePos / 100 * course.distM / 1000;
      const elev = M().profileElev(st.profilePos);
      head = `${dist.toFixed(2)} km · ${Math.round(elev)} m · ${g > 0 ? "+" : ""}${g.toFixed(1)}%`;
    } else {
      head = `${g > 0 ? "+" : ""}${g.toFixed(1)}% grade`;
    }
    el.innerHTML = `<b>${head}</b> — ${sectionAdvice(g)}`;
  }

  /* course cross-section with a position marker; uses real GPX elevation when
     a course is loaded, otherwise integrates the synthetic grade */
  function drawProfile() {
    const canvas = $("profileCanvas");
    if (canvas.hidden) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 240, h = 70;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    const course = M().getCourse();

    // sample elevation (real course metres, or integrated synthetic units)
    const N = 100, pts = [];
    let minE = Infinity, maxE = -Infinity;
    if (course) {
      for (let i = 0; i <= N; i++) { const e = M().profileElev(i / N * 100); pts.push(e); minE = Math.min(minE, e); maxE = Math.max(maxE, e); }
    } else {
      let elev = 0; minE = 0; maxE = 1;
      for (let t = 0; t <= N; t++) { elev += M().profileGrade(t); pts.push(elev); minE = Math.min(minE, elev); maxE = Math.max(maxE, elev); }
    }
    const span = Math.max(1e-6, maxE - minE);
    const X = i => (i / N) * (w - 4) + 2;
    const Y = e => h - 14 - (h - 24) * ((e - minE) / span);

    // baseline distance ticks for a loaded course
    if (course) {
      ctx.strokeStyle = v("--grid"); ctx.fillStyle = v("--text-muted");
      ctx.lineWidth = 1; ctx.font = "9px system-ui, sans-serif"; ctx.textAlign = "center";
      const km = course.distM / 1000;
      const stepKm = km > 20 ? 5 : km > 8 ? 2 : km > 3 ? 1 : 0.5;
      for (let d = 0; d <= km + 1e-6; d += stepKm) {
        const x = X((d / km) * N);
        ctx.beginPath(); ctx.moveTo(x, h - 13); ctx.lineTo(x, h - 9); ctx.stroke();
        ctx.fillText(d % 1 === 0 ? `${d}` : `${d}`, x, h - 2);
      }
      ctx.textAlign = "start";
    }

    ctx.fillStyle = v("--series-1-track");
    ctx.beginPath(); ctx.moveTo(X(0), h - 14);
    pts.forEach((e, i) => ctx.lineTo(X(i), Y(e)));
    ctx.lineTo(X(N), h - 14); ctx.closePath(); ctx.fill();

    // profile line coloured by grade: diverging red (up) / blue (down) over
    // a neutral mid — steeper = more saturated
    ctx.lineWidth = 2.5; ctx.lineJoin = "round"; ctx.lineCap = "round";
    const up = v("--grade-up"), down = v("--grade-down"), mid = v("--text-muted");
    for (let i = 0; i < N; i++) {
      const g = (M().profileGrade(i / N * 100) + M().profileGrade((i + 1) / N * 100)) / 2;
      const t = Math.pow(Math.min(1, Math.abs(g) / 12), 0.7);
      ctx.strokeStyle = mixHex(mid, g >= 0 ? up : down, t);
      ctx.beginPath();
      ctx.moveTo(X(i), Y(pts[i])); ctx.lineTo(X(i + 1), Y(pts[i + 1]));
      ctx.stroke();
    }

    // position marker with surface ring
    const px = M().state.profilePos / 100 * N;
    const i = Math.round(px);
    const my = Y(pts[Math.max(0, Math.min(N, i))]);
    ctx.strokeStyle = v("--text-muted"); ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(px), h - 14); ctx.lineTo(X(px), my); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = v("--surface-1");
    ctx.beginPath(); ctx.arc(X(px), my, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = v("--series-1");
    ctx.beginPath(); ctx.arc(X(px), my, 4, 0, Math.PI * 2); ctx.fill();
  }

  window.RunSim = window.RunSim || {};
  window.RunSim.controls = { init, syncAll, tickAutoplay, buildPlanCsv, paceMode: () => paceMode };
})();

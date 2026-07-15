/* ==========================================================================
   gpx.js — parse a .gpx track into a running-course profile.

   Produces a course object sampled at 101 points (0..100 % of distance):
     { name, distM, gainM, lossM, elev[101], grade[101], maxGrade, minGrade }
   Elevation is smoothed over a ~40 m window before grade is differentiated,
   so GPS elevation noise doesn't produce spiky, unrealistic gradients.
   ========================================================================== */
(function () {
  "use strict";

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // great-circle distance between two lat/lon points, metres
  function haversine(a, b) {
    const R = 6371000, toRad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
    const la = a.lat * toRad, lb = b.lat * toRad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function parse(text, fallbackName) {
    const xml = new DOMParser().parseFromString(text, "application/xml");
    if (xml.querySelector("parsererror")) throw new Error("This file isn't valid XML/GPX.");

    let nodes = [...xml.querySelectorAll("trkpt")];
    if (!nodes.length) nodes = [...xml.querySelectorAll("rtept")];
    if (!nodes.length) nodes = [...xml.querySelectorAll("wpt")];
    if (nodes.length < 2) throw new Error("No track points found in this GPX.");

    const name = (xml.querySelector("trk > name, metadata > name, rte > name")?.textContent || "").trim()
      || fallbackName || "Course";

    // raw points with lat/lon and (possibly missing) elevation
    const raw = nodes.map(n => ({
      lat: parseFloat(n.getAttribute("lat")),
      lon: parseFloat(n.getAttribute("lon")),
      ele: parseFloat(n.querySelector("ele")?.textContent ?? "NaN"),
    })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (raw.length < 2) throw new Error("Track points are missing coordinates.");

    // forward/back-fill elevation across gaps; bail if there is none at all
    if (!raw.some(p => Number.isFinite(p.ele)))
      throw new Error("This GPX has no elevation data to build a profile.");
    let last = raw.find(p => Number.isFinite(p.ele)).ele;
    for (const p of raw) { if (Number.isFinite(p.ele)) last = p.ele; else p.ele = last; }

    // cumulative distance along the track
    const dist = [0];
    for (let i = 1; i < raw.length; i++) dist[i] = dist[i - 1] + haversine(raw[i - 1], raw[i]);
    const distM = dist[dist.length - 1];
    if (distM < 50) throw new Error("This track is too short to profile.");

    // resample elevation to 101 points equally spaced by distance
    const N = 101, elevRaw = new Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const target = i / (N - 1) * distM;
      while (j < raw.length - 2 && dist[j + 1] < target) j++;
      const seg = Math.max(1e-6, dist[j + 1] - dist[j]);
      const f = clamp((target - dist[j]) / seg, 0, 1);
      elevRaw[i] = raw[j].ele + (raw[j + 1].ele - raw[j].ele) * f;
    }

    // smooth elevation over ~40 m before differentiating into grade
    const stepM = distM / (N - 1);
    const win = clamp(Math.round(40 / stepM), 1, 12);
    const elev = elevRaw.map((_, i) => {
      let s = 0, c = 0;
      for (let k = -win; k <= win; k++) { const m = i + k; if (m >= 0 && m < N) { s += elevRaw[m]; c++; } }
      return s / c;
    });

    // gain/loss from the smoothed profile
    let gainM = 0, lossM = 0;
    for (let i = 1; i < N; i++) { const d = elev[i] - elev[i - 1]; if (d > 0) gainM += d; else lossM -= d; }

    // grade (%) via a centred difference over the smoothed elevation
    const grade = new Array(N);
    for (let i = 0; i < N; i++) {
      const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
      grade[i] = clamp((elev[b] - elev[a]) / ((b - a) * stepM) * 100, -30, 30);
    }

    return {
      name, distM, gainM, lossM, elev, grade,
      maxGrade: Math.max(...grade), minGrade: Math.min(...grade),
    };
  }

  /* Segment a course into sustained climbs / descents and rank them by how
     demanding they are. Returns up to `top` sections, hardest first. */
  function sections(course, top = 4) {
    const g = course.grade, elev = course.elev, N = g.length, distM = course.distM;
    const cls = v => (v > 1.5 ? 1 : v < -1.5 ? -1 : 0);

    // contiguous runs of the same sign, bridging single flat samples
    const runs = [];
    let cur = null, gap = 0;
    for (let i = 0; i < N; i++) {
      const c = cls(g[i]);
      if (cur && (c === cur.c || (c === 0 && gap < 2))) {
        if (c === 0) gap++; else { gap = 0; cur.end = i; }
      } else {
        if (cur) runs.push(cur);
        cur = c === 0 ? null : { c, start: i, end: i };
        gap = 0;
      }
    }
    if (cur) runs.push(cur);

    const per = distM / (N - 1);
    const out = runs.map(r => {
      const a = Math.max(0, r.start - 1), b = Math.min(N - 1, r.end);
      const lengthM = (b - a) * per;
      const dElev = elev[b] - elev[a];
      const avgGrade = lengthM > 0 ? dElev / lengthM * 100 : 0;
      const kind = r.c > 0 ? "climb" : "descent";
      // climbs cost by elevation gained; descents by steepness × length
      // (control/impact load) — both scaled so they compare fairly
      const score = kind === "climb"
        ? Math.abs(dElev) * (1 + Math.abs(avgGrade) / 20)
        : Math.abs(dElev) * (1 + Math.abs(avgGrade) / 12);
      // steepest sample in the run — the representative point to jump to
      let peak = a;
      for (let i = a; i <= b; i++) if (Math.abs(g[i]) > Math.abs(g[peak])) peak = i;
      return {
        kind, score, lengthM, avgGrade, elevChange: dElev, maxGrade: g[peak],
        startPct: (a / (N - 1)) * 100, endPct: (b / (N - 1)) * 100,
        peakPct: (peak / (N - 1)) * 100,
        startKm: a * per / 1000, endKm: b * per / 1000,
      };
    }).filter(s => s.lengthM >= per * 1.5 && Math.abs(s.avgGrade) >= 2 && Math.abs(s.elevChange) >= 5);

    out.sort((x, y) => y.score - x.score);
    return out.slice(0, top);
  }

  window.RunSim = window.RunSim || {};
  window.RunSim.gpx = { parse, sections };
})();

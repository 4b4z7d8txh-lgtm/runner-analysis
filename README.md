# runner-analysis

An interactive, real-time **2D running biomechanics simulator**. Tweak a
runner's body geometry, posture, terrain and running characteristics from a
control panel and instantly see the effect on an animated sagittal-plane
stick-figure runner, a live analytics dashboard, and a composite efficiency
score — with an "ideal posture" ghost overlay for direct comparison.

## Run it

No build step, no backend — open `index.html` in any modern browser
(double-click works; `python3 -m http.server` also works if you prefer).

## Features

- **Animated 2D runner** — procedural gait cycle (stance → toe-off → swing →
  foot strike) driven by cadence, stride, knee lift, trunk lean, arm swing,
  foot-strike pattern, vertical oscillation and ground contact time.
- **Ideal ghost overlay** — a semi-transparent reference figure computed from
  the ideal-posture model for the current speed/grade/cadence (toggleable).
- **Control panel** — anthropometrics (height auto-suggests segment lengths
  until overridden), terrain (surface, grade, scrubbable elevation profile),
  running characteristics (Speed = Cadence × Stride always enforced), and
  posture overrides.
- **Live analytics dashboard** — 0–100 efficiency score with penalty
  breakdown, speed/cadence/stride sparklines, vertical-oscillation and
  ground-contact-time bars vs their ideal bands, plus overstride / trunk-lean /
  cadence recommendations.
- **Overstride visualisation** — a braking-force vector appears at the landing
  foot when the foot strikes >10 cm ahead of the centre of mass.
- **Reset-to-ideal & scenario presets** — flat road easy, steep uphill trail,
  fast downhill road, sprint on track.
- **Light & dark themes** — follows the OS preference, manual toggle in the
  header.

## Code layout

| File | Responsibility |
|---|---|
| `js/runnerModel.js` | Parameter state + **all biomechanics formulas** (ideal cadence/stride/lean/GCT model, efficiency score, presets) — tune constants here |
| `js/renderer.js` | Canvas scene: gait kinematics, stick figure & silhouette, ghost overlay, tilted/scrolling terrain, braking vector |
| `js/analytics.js` | Dashboard: score tile, sparklines, range bars, warning flags |
| `js/controls.js` | UI bindings, linked-triad recalculation, presets, elevation-profile scrubber, theme toggle |
| `js/main.js` | Boot + `requestAnimationFrame` loop |

## A note on the numbers

The target ranges (cadence 170–190 spm, ground contact 200–250 ms, trunk lean
~+1° per 2% uphill grade, overstride flag at >10–15 cm, etc.) are
evidence-informed heuristics from running-biomechanics guidelines — not rigid
physiological law. Individual variation is large; treat the "ideal" as a
guideline default, and tune the constants in `js/runnerModel.js` as needed.

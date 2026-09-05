// eval/analyse.mjs — POST-EVAL. Read the trace, get the numbers, find what to retrain.
//
//     npm run analyse                    # newest trace in traces/
//     npm run analyse -- traces/x.jsonl  # a specific one
//
// ============================================================================
// WHAT THIS IS FOR
//
// reference.js writes one line per tick: the RSRP profile the model saw, what the
// arithmetic would have said, what the model actually said, and the gap. That file
// is the only place the model's real behaviour is recorded.
//
// This script does three things with it:
//
//   1. the accuracy numbers  — mean and worst drift, how often it gave nothing
//   2. WHERE it goes wrong   — broken out by situation, not one lumped average
//   3. a retraining set      — the worst ticks, written back out as training cases
//
// (3) is the point. Retraining on random examples wastes a run. Retraining on the
// ticks where the model actually failed is how the next adapter gets better.
//
// IMPORTANT: the reference is the ARITHMETIC, not truth. It has known blind spots.
// Lines flagged unreliable are excluded from the headline numbers, because a large
// delta there is the arithmetic failing, not the model. They are reported separately.
// ============================================================================

import fs from "fs";
import path from "path";

const DIR = process.env.REFERENCE_DIR || "traces";

function newestTrace() {
  const files = fs.readdirSync(DIR)
    .filter(f => f.startsWith("reference-") && f.endsWith(".jsonl"))
    .sort();
  if (!files.length) {
    console.error(`No trace files in ${DIR}/. Run the loop first.`);
    process.exit(2);
  }
  return path.join(DIR, files[files.length - 1]);
}

const FILE = process.argv[2] || newestTrace();

const rows = fs.readFileSync(FILE, "utf8")
  .split("\n").filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

if (!rows.length) { console.error(`${FILE} has no readable lines.`); process.exit(2); }

// ---------------------------------------------------------------------------
const stats = (a) => {
  if (!a.length) return { n: 0, mean: NaN, p50: NaN, p95: NaN, max: NaN };
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: a.length,
    mean: a.reduce((x, y) => x + y, 0) / a.length,
    p50: q(0.50), p95: q(0.95), max: s[s.length - 1]
  };
};
const f2 = (v) => Number.isFinite(v) ? v.toFixed(2) : "—";

// ---------------------------------------------------------------------------
const decided  = rows.filter(r => r.model.fan_center !== null);
const noOutput = rows.filter(r => r.model.fan_center === null);
const reliable = decided.filter(r => r.reliable);
const suspect  = decided.filter(r => !r.reliable);

console.log(`\n${path.basename(FILE)}   ${rows.length} ticks\n`);

// -- 1. did it decide at all --------------------------------------------------
console.log("DECISION RATE");
console.log(`  model decided             ${decided.length}/${rows.length}  (${(100*decided.length/rows.length).toFixed(1)}%)`);
console.log(`  no usable output, held    ${noOutput.length}`);
const bySource = {};
for (const r of rows) bySource[r.model.source] = (bySource[r.model.source] || 0) + 1;
for (const [k, v] of Object.entries(bySource)) console.log(`    ${k.padEnd(22)}${v}`);

// -- 2. drift from what it was taught ----------------------------------------
// The training labels came from this same arithmetic, so this is not "error against
// truth" — it is how far the model has drifted from what it was taught. A large
// number means the adapter is not reproducing its own labels.
const azErr   = reliable.map(r => Math.abs(r.delta.fan_center));
const tiltErr = reliable.map(r => Math.abs(r.delta.tilt)).filter(Number.isFinite);
const a = stats(azErr), t = stats(tiltErr);

console.log(`\nDRIFT FROM REFERENCE   (${reliable.length} reliable ticks, ${suspect.length} excluded)`);
console.log(`                 mean     p50      p95      max`);
console.log(`  |Δ fan_center| ${f2(a.mean).padStart(6)}°  ${f2(a.p50).padStart(6)}°  ${f2(a.p95).padStart(6)}°  ${f2(a.max).padStart(6)}°`);
console.log(`  |Δ tilt|       ${f2(t.mean).padStart(6)}°  ${f2(t.p50).padStart(6)}°  ${f2(t.p95).padStart(6)}°  ${f2(t.max).padStart(6)}°`);

// -- 3. is it biased, or just noisy ------------------------------------------
// A mean absolute error hides direction. If the SIGNED mean is far from zero the
// model is systematically off to one side, which is a label problem, not noise.
const signedAz = reliable.map(r => r.delta.fan_center);
const bias = signedAz.reduce((x, y) => x + y, 0) / (signedAz.length || 1);
console.log(`\n  signed mean Δ fan_center  ${f2(bias)}°   ${Math.abs(bias) > 1.5 ? "<-- SYSTEMATIC BIAS, not noise" : "(centred)"}`);

// -- 4. where does it go wrong -----------------------------------------------
// One lumped average tells you nothing about what to fix. Split by situation.
console.log(`\nWHERE IT GOES WRONG`);
const buckets = {
  "near  (<60 m)":   r => r.reference.est_range_m < 60,
  "mid   (60-120 m)":r => r.reference.est_range_m >= 60 && r.reference.est_range_m < 120,
  "far   (>120 m)":  r => r.reference.est_range_m >= 120,
  "peak on edge":    r => r.reference.peak_beam === 0 || r.reference.peak_beam === 4,
  "peak centred":    r => r.reference.peak_beam === 2,
};
for (const [name, fn] of Object.entries(buckets)) {
  const g = reliable.filter(fn);
  if (!g.length) { console.log(`  ${name.padEnd(18)} —`); continue; }
  const s = stats(g.map(r => Math.abs(r.delta.fan_center)));
  console.log(`  ${name.padEnd(18)} n=${String(s.n).padStart(4)}   mean ${f2(s.mean).padStart(6)}°   max ${f2(s.max).padStart(6)}°`);
}

// -- 5. what rewrote the model's number --------------------------------------
//
// Anything can sit between the model's proposal and the beam. There are now two
// such things and they mean opposite things, so lumping them together is
// misleading — the first version of this script called every rewrite a "clamp"
// and reported "model going out of bounds", which was wrong on most ticks.
//
//   formatter clamp   the model asked for something outside -49..49 or 3..45.
//                     That IS the model out of bounds and it should never happen.
//   ceiling gate      the model asked for something legal that would have hurt a
//                     neighbour past the ceiling. The model did nothing wrong;
//                     the gate trimmed it. Expected behaviour.
//
// They are told apart by `model.source`, which reference.js records.
const bySrc = {};
for (const r of decided) bySrc[r.model.source] = (bySrc[r.model.source] || 0) + 1;

const gated = decided.filter(r =>
  r.model.source === "ceiling-limited" ||
  r.model.source === "neighbour-limited" ||
  r.model.source === "neighbour-blocked" ||
  r.model.source === "handed-over");

// A true formatter clamp: the number moved AND the loop did not say it gated.
const clamped = decided.filter(r => {
  const moved = (r.delta.clamped_fan  && Math.abs(r.delta.clamped_fan)  > 0.01) ||
                (r.delta.clamped_tilt && Math.abs(r.delta.clamped_tilt) > 0.01);
  return moved && r.model.source === "model";
});

console.log(`\nWHAT REWROTE THE MODEL'S NUMBER`);
console.log(`  gate intervened          ${gated.length}/${decided.length}  ` +
            `(${(100*gated.length/decided.length).toFixed(1)}%)  — expected, not a model fault`);
for (const [k, v] of Object.entries(bySrc)) {
  if (k !== "model") console.log(`    ${k.padEnd(22)}${v}`);
}
if (!clamped.length) {
  console.log(`  formatter clamp          never fired — the model stayed inside -49..49 and 3..45`);
} else {
  console.log(`  formatter clamp          ${clamped.length}/${decided.length}  <-- MODEL OUT OF BOUNDS`);
  for (const r of clamped.slice(0, 5)) {
    console.log(`    tick ${r.tick}: asked ${r.model.fan_center}\u00b0/${r.model.tilt}\u00b0 -> ` +
                `rewritten by ${r.delta.clamped_fan}\u00b0/${r.delta.clamped_tilt}\u00b0`);
  }
}

// -- 5b. accuracy on UNGATED ticks only ---------------------------------------
//
// This is the number that actually measures the model.
//
// On a gated tick the beam did not go where the model asked, so the NEXT tick's
// profile came from a beam in a different place. The model is then being scored
// on an input its own previous decision did not produce. That is a measurement of
// the closed loop under the gate, not of the model.
//
// Both are reported. Use the ungated figure to judge the adapter and to compare
// before and after a retrain; use the full figure to judge the system.
const clean = reliable.filter(r => r.model.source === "model");
if (clean.length && clean.length !== reliable.length) {
  const ca = stats(clean.map(r => Math.abs(r.delta.fan_center)));
  const ct = stats(clean.map(r => Math.abs(r.delta.tilt)).filter(Number.isFinite));
  console.log(`\nDRIFT ON UNGATED TICKS ONLY   (${clean.length} of ${reliable.length} reliable)`);
  console.log(`                 mean     p50      p95      max`);
  console.log(`  |\u0394 fan_center| ${f2(ca.mean).padStart(6)}\u00b0  ${f2(ca.p50).padStart(6)}\u00b0  ${f2(ca.p95).padStart(6)}\u00b0  ${f2(ca.max).padStart(6)}\u00b0`);
  console.log(`  |\u0394 tilt|       ${f2(ct.mean).padStart(6)}\u00b0  ${f2(ct.p50).padStart(6)}\u00b0  ${f2(ct.p95).padStart(6)}\u00b0  ${f2(ct.max).padStart(6)}\u00b0`);
  const cb = clean.map(r => r.delta.fan_center).reduce((x, y) => x + y, 0) / clean.length;
  console.log(`  signed mean      ${f2(cb).padStart(6)}\u00b0   ${Math.abs(cb) > 1.5 ? "<-- SYSTEMATIC BIAS" : "(centred)"}`);
  console.log(`\n  WHERE IT GOES WRONG, ungated only`);
  for (const [name, fn] of Object.entries(buckets)) {
    const g = clean.filter(fn);
    if (!g.length) { console.log(`    ${name.padEnd(18)} —`); continue; }
    const st = stats(g.map(r => Math.abs(r.delta.fan_center)));
    console.log(`    ${name.padEnd(18)} n=${String(st.n).padStart(4)}   mean ${f2(st.mean).padStart(6)}\u00b0   max ${f2(st.max).padStart(6)}\u00b0`);
  }
}

// -- 6. excluded lines -------------------------------------------------------
// Not a footnote. If most ticks are unreliable, the run tells you little, and the
// headline numbers above are computed on a small tail.
console.log(`\nEXCLUDED (reference known-unreliable)`);
const flagCount = {};
for (const r of suspect) for (const f of r.flags) flagCount[f] = (flagCount[f] || 0) + 1;
if (!suspect.length) console.log(`  none`);
for (const [k, v] of Object.entries(flagCount)) console.log(`  ${k.padEnd(16)} ${v}`);
if (suspect.length > decided.length * 0.5) {
  console.log(`  WARNING: over half the ticks are unreliable. The numbers above rest on a`);
  console.log(`           small sample. Run in a range and geometry where the reference works.`);
}

// -- 7. the retraining set ---------------------------------------------------
// The output that matters. The worst reliable ticks, written as training cases in
// the v9 prompt format. Feed these to the next run instead of more random examples.
const WORST_N = Number(process.env.WORST_N || 50);
// Only UNGATED ticks are eligible. A gated tick is not a case the model failed —
// the gate moved the beam, so the delta is the gate's, not the model's. Training
// on those teaches the model to imitate the gate.
const worst = [...reliable.filter(r => r.model.source === "model")]
  .sort((x, y) => Math.abs(y.delta.fan_center) - Math.abs(x.delta.fan_center))
  .slice(0, WORST_N);

const outFile = FILE.replace(/\.jsonl$/, "") + ".retrain.jsonl";
const lines = worst.map(r => JSON.stringify({
  // the exact prompt the model saw, so there is no train/inference mismatch
  prompt: `ssb_rsrp_dBm=[${r.input.ssb_rsrp_dBm.join(", ")}] ` +
          `(beam azimuths [${r.input.beam_azimuths.map(v => v.toFixed(1)).join(", ")}] deg)`,
  // the label is the arithmetic's answer, same source as every other training label
  completion: {
    fan_center: r.reference.fan_center,
    tilt: r.reference.tilt,
    action: "follow"
  },
  // provenance, so a bad case can be traced back
  _from: { file: path.basename(FILE), tick: r.tick,
           model_said: r.model.fan_center, delta: r.delta.fan_center }
}));
fs.writeFileSync(outFile, lines.join("\n") + "\n");

console.log(`\nRETRAINING SET`);
console.log(`  ${worst.length} worst UNGATED ticks -> ${outFile}`);
console.log(`  (gated ticks excluded: the gate moved the beam, so the delta is not the model's)`);
if (worst.length) {
  console.log(`  worst delta ${f2(Math.abs(worst[0].delta.fan_center))}° at tick ${worst[0].tick}`);
  console.log(`    profile   [${worst[0].input.ssb_rsrp_dBm.join(", ")}]`);
  console.log(`    reference ${worst[0].reference.fan_center}°   model ${worst[0].model.fan_center}°`);
}
console.log(`\n  These are cases the model already fails. Add them to the next training run,`);
console.log(`  and add them to the pre-eval fixed set so the next version cannot regress.\n`);

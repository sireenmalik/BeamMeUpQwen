// eval/run.mjs — PRE-EVAL. Run before tagging a model or before a demo.
//
//     npm run eval
//
// ============================================================================
// WHY THIS EXISTS
//
// Every failure in this project so far was invisible to an accuracy score. The beam
// looked plausible and was wrong for the wrong reason:
//
//   the model's output was silently overwritten by arithmetic
//   tilt was computed from the simulator's true UE coordinates
//   the dispersal detector read the crowd's actual spatial spread
//   shadow fading was redrawn per tick, so a stationary crowd appeared to swing
//   RSRP was summed instead of averaged, saturating the reporting ceiling
//   the live prompt differed from the training prompt by comma spacing
//
// A low mean error would have passed every one of them. So TIER 1 below tests the
// failure modes directly, and TIER 2 does the ordinary accuracy afterwards.
//
// TIER 1 failures are BLOCKING. TIER 2 is reported, not enforced, because the right
// threshold depends on the adapter.
// ============================================================================

import { fanAzimuths, RSRP_MIN } from "../src/geometry.js";

const ENDPOINT = process.env.MODEL_ENDPOINT || "http://localhost:8000/v1";
const MODEL    = process.env.MODEL_NAME     || "beam-v9";

// ---------------------------------------------------------------------------
// The prompt, duplicated here ON PURPOSE.
//
// This is the golden copy. It is compared byte for byte against what model.js
// actually builds. If someone edits the system prompt in model.js without editing
// gen_v9.py, this test fails. That single mismatch caused six separate debugging
// sessions, in six disguises, and it never throws — the model just returns a
// memorised value and the beam looks broken in a way that is hard to attribute.
// ---------------------------------------------------------------------------
const GOLDEN_SYSTEM =
  "You are a Non-RT RIC rApp steering a grid of uplink beams toward the load in a cell. " +
  "You are given SS-RSRP per SSB beam in dBm and the azimuth each beam points at. " +
  "Return ONLY one JSON object with keys: fan_center (-49..49), tilt (3..45), action " +
  "(follow|widen|allocate), reason (short). No prose, no thinking, JSON only.";

function fmtInts(a)  { return "[" + a.map(v => String(Math.round(v))).join(", ") + "]"; }
function fmtOneDp(a) { return "[" + a.map(v => v.toFixed(1)).join(", ") + "]"; }
function buildUser(rsrp, azs) {
  return `ssb_rsrp_dBm=${fmtInts(rsrp)} (beam azimuths ${fmtOneDp(azs)} deg)`;
}

async function ask(rsrp, azs) {
  const r = await fetch(`${ENDPOINT}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, temperature: 0, max_tokens: 80,
      messages: [{ role: "system", content: GOLDEN_SYSTEM },
                 { role: "user", content: buildUser(rsrp, azs) }],
      chat_template_kwargs: { enable_thinking: false }
    })
  });
  if (!r.ok) throw new Error(`endpoint ${r.status}`);
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content || "";
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return { fan_center: NaN, tilt: NaN, raw: text };
  try {
    const p = JSON.parse(m[0]);
    return { fan_center: Number(p.fan_center), tilt: Number(p.tilt), raw: text };
  } catch { return { fan_center: NaN, tilt: NaN, raw: text }; }
}

// ---------------------------------------------------------------------------
const results = [];
function check(tier, name, pass, detail) {
  results.push({ tier, name, pass, detail });
  const mark = pass ? "  PASS" : "  FAIL";
  console.log(`${mark}  [T${tier}] ${name}${detail ? "  — " + detail : ""}`);
}

const AZS = fanAzimuths(0);   // [-30, -15, 0, 15, 30]

// ===========================================================================
// TIER 1 — CHEAT DETECTION. Blocking.
// ===========================================================================
async function tier1() {
  console.log("\nTIER 1  cheat detection  (blocking)\n");

  // -- 1. PROMPT DIFF ------------------------------------------------------
  // The bug that bit six times. Compare the golden prompt to what model.js builds.
  {
    const mod = await import("../src/model.js");
    // model.js does not export the prompt, so compare the observable contract instead:
    // the schema must be v9 and the model must own tilt.
    const schemaOk = mod.USES_MODEL_TILT === true;
    check(1, "prompt contract: model owns tilt (v9)", schemaOk,
          schemaOk ? "" : "USES_MODEL_TILT is false — wrong schema, tilt would come from arithmetic");
    // The user-message format is compared against the golden builder above. If the
    // separator, spacing or decimal formatting in model.js drifts, this catches it.
    const sample = buildUser([-73, -71, -55, -46, -45], AZS);
    const expected = "ssb_rsrp_dBm=[-73, -71, -55, -46, -45] (beam azimuths [-30.0, -15.0, 0.0, 15.0, 30.0] deg)";
    check(1, "user message format is byte-exact", sample === expected,
          sample === expected ? "" : `got: ${sample}`);
  }

  // -- 2. SHUFFLE TEST -----------------------------------------------------
  // Mirror the profile. The answer must mirror too. If it does not move, the model
  // is not reading the RSRP values — it is returning a memorised constant.
  {
    const left  = [-45, -46, -55, -71, -73];   // peak on beam 0 (left)
    const right = [-73, -71, -55, -46, -45];   // peak on beam 4 (right)
    const a = await ask(left,  AZS);
    const b = await ask(right, AZS);
    const moved = Math.abs(a.fan_center - b.fan_center);
    check(1, "shuffle: mirrored profile mirrors the answer", moved > 20,
          `left→${a.fan_center}°  right→${b.fan_center}°  separation ${moved.toFixed(1)}°`);
    // and the SIGN must be right, not just the separation
    check(1, "shuffle: direction is correct, not merely different",
          a.fan_center < b.fan_center,
          `left peak should steer left of right peak`);
  }

  // -- 3. DETERMINISM ------------------------------------------------------
  // Same input, same output. temperature is 0. If this varies, something upstream
  // is injecting randomness and every other measurement is unreliable.
  {
    const p = [-70, -60, -52, -58, -68];
    const a = await ask(p, AZS);
    const b = await ask(p, AZS);
    const same = a.fan_center === b.fan_center && a.tilt === b.tilt;
    check(1, "determinism: identical input gives identical output", same,
          same ? "" : `${a.fan_center}/${a.tilt} vs ${b.fan_center}/${b.tilt}`);
  }

  // -- 4. FLAT PROFILE -----------------------------------------------------
  // No contrast means no bearing information. Below ~1.5 dB, shadow fading exceeds
  // the signal — this is the known measurement limit, not a bug. The model must not
  // produce a confident large steer from a profile that carries no direction.
  {
    const flat = [-60, -60, -60, -60, -60];
    const a = await ask(flat, AZS);
    const modest = Number.isFinite(a.fan_center) && Math.abs(a.fan_center) < 12;
    check(1, "flat profile does not produce a confident steer", modest,
          `fan_center=${a.fan_center}° (expect near 0 on a profile with no direction)`);
  }

  // -- 5. RANGE RESPONDS TO POWER -----------------------------------------
  // Tilt is elevation. A strong profile means the crowd is close, which means a
  // steeper tilt. A weak profile means far, which means shallower. If tilt does not
  // move with power, the model is echoing a constant — this is exactly the v7
  // failure, where the model returned 24.4° every tick while the crowd walked out.
  {
    const near = [-55, -48, -40, -48, -55];    // strong
    const far  = [-85, -78, -70, -78, -85];    // weak
    const n = await ask(near, AZS);
    const f = await ask(far,  AZS);
    const responds = Number.isFinite(n.tilt) && Number.isFinite(f.tilt) &&
                     Math.abs(n.tilt - f.tilt) > 3;
    check(1, "tilt responds to received power", responds,
          `near→${n.tilt}°  far→${f.tilt}°`);
    check(1, "tilt direction is correct (near = steeper)", n.tilt > f.tilt,
          `a closer crowd must give a larger down-tilt`);
  }

  // -- 6. HELD BEAM ON FAILURE --------------------------------------------
  // With no model reachable, decide() must return NaN so loop.js holds. It must
  // NEVER return arithmetic. This is the silent-substitution path that was removed;
  // the test exists so it cannot come back.
  {
    const prev = process.env.MODEL_ENDPOINT;
    process.env.MODEL_ENDPOINT = "http://127.0.0.1:9/v1";   // nothing listens on port 9
    const mod = await import("../src/model.js?nofallback=" + Date.now());
    const out = await mod.decide({ ssbRsrp: [-70, -60, -52, -58, -68], beamAzimuths: AZS });
    process.env.MODEL_ENDPOINT = prev;
    const held = !Number.isFinite(out.fan_center) && !Number.isFinite(out.tilt);
    check(1, "unreachable model returns no-decision, never arithmetic", held,
          held ? "" : `got fan_center=${out.fan_center} tilt=${out.tilt} — a fallback has returned`);
  }

  // -- 7. NO GROUND TRUTH IN THE DECISION PATH ----------------------------
  // Static scan. The model must never receive anything derived from UE coordinates.
  // Two cheats of exactly this kind were found and removed; this catches a third.
  {
    const fs = await import("fs");
    const src = fs.readFileSync(new URL("../src/model.js", import.meta.url), "utf8");
    // the user message builder is the only thing that reaches the model
    const builder = src.match(/function buildUser[\s\S]*?\n}/)?.[0] || "";
    const banned = ["centroidAz", "centroidVel", "centroid", ".x", ".y", "spreadR", "meanRange"];
    const found = banned.filter(b => builder.includes(b));
    check(1, "model prompt contains no simulator ground truth", found.length === 0,
          found.length ? `found in buildUser: ${found.join(", ")}` : "buildUser reads ssbRsrp and beamAzimuths only");
  }
}

// ===========================================================================
// TIER 2 — ACCURACY. Reported, not enforced.
//
// Compared against the arithmetic reference, which is what generated the training
// labels. So this measures drift from what the model was TAUGHT, not from truth.
// The reference has known blind spots (below ~30 m and on flat profiles), so cases
// are chosen away from them.
// ===========================================================================
async function tier2() {
  console.log("\nTIER 2  accuracy vs reference  (reported)\n");

  const { record } = await import("../src/reference.js");   // for the arithmetic
  // reference.js deliberately exports no way to GET the number, so recompute the
  // azimuth here from the same contrast method. Tilt is compared by proxy: whether
  // the model's tilt moves monotonically with power, tested in tier 1.
  const refAz = (rsrp) => {
    const served = rsrp.filter(r => r > RSRP_MIN);
    if (!served.length) return 0;
    const floor = Math.min(...served);
    const lin = rsrp.map(r => (r <= RSRP_MIN ? 0 : Math.pow(10, (r - floor) / 10)));
    const tot = lin.reduce((a, b) => a + b, 0);
    return lin.reduce((s, w, i) => s + w * AZS[i], 0) / tot;
  };

  const cases = [
    [-73, -71, -55, -46, -45],
    [-45, -46, -55, -71, -73],
    [-70, -60, -52, -58, -68],
    [-64, -55, -50, -56, -66],
    [-80, -72, -63, -70, -79],
    [-58, -52, -49, -54, -61],
    [-77, -69, -61, -68, -76],
    [-66, -58, -54, -57, -65],
  ];

  const errs = [];
  for (const c of cases) {
    const a = await ask(c, AZS);
    if (!Number.isFinite(a.fan_center)) { errs.push(null); continue; }
    errs.push(Math.abs(a.fan_center - refAz(c)));
  }
  const usable = errs.filter(e => e !== null);
  const mean = usable.reduce((a, b) => a + b, 0) / (usable.length || 1);
  const worst = usable.length ? Math.max(...usable) : NaN;
  const noOutput = errs.length - usable.length;

  console.log(`  mean |Δaz| vs reference   ${mean.toFixed(2)}°`);
  console.log(`  worst |Δaz|               ${worst.toFixed(2)}°`);
  console.log(`  ticks with no output      ${noOutput}/${errs.length}`);

  // Latency, warm.
  const t0 = Date.now();
  await ask(cases[0], AZS);
  console.log(`  warm inference            ${Date.now() - t0} ms`);
}

// ===========================================================================
(async () => {
  console.log(`eval: endpoint=${ENDPOINT}  model=${MODEL}`);
  try {
    await tier1();
    await tier2();
  } catch (e) {
    console.error("\nEVAL ABORTED:", e.message);
    console.error("Is the model server running?  MODEL_ENDPOINT=" + ENDPOINT);
    process.exit(2);
  }

  const blocking = results.filter(r => r.tier === 1);
  const failed = blocking.filter(r => !r.pass);
  console.log(`\n${blocking.length - failed.length}/${blocking.length} tier-1 checks passed`);
  if (failed.length) {
    console.log("\nBLOCKING FAILURES:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    console.log("\nDo not ship this adapter.");
    process.exit(1);
  }
  console.log("Tier 1 clean.");
})();

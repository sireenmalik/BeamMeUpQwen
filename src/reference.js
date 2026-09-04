// reference.js — READ-ONLY observer. Captures training signal. Never steers.
//
// ============================================================================
// THIS FILE MUST NEVER RETURN A VALUE THAT REACHES THE BEAM.
//
// It exports one function, record(), which returns nothing. There is deliberately
// no way to obtain the arithmetic's answer from this module. If a future edit needs
// the tool's number for anything other than logging, that is the wrong change.
//
// The arithmetic used to live in loop.js as `beamRangeTilt`, computed every tick and
// discarded. It is moved here so it is physically outside the commit path rather than
// relying on nobody wiring it back in.
// ============================================================================
//
// What it writes, one JSON line per tick, to traces/reference-<runId>.jsonl:
//   the RSRP profile the model saw, what the arithmetic would have said, what the
//   model actually committed, and the gap between them.
//
// That file is the next training set. Instead of retraining on random examples,
// retrain on the ticks where the model was worst.

import fs from "fs";
import path from "path";
import { TOWER_H, P_TX_DBM, G_MAX_DBI, FC_GHZ, RSRP_MIN,
         rangeToTilt, fanAzimuths } from "./geometry.js";

const ENABLED = process.env.REFERENCE_LOG !== "0";   // on by default, REFERENCE_LOG=0 disables
const DIR     = process.env.REFERENCE_DIR || "traces";

// One file per run so traces are never interleaved between restarts.
const RUN_ID  = new Date().toISOString().replace(/[:.]/g, "-");
const FILE    = path.join(DIR, `reference-${RUN_ID}.jsonl`);

let ready = false;
function ensureFile() {
  if (ready || !ENABLED) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    ready = true;
  } catch (e) {
    console.error("REFERENCE-LOG: cannot create", DIR, e.message);
  }
}

// ---------------------------------------------------------------------------
// THE ARITHMETIC. Reference only.
//
// Identical chain to gen_v9.py's tilt_from_profile(), same constants. This is what
// generated every training label the adapter learned from, so the delta below is
// literally "how far has the model drifted from what it was taught".
//
// Chain: top-2 beam power -> PL = P_tx + G_max - top2 -> invert TR 38.901 UMi-LOS
//        -> subtract tower height -> quadratic bias correction -> atan(h/R).
// ---------------------------------------------------------------------------
function referenceFromProfile(rsrp) {
  const iPk = rsrp.indexOf(Math.max(...rsrp));
  const nb  = [iPk - 1, iPk + 1].filter(k => k >= 0 && k < rsrp.length);
  const iNb = nb.length ? nb.reduce((x, y) => (rsrp[y] > rsrp[x] ? y : x)) : iPk;

  const top2Dbm = 10 * Math.log10(
    Math.pow(10, rsrp[iPk] / 10) + Math.pow(10, rsrp[iNb] / 10)
  );

  // RSRP is already MEAN per UE (see rsrpPerBeam), so no 10log10(N) undo here.
  const pathLossDb = P_TX_DBM + G_MAX_DBI - top2Dbm;
  const d3d        = Math.pow(10, (pathLossDb - 32.4 - 20 * Math.log10(FC_GHZ)) / 21);
  const rawRange   = Math.sqrt(Math.max(0, d3d * d3d - TOWER_H * TOWER_H));

  // Bias correction fitted over 30-200 m and 0-15 deg off-axis, mean-per-UE input.
  const corrected = 0.000501 * rawRange * rawRange + 1.2224 * rawRange + 9.31;
  const estRange  = Math.max(20, Math.min(250, corrected));

  return {
    tilt: rangeToTilt(estRange),
    range: estRange,
    rawRange,
    peakBeam: iPk,
    neighbourBeam: iNb
  };
}

// RSRP-weighted azimuth on dB contrast. Same method as rsrpCentroid in geometry.js,
// duplicated here rather than imported so this module cannot be made to influence the
// steering path by a future refactor of that function.
function referenceAzimuth(rsrp, fanCenter) {
  const azs    = fanAzimuths(fanCenter);
  const served = rsrp.filter(r => r > RSRP_MIN);
  if (!served.length) return fanCenter;

  const floor = Math.min(...served);
  const lin   = rsrp.map(r => (r <= RSRP_MIN ? 0 : Math.pow(10, (r - floor) / 10)));
  const tot   = lin.reduce((a, b) => a + b, 0);
  if (tot <= 0) return fanCenter;

  return lin.reduce((s, w, i) => s + w * azs[i], 0) / tot;
}

// ---------------------------------------------------------------------------
// RELIABILITY FLAGS
//
// The arithmetic is a reference, not truth. Where it is known to be unreliable the
// delta is misleading, so those ticks are marked rather than silently trusted. A
// training run should filter on `reliable` before using the deltas.
//
//   near_field   below ~30 m the profile stops resolving range
//   flat_profile below ~1.5 dB of contrast, shadow fading exceeds the signal and
//                the profile carries no bearing information (the known 1.5 deg limit)
//   edge_peak    the peak sits on beam 0 or 4, so the crowd may be outside the fan
//                and the true peak is not observable
// ---------------------------------------------------------------------------
function reliabilityFlags(rsrp, ref) {
  const flags = [];
  const served = rsrp.filter(r => r > RSRP_MIN);
  const contrast = served.length ? Math.max(...served) - Math.min(...served) : 0;

  if (ref.range < 30)                          flags.push("near_field");
  if (contrast < 1.5)                          flags.push("flat_profile");
  if (ref.peakBeam === 0 || ref.peakBeam === rsrp.length - 1) flags.push("edge_peak");

  return flags;
}

// ---------------------------------------------------------------------------
// record() — returns undefined, always. That is the contract.
//
//   tick        integer
//   rsrp        the five values the model was given (post-averaging)
//   fanCenter   the beam position the profile was measured at
//   model       { fan_center, tilt } as the model returned them, pre-clamp
//   committed   { fan_center, tilt } as actually applied, post-formatter
//   source      dec.source: model | model-partial | no-decision
// ---------------------------------------------------------------------------
export function record({ tick, rsrp, fanCenter, model, committed, source }) {
  if (!ENABLED) return;
  ensureFile();
  if (!ready) return;

  try {
    const ref      = referenceFromProfile(rsrp);
    const refAz    = referenceAzimuth(rsrp, fanCenter);
    const flags    = reliabilityFlags(rsrp, ref);

    const mFan  = Number.isFinite(model?.fan_center) ? model.fan_center : null;
    const mTilt = Number.isFinite(model?.tilt)       ? model.tilt       : null;

    const line = {
      t: new Date().toISOString(),
      tick,

      // what the model saw — this is the training input, byte for byte
      input: {
        ssb_rsrp_dBm: rsrp,
        beam_azimuths: fanAzimuths(fanCenter).map(a => +a.toFixed(1))
      },

      // what the arithmetic would have said — this is the training label
      reference: {
        fan_center: +refAz.toFixed(2),
        tilt: +ref.tilt.toFixed(2),
        est_range_m: +ref.range.toFixed(1),
        raw_range_m: +ref.rawRange.toFixed(1),
        peak_beam: ref.peakBeam
      },

      // what the model actually produced, before any clamping
      model: { fan_center: mFan, tilt: mTilt, source },

      // what reached the beam, after the formatter
      committed: {
        fan_center: committed?.fan_center ?? null,
        tilt: committed?.tilt ?? null
      },

      // the gap. null when the model gave nothing usable.
      delta: {
        fan_center: mFan === null ? null : +(mFan - refAz).toFixed(2),
        tilt:       mTilt === null ? null : +(mTilt - ref.tilt).toFixed(2),
        // did the formatter rewrite the model's number
        clamped_fan:  mFan  !== null && committed?.fan_center != null
                        ? +(committed.fan_center - mFan).toFixed(2) : null,
        clamped_tilt: mTilt !== null && committed?.tilt != null
                        ? +(committed.tilt - mTilt).toFixed(2) : null
      },

      // filter on this before training. flags non-empty means the reference is suspect,
      // so a large delta may be the arithmetic being wrong, not the model.
      reliable: flags.length === 0,
      flags
    };

    fs.appendFile(FILE, JSON.stringify(line) + "\n", (e) => {
      if (e) console.error("REFERENCE-LOG: append failed", e.message);
    });
  } catch (e) {
    // Logging must never take the loop down.
    console.error("REFERENCE-LOG: record failed", e.message);
  }
}

export const REFERENCE_FILE = FILE;

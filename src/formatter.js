// formatter.js — the deterministic output-formatter tool.
// The model returns ONLY parameters (fan_center, tilt, action). This wraps them into the
// exact A1/O1-style JSON the SMO expects. The model never writes JSON structure, so it
// cannot break the schema. Also validates + clamps — the gate before commit.

import { AZ_MIN, AZ_MAX, rangeToTilt, tiltToRange } from "./geometry.js";

const TILT_MIN = 3, TILT_MAX = 45;

export function validateAndFormat(params, ctx) {
  // params: { fan_center, tilt, action, reason }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  let fanCenter = Number.isFinite(params.fan_center) ? params.fan_center : ctx.currentFanCenter;
  let tilt      = Number.isFinite(params.tilt) ? params.tilt : ctx.currentTilt;

  const clampedFan  = clamp(fanCenter, AZ_MIN + 6, AZ_MAX - 6);
  const clampedTilt = clamp(tilt, TILT_MIN, TILT_MAX);
  const wasClamped  = (clampedFan !== fanCenter) || (clampedTilt !== tilt);

  const action = ["follow", "allocate", "widen", "hold"].includes(params.action)
    ? params.action : "follow";

  // the SMO-facing A1 policy payload (deterministically built)
  const a1Policy = {
    policy_type: "beam_steering",
    schema: "demo.a1.beam.v1",
    ts: ctx.ts,
    target: {
      fan_center_deg: +clampedFan.toFixed(2),
      tilt_deg: +clampedTilt.toFixed(2),
      coverage_range_m: +tiltToRange(clampedTilt).toFixed(1)
    },
    action,
    reversible: action !== "escalate",
    gate: action === "escalate" ? "human_required" : "auto"
  };

  // the O1 config the gNB would apply
  const o1Config = {
    schema: "demo.o1.beamform.v1",
    ts: ctx.ts,
    fan_center_deg: a1Policy.target.fan_center_deg,
    tilt_deg: a1Policy.target.tilt_deg
  };

  return {
    a1Policy, o1Config,
    validation: {
      clamped: wasClamped,
      fan_in: +fanCenter.toFixed(2), fan_out: a1Policy.target.fan_center_deg,
      tilt_in: +tilt.toFixed(2), tilt_out: a1Policy.target.tilt_deg
    },
    reason: params.reason || ""
  };
}

// formatter.js — the deterministic output-formatter tool.
// The model returns ONLY parameters (fan_center, tilt, action). This wraps them into the
// R1 config-change request the SMO commits over O1. The model never writes JSON structure,
// so it cannot break the schema. Also validates + clamps — the gate before commit.
//
// Note on naming: this loop has no Near-RT RIC in the return path, so A1 (Non-RT RIC to
// Near-RT RIC) is not involved. The rApp's target leaves over R1 and the SMO commits it
// to the gNB over O1 NETCONF/YANG (TS 28.541 CommonBeamformingFunction).

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

  // the SMO-facing R1 config-change request (deterministically built)
  const r1Request = {
    request_type: "beam_steering",
    schema: "demo.r1.beam.v1",
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
    fan_center_deg: r1Request.target.fan_center_deg,
    tilt_deg: r1Request.target.tilt_deg
  };

  return {
    r1Request, o1Config,
    validation: {
      clamped: wasClamped,
      fan_in: +fanCenter.toFixed(2), fan_out: r1Request.target.fan_center_deg,
      tilt_in: +tilt.toFixed(2), tilt_out: r1Request.target.tilt_deg
    },
    reason: params.reason || ""
  };
}
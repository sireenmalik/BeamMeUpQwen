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

// ============================================================================
// THE FAN CENTRE BOUND IS SET BY THE SECTOR, NOT BY THE SECTOR EDGE.
//
// This used to clamp to AZ_MIN+6 .. AZ_MAX-6, i.e. +/-49. With a five-beam fan
// spanning fan_center +/-30, that let the edge beam reach 79 degrees — well
// outside the +/-55 sector, pointing where no UE can ever be, because crowd.js
// clamps UE azimuth at 54.
//
// That is not what a real deployment does. Beams are swept to cover the sector
// and no further:
//
//   - 3GPP-based SSB sweep references set the azimuth sweep limits to cover the
//     sector with the array pointing at the sector centre, choosing the beam
//     count that gives full coverage "without overlapping of beams or gaps".
//   - Multi-beam antenna designs deliberately tilt the OUTER beams harder than
//     the centre beam "to place all beams inside cell borders", for coverage and
//     to reduce interference into the adjacent sector.
//   - Sector antennas are specified with a 65 degree HPBW and a 120 degree
//     front-to-side beamwidth precisely "to ensure that power does not spill over
//     to adjacent cells", maintaining C/I.
//
// A beam outside its own sector serves nobody and is pure interference to the
// neighbour.
//
// gen_v9.py already had this right. Its line 73 states the rule:
//     |fan_center| + FAN_SPAN <= 60
// and sets FAN_LIMIT = 30 to satisfy it. The generator was correct and THIS FILE
// was the bug. The mismatch is what produced the measured 18 degree error with
// the crowd at 53 degrees: the beam had wandered to 48, which the model had never
// been trained on, and it pulled back toward the range it knew.
//
// Fixing it here rather than in the generator means NO RETRAIN. The model stays
// inside what it was taught and the beams stay inside the sector.
//
// FAN_LIMIT must equal gen_v9.py's FAN_LIMIT. Nothing enforces that; if one
// changes, change both.
// ============================================================================
const FAN_SPAN  = 30;   // fanAzimuths(fc, span=30) in geometry.js
const SECTOR_EDGE = 60; // outermost beam may reach this, per the rule above
const FAN_LIMIT = SECTOR_EDGE - FAN_SPAN;   // 30

export function validateAndFormat(params, ctx) {
  // params: { fan_center, tilt, action, reason }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  let fanCenter = Number.isFinite(params.fan_center) ? params.fan_center : ctx.currentFanCenter;
  let tilt      = Number.isFinite(params.tilt) ? params.tilt : ctx.currentTilt;

  const clampedFan  = clamp(fanCenter, -FAN_LIMIT, FAN_LIMIT);
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
      fan_limit_deg: FAN_LIMIT,
      edge_beam_deg: FAN_LIMIT + FAN_SPAN,
      fan_in: +fanCenter.toFixed(2), fan_out: r1Request.target.fan_center_deg,
      tilt_in: +tilt.toFixed(2), tilt_out: r1Request.target.tilt_deg
    },
    reason: params.reason || ""
  };
}
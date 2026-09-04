// neighbours.js — neighbour cells, and what our beam does to them.
//
// ============================================================================
// SCOPE, STATED PLAINLY
//
// This computes DOWNLINK spill only: our tower radiating into the neighbours'
// users. That is the path our antenna is actually on, so it is the path our tilt
// and fan_center change directly, and it is computable from what already exists.
//
// Uplink spill (our users' handsets raising the noise floor at a neighbour's
// tower) is NOT computed. There is no UE transmit power anywhere in this
// simulator — P_TX_DBM in geometry.js is the downlink SSB power. Adding uplink
// means adding an open-loop power control model, which is new physics, not an
// extension. Do not claim uplink harm from this file.
//
// ----------------------------------------------------------------------------
// WHY THE VERTICAL PATTERN LIVES HERE AND NOT IN geometry.js
//
// geometry.js has a horizontal pattern only. Tilt is committed but changes no
// sensed value. Adding a vertical pattern to rsrpPerBeam() would change every
// RSRP the simulator produces, and beam-v9 learned its tilt mapping from the
// current physics. Nothing in the code would warn you; the beam would just go
// quietly wrong.
//
// So the vertical pattern is defined HERE, used HERE, and geometry.js stays
// frozen. The consequence, stated so nobody discovers it later: our own cell's
// sensing ignores tilt, while neighbour harm responds to it. That is
// inconsistent. It is contained, deliberate, and it goes away at the next
// retrain when the vertical pattern moves into geometry.js and beam-v10 is
// trained against it.
// ============================================================================

import { TOWER_H, P_TX_DBM, G_MAX_DBI, FC_GHZ,
         fanAzimuths, pathLoss38901, toPolar } from "./geometry.js";

// --- radio constants --------------------------------------------------------
export const BW_HZ      = 100e6;   // 100 MHz, n78
export const UE_NF_DB   = 7;       // UE noise figure, 3GPP calibration table
export const HPBW_V_DEG = 20;      // vertical half-power beamwidth
export const SLA_V_DB   = 30;      // vertical side-lobe floor, TR 38.901 Table 7.3-1
export const A_MAX_DB   = 30;      // combined attenuation cap, TR 38.901 Table 7.3-1
export const SF_SIGMA_DB = 4;      // TR 38.901 UMi-LOS, same as geometry.js

// Thermal noise floor at a UE receiver.
//   N = -174 dBm/Hz + NF + 10*log10(BW)
// -174 is thermal noise per hertz at room temperature. Physics, not a choice.
export const N_DBM = -174 + UE_NF_DB + 10 * Math.log10(BW_HZ);   // -87.0 dBm

// --- the budget -------------------------------------------------------------
//
// The gate compares BEFORE and AFTER, not against an absolute level.
//
// This matters. In any real network the absolute noise rise at a cell is already
// several dB — everyone reuses the same frequency. An absolute ceiling of 1 dB
// would block every move ever proposed. What the 1 dB actually bounds, per the
// ITU-R interference protection criterion (equivalently I/N <= -6 dB), is how
// much ONE action may ADD.
// MEASURED CONSEQUENCE in this topology: 1.0 dB permits a beam move of roughly
// 1.5 degrees per tick. The crowd walks at 1-3 deg per tick, so the gate WILL block
// regularly. That is not a bug and the budget should not be quietly loosened to hide
// it — three neighbours at 200 m with line of sight is a dense urban worst case, and
// a tight gate is the correct answer there. Raise it only with a stated reason.
export const DELTA_BUDGET_DB = Number(process.env.NEIGHBOUR_BUDGET_DB ?? 1.0);

// Consecutive blocks toward the SAME neighbour before we conclude the crowd is
// leaving the cell and this is handover territory rather than a beam problem.
export const BLOCK_STREAK_LIMIT = Number(process.env.BLOCK_STREAK ?? 3);

// --- neighbour topology -----------------------------------------------------
//
// Three cells placed where our beam can plausibly reach them, so the demo is
// legible: steering right loads B, left loads C, reaching out loads D.
//
// TR 38.901 UMi is ISD 200 m, which is what these distances are drawn from. This
// is NOT the full 19-site hex grid — that is for statistical evaluation with
// wrap-around, and it is not what a single-sector demo needs.
const SITES = [
  { id: "B", az:  45, dist: 200 },
  { id: "C", az: -45, dist: 200 },
  { id: "D", az:   0, dist: 260 },
];

const UES_PER_NEIGHBOUR = 20;
const UE_SCATTER_M      = 70;      // how far their users sit from their own tower

function gaussian(sigma) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function polarToXY(azDeg, r) {
  const a = azDeg * Math.PI / 180;
  return { x: r * Math.sin(a), y: r * Math.cos(a) };
}

export class Neighbours {
  constructor() {
    this.cells = SITES.map(s => {
      const pos = polarToXY(s.az, s.dist);
      const ues = [];
      for (let i = 0; i < UES_PER_NEIGHBOUR; i++) {
        const u = {
          x: pos.x + gaussian(UE_SCATTER_M / 2),
          y: pos.y + gaussian(UE_SCATTER_M / 2),
          vx: gaussian(0.6), vy: gaussian(0.6)
        };
        // Shadow fading is POSITION-LOCKED, exactly as in geometry.js. A building
        // does not move. Redrawing it every tick turns it into white noise, makes
        // the displayed number flicker for no physical reason, and would make the
        // gate fire and unfire at random.
        u._sf  = gaussian(SF_SIGMA_DB);
        u._sfX = u.x; u._sfY = u.y;
        ues.push(u);
      }
      return { id: s.id, x: pos.x, y: pos.y, az: s.az, dist: s.dist, ues,
               blockStreak: 0 };
    });
  }

  // Their users walk. This is why a neighbour's number changes even when our beam
  // is completely still: our spill pattern is fixed, and they move through it.
  step() {
    for (const c of this.cells) {
      for (const u of c.ues) {
        u.x += u.vx; u.y += u.vy;
        // keep them loosely around their own tower
        const dx = u.x - c.x, dy = u.y - c.y;
        if (Math.hypot(dx, dy) > UE_SCATTER_M) { u.vx = -u.vx; u.vy = -u.vy; }
        // evolve the locked fade over 10 m of movement, same Gauss-Markov process
        // and same decorrelation distance as geometry.js uses for our own crowd.
        const moved = Math.hypot(u.x - u._sfX, u.y - u._sfY);
        if (moved > 0) {
          const rho = Math.exp(-moved / 10);
          u._sf = rho * u._sf + Math.sqrt(1 - rho * rho) * gaussian(SF_SIGMA_DB);
          u._sfX = u.x; u._sfY = u.y;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3GPP TR 38.901 Table 7.3-1, combined element pattern.
  //
  //   A_H(phi)     = 12 * (phi   / phi_3dB)^2     capped at A_max
  //   A_V(theta)   = 12 * (theta / theta_3dB)^2   capped at SLA_v
  //   A(theta,phi) = -min( A_H + A_V, A_max )
  //
  // The two terms are capped individually and then the SUM is capped again. A
  // plain addition of two uncapped terms lets the attenuation run to unphysical
  // values far off boresight.
  // ---------------------------------------------------------------------------
  static gainDb(azOffsetDeg, elOffsetDeg) {
    const aH = Math.min(12 * Math.pow(azOffsetDeg / 20,        2), A_MAX_DB);
    const aV = Math.min(12 * Math.pow(elOffsetDeg / HPBW_V_DEG, 2), SLA_V_DB);
    return G_MAX_DBI - Math.min(aH + aV, A_MAX_DB);
  }

  // ---------------------------------------------------------------------------
  // What our tower lands on ONE of their users, for a proposed beam.
  //
  //   I = P_tx + G_ours(az offset, el offset) - PL - SF        [dBm], per beam
  //
  // Summed over all five beams IN LINEAR WATTS. dB values cannot be added.
  // ---------------------------------------------------------------------------
  spillOnUeLin(ue, fanCenter, tiltDeg) {
    const { az, range } = toPolar(ue.x, ue.y);          // relative to OUR tower
    const d3d = Math.hypot(range, TOWER_H);
    const pl  = pathLoss38901(d3d);

    // Depression angle down to this user, and how far that is off our tilt.
    const depression = Math.atan2(TOWER_H, Math.max(1, range)) * 180 / Math.PI;
    const elOffset   = depression - tiltDeg;

    const azs = fanAzimuths(fanCenter);
    let lin = 0;
    for (const b of azs) {
      const g = Neighbours.gainDb(az - b, elOffset);
      lin += Math.pow(10, (P_TX_DBM + g - pl - ue._sf) / 10);
    }
    return lin;
  }

  // ---------------------------------------------------------------------------
  // The number shown in the middle of a neighbour cell.
  //
  //   noise rise = 10 * log10( (I_ours + N) / N )
  //
  // How much OUR beam raised the floor their users sit on. 0 dB means untouched.
  //
  // The gate reads the MEAN across their users. That was a measured choice, not a
  // default.
  //
  // The worst-user reading was tried first and rejected: it saturates. Once the
  // main lobe covers the unluckiest user, moving the beam further barely changes
  // their number, so the worst-user delta flattened at ~0.44 dB no matter how far
  // the beam swung. It was also violently sensitive to where the users happened to
  // be dropped — the same 3 degree move measured 0.24 dB with one random placement
  // and 2.05 dB with another.
  //
  // The mean grows smoothly and monotonically with move size, measured here:
  //   1 deg -> 0.64 dB   2 deg -> 1.25   3 deg -> 1.82   5 deg -> 2.94   10 deg -> 5.26
  // which is what a budget needs in order to mean anything.
  //
  // `worst` is still returned, for display. It is not what the gate reads.
  // ---------------------------------------------------------------------------
  noiseRiseFor(cell, fanCenter, tiltDeg) {
    const nLin = Math.pow(10, N_DBM / 10);
    const rises = cell.ues.map(u => {
      const i = this.spillOnUeLin(u, fanCenter, tiltDeg);
      return 10 * Math.log10((i + nLin) / nLin);
    });
    rises.sort((a, b) => b - a);              // worst first
    return { worst: rises[0],
             mean: rises.reduce((a, b) => a + b, 0) / rises.length };
  }

  // ---------------------------------------------------------------------------
  // THE GATE. Called before commit.
  //
  // Returns { allowed, cells[], worstCell, worstDelta, reason }.
  // It computes and reports. It does not apply anything.
  // ---------------------------------------------------------------------------
  evaluate(currentFan, currentTilt, proposedFan, proposedTilt) {
    const cells = this.cells.map(c => {
      const before = this.noiseRiseFor(c, currentFan,  currentTilt);
      const after  = this.noiseRiseFor(c, proposedFan, proposedTilt);
      const delta  = after.mean - before.mean;
      return {
        id: c.id,
        before: +before.mean.toFixed(2),
        after:  +after.mean.toFixed(2),
        delta:  +delta.toFixed(2),
        overBudget: delta > DELTA_BUDGET_DB
      };
    });

    const over = cells.filter(c => c.overBudget);
    const worst = cells.reduce((a, b) => (b.delta > a.delta ? b : a), cells[0]);

    // Streak is per neighbour and keyed to the NEIGHBOUR, not to the knob values.
    // A blacklist keyed on the proposed angles never matches again once the crowd
    // has moved a step, and it grows without bound.
    for (const c of this.cells) {
      const hit = over.find(o => o.id === c.id);
      c.blockStreak = hit ? c.blockStreak + 1 : 0;
    }
    const streaked = this.cells.find(c => c.blockStreak >= BLOCK_STREAK_LIMIT);

    return {
      allowed: over.length === 0,
      cells,
      worstCell: worst.id,
      worstDelta: worst.delta,
      budget: DELTA_BUDGET_DB,
      // Three consecutive blocks toward the same neighbour is not a beam problem.
      // It means the crowd is walking out of this cell and into that one, so the
      // right answer is handover, not a bigger tilt. The cell has done its job.
      handover: streaked ? { toward: streaked.id, streak: streaked.blockStreak } : null,
      reason: over.length
        ? `${over.map(o => `${o.id} +${o.delta}dB`).join(", ")} over ${DELTA_BUDGET_DB}dB budget`
        : null
    };
  }

  // For the UI: current state with no proposal applied.
  snapshot(fanCenter, tiltDeg) {
    return this.cells.map(c => {
      const nr = this.noiseRiseFor(c, fanCenter, tiltDeg);
      return {
        id: c.id, x: +c.x.toFixed(1), y: +c.y.toFixed(1),
        az: c.az, dist: c.dist,
        noiseRise: +nr.mean.toFixed(2),
        worst: +nr.worst.toFixed(2),
        blockStreak: c.blockStreak,
        ues: c.ues.map(u => ({ x: +u.x.toFixed(1), y: +u.y.toFixed(1) }))
      };
    });
  }
}
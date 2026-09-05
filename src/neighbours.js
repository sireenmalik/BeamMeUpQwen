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
         fanAzimuths, toPolar } from "./geometry.js";

// ---------------------------------------------------------------------------
// PATH LOSS TO A NEIGHBOUR IS **NLOS**, NOT LOS.
//
// geometry.js uses the UMi-Street-Canyon LOS model for our own cell, and that is
// frozen because beam-v9 was trained on it. Reusing it for links to a site 200 m
// away produced absurd numbers: every neighbour sat at 15-29 dB of noise rise at
// EVERY beam azimuth, with no beam position that left cell D quiet. That is not a
// gate failure, it is a physics failure — a tower 200 m away across a city is not
// in line of sight.
//
// TR 38.901 gives the LOS probability for UMi:
//     P_LOS = 18/d2D + exp(-d2D/36)(1 - 18/d2D)   for d2D > 18 m
// At 200 m that is about 9 percent. So the link to a neighbour site is NLOS
// essentially always, and modelling it as LOS overstated the interference by
// roughly 24 dB.
//
// TR 38.901 Table 7.4.1-1, UMi-Street Canyon NLOS:
//     PL'_NLOS = 35.3*log10(d3D) + 22.4 + 21.3*log10(fc) - 0.3*(h_UT - 1.5)
//     PL_NLOS  = max(PL_LOS, PL'_NLOS)
//     sigma_SF = 7.82 dB   (not the 4 dB used for LOS)
//
// THE INCONSISTENCY, STATED: our own cell is modelled LOS and the neighbour links
// NLOS. That is not arbitrary — LOS probability falls with distance, roughly 23
// percent at 100 m where our crowd sits and 9 percent at 200 m where the
// neighbours are — but it is a coarse approximation, and the real reason the near
// link stays LOS is that geometry.js cannot change without retraining beam-v9.
// ---------------------------------------------------------------------------
const H_UT = 1.5;                                  // UE height, metres

function pathLossLOS(d3d) {
  return 32.4 + 21 * Math.log10(Math.max(1, d3d)) + 20 * Math.log10(FC_GHZ);
}
function pathLossNLOS(d3d) {
  const nlos = 35.3 * Math.log10(Math.max(1, d3d)) + 22.4
             + 21.3 * Math.log10(FC_GHZ) - 0.3 * (H_UT - 1.5);
  return Math.max(pathLossLOS(d3d), nlos);         // per the spec, take the max
}

// --- radio constants --------------------------------------------------------
export const BW_HZ      = 100e6;   // 100 MHz, n78
export const UE_NF_DB   = 7;       // UE noise figure, 3GPP calibration table
export const HPBW_V_DEG = 20;      // vertical half-power beamwidth of OUR array beam

// A SECTOR antenna is not a beam. TR 38.901 Table 7.3-1 gives the element pattern
// as phi_3dB = theta_3dB = 65 degrees. Our own five SSB beams are narrow because
// they are beamformed inside the sector; a neighbour's fixed 120-degree sector is
// wide.
//
// Using 20 degrees for a neighbour's sector was wrong and it broke the handover
// check outright. A UE sitting 60 degrees off a sector boresight — which is the
// normal cell-edge position in a tri-sector layout — came out 30 dB down, the
// front-to-back floor. Measured effect: the crowd 195 m out registered the best
// neighbour at -93 dBm against -53 dBm serving, a 39 dB margin the wrong way, so
// Event A3 could never fire no matter how far the crowd walked.
//
// At 65 degrees the same UE is 12*(60/65)^2 = 10.2 dB down, which is what a real
// sector edge looks like.
export const HPBW_SECTOR_DEG = 65;
export const SLA_V_DB   = 30;      // vertical side-lobe floor, TR 38.901 Table 7.3-1
export const A_MAX_DB   = 30;      // combined attenuation cap, TR 38.901 Table 7.3-1
export const SF_SIGMA_DB = 7.82;   // TR 38.901 UMi-NLOS. LOS would be 4.

// Thermal noise floor at a UE receiver.
//   N = -174 dBm/Hz + NF + 10*log10(BW)
// -174 is thermal noise per hertz at room temperature. Physics, not a choice.
export const N_DBM = -174 + UE_NF_DB + 10 * Math.log10(BW_HZ);   // -87.0 dBm

// --- the interference limit --------------------------------------------------
//
// AN ABSOLUTE CEILING ON NOISE RISE, NOT A LIMIT ON THE SIZE OF EACH MOVE.
//
// This replaces the earlier per-move delta budget, which was my invention and not
// what anyone actually does. Checking the literature:
//
//   ITU-R protection criterion: I/N <= -6 dB, equivalently 1 dB of noise rise.
//     That is a limit on the TOTAL contribution from an interferer, not on a
//     change.
//   3GPP energy saving: step the power down by one fixed step, then check whether
//     the SINR condition still holds. Fixed small step, evaluate the RESULTING
//     STATE.
//   CCO optimisation work: evaluates the resulting network state (RSRQ, SINR,
//     throughput). Interference is a cost term in the objective. Nothing asks how
//     big the change was.
//
// Small steps do appear in the literature, but as a SEARCH method — you step small
// because a large jump might land somewhere bad and you cannot evaluate it first.
// Not because the jump itself is the danger. So the step cap below is kept, and
// demoted to what it actually is.
//
// The delta budget also had a hole this fixes. It bounded the rate of harm and not
// the total, so a crowd walking out accumulated 5 dB at a neighbour with every
// individual step passing. Measured: 0.3 dB at 40 m rising to 5.6 dB at 200 m,
// never once blocked.
export const CEILING_DB = Number(process.env.NEIGHBOUR_CEILING_DB ?? 4.0);

// HYSTERESIS. Block above the ceiling, release only below (ceiling - H).
//
// Without it a cell sitting at 3.95 dB against a 4.0 dB ceiling starts and stops
// tracking on alternate ticks and the beam visibly stutters. Same latch pattern
// A3 uses, and for the same reason.
export const CEILING_HYST_DB = Number(process.env.NEIGHBOUR_CEILING_HYST ?? 0.5);

// Search guard, NOT a safety limit. Caps how far one commit may move so a click
// across the sector creeps over a few ticks instead of lurching. Stated separately
// so nobody mistakes it for the interference constraint.
export const MAX_STEP_DEG = Number(process.env.MAX_STEP_DEG ?? 15);

// Runtime dial. The slider writes this; the env sets the starting value.
let ceilingDb = CEILING_DB;
export const getCeiling = () => ceilingDb;
export function setCeiling(v) {
  const n = Number(v);
  if (Number.isFinite(n)) ceilingDb = Math.max(0.5, Math.min(12, n));
  return ceilingDb;
}

// OBSERVE MODE. Set NEIGHBOUR_GATE=off to compute and display everything while
// letting every move commit.
//
// This exists so the colours can be judged on their own. With the gate armed you
// only ever see the beam positions the gate permitted, which is exactly the set
// of positions least likely to reveal whether the heat map is right. Turn it off,
// drive the beam wherever you like, and check that the cell you are pointing at
// goes hot and the ones you are pointing away from go cold.
//
// The maths is unchanged in this mode. Only the verdict is forced to allow.
// Runtime toggle, not just an env flag. The env sets the STARTING state; the UI
// switch flips it live, so both behaviours can be shown in one session without a
// restart.
let gateEnabled = process.env.NEIGHBOUR_GATE !== "off";
export const isGateEnabled = () => gateEnabled;
export function setGateEnabled(on) { gateEnabled = !!on; return gateEnabled; }

// Consecutive blocks toward the SAME neighbour before we conclude the crowd is
// leaving the cell and this is handover territory rather than a beam problem.
export const BLOCK_STREAK_LIMIT = Number(process.env.BLOCK_STREAK ?? 3);

// --- HANDOVER, 3GPP EVENT A3 (TS 38.331) ------------------------------------
//
//   Mn + Ofn + Ocn - Hys  >  Mp + Ofp + Ocp + Off
//
// A neighbour becomes better than the serving cell by an offset, and stays that
// way for Time-to-Trigger. It is RSRP against RSRP, WANTED SIGNAL ONLY. The
// interference work above is a different mechanism entirely and does not appear
// here — a rising noise floor at a neighbour never triggers a handover.
//
// A3 accounts for roughly 90 percent of intra-frequency handovers. Typical values
// are a3-Offset 3 dB (1-2 aggressive, 4-6 conservative), hysteresis 1-2 dB, and
// TTT 256-320 ms, both offsets in 0.5 dB steps.
//
// TTT IS EXPRESSED IN TICKS HERE. At TICK_MS=1250 a 320 ms timer is sub-tick and
// would fire instantly, which defeats the point. Three consecutive ticks is the
// honest equivalent and matches the block-streak rule already used above.
export const A3_OFFSET_DB = Number(process.env.A3_OFFSET_DB ?? 3.0);
export const A3_HYST_DB   = Number(process.env.A3_HYST_DB   ?? 2.0);
export const A3_TTT_TICKS = Number(process.env.A3_TTT_TICKS ?? 3);

// --- neighbour topology -----------------------------------------------------
//
// Three sites on a hex lattice: ISD on 60 degree bearings, our serving sector
// facing north, so these are the three it can reach. Not the full 19-site
// wrap-around grid, which is for statistical evaluation, not a single-sector demo.
//
// ISD IS 250 m, AND IT WAS SET BY THE HANDOVER ARITHMETIC, NOT BY PICKING A
// STANDARD SCENARIO.
//
// Two constraints pull in opposite directions:
//
//   Interference. Worst-case noise rise at a neighbour, main lobe on it:
//       200 m -> 11.9 dB      250 m ->  6.4 dB (measured)
//       300 m ->  6.6 dB      400 m ->  3.6 dB      500 m -> 2.0 dB
//     Further is calmer, but past 400 m the gate has nothing to do.
//
//   Handover. The A3 crossover sits near ISD/2, but not exactly: we beamform five
//     SSB beams at 16.5 dBi combined while a neighbour runs one fixed 65 degree
//     sector at 15 dBi, so we stay ahead past the geometric midpoint. Measured at
//     ISD 400: at 200 m, which is the crowd clamp, serving was STILL 2.6 dB ahead.
//     Add the A3 entry margin of 5 dB and the crossover sat about 20 m beyond
//     anywhere the crowd could walk. Event A3 could never fire.
//
// 250 m puts the midpoint at 125 m and the measured crossover near 110 m, well
// inside the 200 m clamp.
//
// KNOWN COST at 250 m, stated rather than discovered later:
//   - interference roughly doubles against 400 m, 3.6 -> 6.4 dB worst case
//   - handover fires early, around 110 m, barely past half the sector
//   - and it does NOT release cleanly: walking back to 109 m the margin was still
//     12 dB and the cell stayed handed over
//
// If the "walk back in and tracking resumes" moment matters more than firing
// early, 300 m is the better number: midpoint 150 m, crossover near 160-170 m,
// interference about 5 dB. One value, three places.
//
// NOTE ON THE DRAWING. Radar.jsx places the sites at a FIXED screen radius, not at
// this distance, because drawing to scale shrinks the serving sector to a corner
// of the canvas. Bearings are true, the radius is compressed, and the ISD line is
// labelled so. The physics here uses the real number. Do not read screen distance
// as real distance.
const SITES = [
  { id: "B", az:  60, dist: 250 },
  { id: "C", az: -60, dist: 250 },
  { id: "D", az:   0, dist: 250 },
];

// Every site is tri-sectored on the same orientation, which is how a real
// deployment is planned. A UE belongs to whichever sector boresight its bearing
// from ITS OWN tower is closest to.
// Sector orientation is PER SITE, not one global 0/120/240.
//
// A planner orients each site's sectors to cover the gaps toward its neighbours.
// With a single global orientation, site D — directly ahead of us — ends up with a
// sector BOUNDARY pointing back at us: the bearing from D to our coverage area is
// 180 degrees, which is 60 degrees off both its 120 and 240 sectors, the worst
// possible angle. Sites B and C happen to already have a boresight facing us
// (240 and 120), so only D was misaligned, and it was misaligned by the maximum.
//
// Measured effect: at 195 m the crowd registered D at 4 dBi of sector gain instead
// of about 13, so the best neighbour sat 10 dB below serving and Event A3 could not
// fire even at the cell edge.
//
// Each site's sectors are therefore rotated so one boresight points back along the
// line to our site. For B and C this changes nothing; for D it rotates 0/120/240
// to 180/300/60.
const SECTOR_OFFSETS = [0, 120, 240];
function sectorAzFor(siteAzDeg) {
  const back = (siteAzDeg + 180 + 360) % 360;      // bearing from the site back to us
  return SECTOR_OFFSETS.map(o => (back + o) % 360);
}

// 60 per site, so roughly 20 per sector. At 20 per site a sector held only 5 to 9
// users, and a mean over that few is dominated by sampling noise: one user walking
// into a hot patch moved the whole sector reading by a couple of dB. 60 matches
// our own crowd size and steadies the numbers at negligible compute cost.
const UES_PER_NEIGHBOUR = 60;
// How far their users sit from their own tower. Kept inside the 72 m hex that is
// drawn for each cell — at 70 m with a Gaussian scatter the tail put users 100 m+
// out, well outside their own cell outline, and the picture looked like the users
// belonged to nobody.
const UE_SCATTER_M      = 55;

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
          x: pos.x + gaussian(UE_SCATTER_M / 2.2),
          y: pos.y + gaussian(UE_SCATTER_M / 2.2),
          vx: gaussian(0.6), vy: gaussian(0.6)
        };
        // Shadow fading is POSITION-LOCKED, exactly as in geometry.js. A building
        // does not move. Redrawing it every tick turns it into white noise, makes
        // the displayed number flicker for no physical reason, and would make the
        // gate fire and unfire at random.
        u._sf  = gaussian(SF_SIGMA_DB);
        u._sfX = u.x; u._sfY = u.y;
        u.sector = Neighbours.sectorOf(u.x, u.y, pos.x, pos.y, sectorAzFor(s.az));
        ues.push(u);
      }
      return { id: s.id, x: pos.x, y: pos.y, az: s.az, dist: s.dist, ues,
               sectorAz: sectorAzFor(s.az), blockStreak: 0 };
    });
  }

  // Which of a site's three sectors serves this UE. Bearing from ITS OWN tower,
  // nearest of 0 / 120 / 240.
  //
  // Worth being explicit about what this does NOT do. Sector membership is about
  // which of THEIR antennas points at the user. How much of OUR energy reaches
  // that user depends on where they sit relative to OUR tower. Those are
  // unrelated, so the harm does not concentrate in the sector facing us.
  // Measured on a +34 degree swing toward B: its three sectors rose +12.7, +14.4
  // and +12.3 dB. The one pointing back at us was not special.
  //
  // The split is therefore a REPORTING improvement, not a tighter safety
  // property. An operator alarms per cell and a cell is a sector, so three
  // numbers per site is what an RF engineer expects to read. Do not claim it
  // makes the gate stricter; measurement says it barely moves the verdict.
  static sectorOf(ux, uy, sx, sy, sectorAz) {
    const b = ((Math.atan2(ux - sx, uy - sy) * 180 / Math.PI) % 360 + 360) % 360;
    let best = sectorAz[0], bestD = 999;
    for (const a of sectorAz) {
      const d = Math.min(Math.abs(b - a), 360 - Math.abs(b - a));
      if (d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  // Their users walk. This is why a neighbour's number changes even when our beam
  // is completely still: our spill pattern is fixed, and they move through it.
  step() {
    for (const c of this.cells) {
      for (const u of c.ues) {
        u.x += u.vx; u.y += u.vy;
        // Keep them inside their own cell. Reversing the velocity alone was not
        // enough: a user that started in the Gaussian tail, already outside the
        // radius, just oscillated out there. Pull them back to the boundary as
        // well as turning them round.
        const dx = u.x - c.x, dy = u.y - c.y;
        const d  = Math.hypot(dx, dy);
        if (d > UE_SCATTER_M) {
          const k = UE_SCATTER_M / d;
          u.x = c.x + dx * k; u.y = c.y + dy * k;
          u.vx = -u.vx; u.vy = -u.vy;
        }
        // evolve the locked fade over 10 m of movement, same Gauss-Markov process
        // and same decorrelation distance as geometry.js uses for our own crowd.
        const moved = Math.hypot(u.x - u._sfX, u.y - u._sfY);
        if (moved > 0) {
          const rho = Math.exp(-moved / 10);
          u._sf = rho * u._sf + Math.sqrt(1 - rho * rho) * gaussian(SF_SIGMA_DB);
          u._sfX = u.x; u._sfY = u.y;
        }
        // a walking user can cross a sector boundary
        u.sector = Neighbours.sectorOf(u.x, u.y, c.x, c.y, c.sectorAz);
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
  // hpbwH: 20 for OUR beamformed SSB beams, 65 for a fixed sector antenna.
  //
  // THE AZIMUTH OFFSET MUST BE WRAPPED. Math.atan2 returns (-180, 180] while sector
  // boresights are stored as 0-360, so `az - a` could come out as -359 instead of
  // +1. Squared, that is capped at the 30 dB front-to-back floor.
  //
  // It bit exactly where it does the most damage: site D sits due north, so its
  // sector boresight is 180 and a UE directly south reads az = +180 or -180
  // depending on the sign of x by a metre or two. Half the crowd therefore took a
  // 30 dB penalty and the other half none, dragging D's mean about 28 dB low and
  // making a nearer site look weaker than a further one. Event A3 could not fire.
  static gainDb(azOffsetDeg, elOffsetDeg, hpbwH = 20) {
    const wrapped = ((azOffsetDeg % 360) + 540) % 360 - 180;   // -> (-180, 180]
    const aH = Math.min(12 * Math.pow(wrapped / hpbwH,          2), A_MAX_DB);
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
    const pl  = pathLossNLOS(d3d);

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
    const per  = {}; for (const a of cell.sectorAz) per[a] = [];
    const all  = [];
    for (const u of cell.ues) {
      const i  = this.spillOnUeLin(u, fanCenter, tiltDeg);
      const nr = 10 * Math.log10((i + nLin) / nLin);
      all.push(nr);
      per[u.sector].push(nr);
    }
    const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const sectors = {};
    for (const a of cell.sectorAz) sectors[a] = { n: per[a].length, mean: avg(per[a]) };
    all.sort((a, b) => b - a);
    return { worst: all[0], mean: avg(all), sectors };
  }

  // ---------------------------------------------------------------------------
  // What a NEIGHBOUR's tower delivers to OUR crowd.
  //
  // The reverse of spillOnUeLin: their RU transmitting, our UE receiving. Same
  // link budget, opposite direction.
  //
  // Their beam is not steerable in this simulator, so each of their three sectors
  // points at a fixed 0/120/240 and we take whichever serves our UE best. That is
  // what a real UE reports: the strongest neighbour cell, not an average.
  //
  // Shadow fading is drawn per link and held on the UE, so it is stable rather
  // than a fresh dice roll per tick. Without that the handover flag would chatter.
  // ---------------------------------------------------------------------------
  neighbourRsrpDbm(ue, cell) {
    const dx = ue.x - cell.x, dy = ue.y - cell.y;
    const range = Math.hypot(dx, dy);
    const d3d   = Math.hypot(range, TOWER_H);
    const pl    = pathLossNLOS(d3d);
    const az    = Math.atan2(dx, dy) * 180 / Math.PI;
    const depression = Math.atan2(TOWER_H, Math.max(1, range)) * 180 / Math.PI;

    // one locked fade per (UE, neighbour) pair
    ue._nsf = ue._nsf || {};
    if (ue._nsf[cell.id] === undefined) ue._nsf[cell.id] = gaussian(SF_SIGMA_DB);

    // NEIGHBOURS HAVE DOWNTILT. A real sector is tilted to put its boresight near
    // the cell edge; a sector left at 0 degrees points at the horizon and cannot
    // serve anyone close to its own tower.
    //
    // That was a real failure: with no tilt, a UE 50 m from a neighbour sat 26.6
    // degrees below its boresight, which is 21 dB of vertical attenuation, so the
    // neighbour read WEAKER right underneath itself than it did 130 m away. The
    // A3 margin peaked mid-cell and then fell, and handover could not fire near
    // the neighbour at all.
    //
    // Tilt is derived from the cell size rather than hardcoded, so it follows any
    // change to ISD: boresight aimed at the cell edge, ISD/2.
    const nTilt = Math.atan2(TOWER_H, cell.dist / 2) * 180 / Math.PI;
    let best = -Infinity;
    for (const a of cell.sectorAz) {
      const g = Neighbours.gainDb(az - a, depression - nTilt, HPBW_SECTOR_DEG);
      const r = P_TX_DBM + g - pl - ue._nsf[cell.id];
      if (r > best) best = r;
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // EVENT A3. Does our crowd now belong to a neighbour?
  //
  // Called with the crowd's UEs and the RSRP our own beam delivers to them. The
  // serving figure is the crowd's mean own-cell RSRP; the neighbour figure is the
  // mean of the best neighbour cell. Compared per the A3 entry condition, held
  // for TTT ticks.
  //
  // Returns { active, toward, marginDb, ticks }. It reports. It does not act.
  // ---------------------------------------------------------------------------
  evaluateHandover(crowdUes, servingRsrpDbm, fanCenter, tiltDeg) {
    const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : -140);

    // LIKE FOR LIKE. This is the part that has to be right or A3 never fires.
    //
    // The serving RSRP the model sees comes from geometry.js, which uses the UMi
    // LOS path loss. The neighbour links here use NLOS. Comparing one against the
    // other is apples to oranges: at 200 m the two models differ by about 24 dB,
    // so our own cell always looked 24 dB better than it should and Event A3 could
    // not fire however far the crowd walked. Measured: serving -55 dBm against a
    // best neighbour of -93 dBm, a 38 dB margin the wrong way.
    //
    // So the A3 comparison recomputes OUR serving RSRP with the SAME NLOS model
    // used for the neighbours. Both sides, one model, one comparison.
    //
    // This figure is used ONLY for the handover decision. It is not what the model
    // sees and it never touches rsrpPerBeam — geometry.js stays frozen, because
    // changing it invalidates beam-v9.
    const servingLike = mean(crowdUes.map(u => {
      const range = Math.hypot(u.x, u.y);
      const d3d   = Math.hypot(range, TOWER_H);
      const az    = Math.atan2(u.x, u.y) * 180 / Math.PI;
      const dep   = Math.atan2(TOWER_H, Math.max(1, range)) * 180 / Math.PI;
      u._ssf = (u._ssf === undefined) ? gaussian(SF_SIGMA_DB) : u._ssf;
      let lin = 0;
      for (const b of fanAzimuths(fanCenter)) {
        lin += Math.pow(10, (P_TX_DBM + Neighbours.gainDb(az - b, dep - tiltDeg) - d3d * 0) / 10);
      }
      const gainDb = 10 * Math.log10(lin);
      return P_TX_DBM + (gainDb - P_TX_DBM) - pathLossNLOS(d3d) - u._ssf;
    }));

    let bestCell = null, bestMean = -Infinity;
    for (const c of this.cells) {
      const m = mean(crowdUes.map(u => this.neighbourRsrpDbm(u, c)));
      if (m > bestMean) { bestMean = m; bestCell = c; }
    }

    // A3 entry:  Mn - Hys > Mp + Off      (CIO left at 0, we do not write it)
    const enter = bestMean - A3_HYST_DB > servingLike + A3_OFFSET_DB;

    if (enter && bestCell) {
      this._a3 = (this._a3 && this._a3.id === bestCell.id)
        ? { id: bestCell.id, ticks: this._a3.ticks + 1 }
        : { id: bestCell.id, ticks: 1 };
    } else {
      this._a3 = null;
    }

    const fired = !!(this._a3 && this._a3.ticks >= A3_TTT_TICKS);
    return {
      active: fired,
      toward: fired ? this._a3.id : null,
      ticks: this._a3 ? this._a3.ticks : 0,
      ttt: A3_TTT_TICKS,
      servingDbm: +servingLike.toFixed(1),           // NLOS, like-for-like
      servingModelDbm: +servingRsrpDbm.toFixed(1),   // what the model sees, LOS
      bestNeighbourDbm: +bestMean.toFixed(1),
      bestNeighbourId: bestCell ? bestCell.id : null,
      marginDb: +(bestMean - servingLike).toFixed(1),
      offsetDb: A3_OFFSET_DB,
      hystDb: A3_HYST_DB
    };
  }

  // ---------------------------------------------------------------------------
  // THE GATE. Called before commit.
  //
  // Tests the RESULTING STATE against an absolute ceiling, latched with
  // hysteresis. It reports; it does not apply anything.
  //
  // `latched` is per cell. A cell that has tripped stays tripped until its noise
  // rise falls below (ceiling - hysteresis), so the verdict cannot flap tick to
  // tick while a cell hovers at the line.
  // ---------------------------------------------------------------------------
  evaluate(currentFan, currentTilt, proposedFan, proposedTilt) {
    const cap = ceilingDb;
    const rel = cap - CEILING_HYST_DB;

    const cells = this.cells.map(c => {
      const before = this.noiseRiseFor(c, currentFan,  currentTilt);
      const after  = this.noiseRiseFor(c, proposedFan, proposedTilt);

      // Per sector, so the display shows the unit an operator alarms on. The
      // ceiling is tested on the WORST sector, not the site mean: a budget exists
      // to protect the users who actually suffer, and those sit in one cell.
      const sectors = c.sectorAz.map(a => ({
        az: a,
        ues: after.sectors[a].n,
        before: +before.sectors[a].mean.toFixed(2),
        after:  +after.sectors[a].mean.toFixed(2),
        delta:  +(after.sectors[a].mean - before.sectors[a].mean).toFixed(2),
        overCeiling: after.sectors[a].mean > cap
      }));
      const worstSector = sectors.reduce((x, y) => (y.after > x.after ? y : x));

      // latch, per cell
      c._latched = c._latched
        ? worstSector.after > rel          // stay tripped until it drops below rel
        : worstSector.after > cap;         // trip when it exceeds cap

      return {
        id: c.id,
        sectors,
        worstSectorAz: worstSector.az,
        before: +before.mean.toFixed(2),
        after:  +after.mean.toFixed(2),
        peak:   +worstSector.after.toFixed(2),   // worst sector's resulting rise
        delta:  +(worstSector.after - worstSector.before).toFixed(2),
        overBudget: c._latched                    // name kept: the UI reads it
      };
    });

    const over  = cells.filter(c => c.overBudget);
    const worst = cells.reduce((a, b) => (b.peak > a.peak ? b : a), cells[0]);

    for (const c of this.cells) {
      const hit = over.find(o => o.id === c.id);
      c.blockStreak = hit ? c.blockStreak + 1 : 0;
    }
    const streaked = gateEnabled
      ? this.cells.find(c => c.blockStreak >= BLOCK_STREAK_LIMIT)
      : null;

    return {
      allowed: gateEnabled ? over.length === 0 : true,
      observeMode: !gateEnabled,
      cells,
      worstCell: worst.id,
      worstPeak: worst.peak,
      worstDelta: worst.delta,
      ceiling: cap,
      hysteresis: CEILING_HYST_DB,
      budget: cap,                     // legacy name, still read by the UI
      handover: streaked ? { toward: streaked.id, streak: streaked.blockStreak } : null,
      reason: over.length
        ? `${over.map(o => `${o.id}/${o.worstSectorAz}\u00b0 at ${o.peak}dB`).join(", ")} over ${cap}dB ceiling`
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
        noiseRise: +nr.mean.toFixed(2),          // site level, all users
        worst: +nr.worst.toFixed(2),
        // three sectors per site, nine across the layout. This is the unit an
        // operator alarms on, so it is the unit the display shows.
        sectors: c.sectorAz.map(a => ({
          az: a, ues: nr.sectors[a].n,
          noiseRise: +nr.sectors[a].mean.toFixed(2)
        })),
        blockStreak: c.blockStreak,
        ues: c.ues.map(u => ({ x: +u.x.toFixed(1), y: +u.y.toFixed(1), sector: u.sector }))
      };
    });
  }
}
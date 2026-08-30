// geometry.js — real beam geometry for the demo.
// Top-down world is meters. Tower at origin. Azimuth measured in degrees from +Y (north),
// positive clockwise. Tilt maps to a ground range via r = h / tan(theta_elevation).
//
// The model NEVER sees UE positions. It sees only per-beam counts. Everything here that
// touches positions is the *simulator's* private truth used to (a) move the crowd and
// (b) compute what each beam would count. That honest wall is the whole point.

export const TOWER_H = 25;          // antenna height, meters
export const N_BEAMS = 5;           // fan of beams (grid-of-beams sensing)
export const FAN_HALF_WIDTH = 7;    // half-power half-width per beam, degrees
export const AZ_MIN = -55, AZ_MAX = 55; // sector edges, degrees

// Convert a tilt (elevation angle below horizon, deg) to ground range (m).
export function tiltToRange(tiltDeg) {
  const el = Math.max(1, Math.min(80, tiltDeg));
  return TOWER_H / Math.tan(el * Math.PI / 180);
}
// Inverse: given a ground range, the tilt that centers coverage there.
export function rangeToTilt(range) {
  const r = Math.max(2, range);
  return Math.atan2(TOWER_H, r) * 180 / Math.PI;
}

// Polar position of a UE relative to tower: {az (deg from +Y), range (m)}.
export function toPolar(x, y) {
  const az = Math.atan2(x, y) * 180 / Math.PI;   // +Y is 0, +X is +90
  const range = Math.hypot(x, y);
  return { az, range };
}
export function fromPolar(azDeg, range) {
  const a = azDeg * Math.PI / 180;
  return { x: range * Math.sin(a), y: range * Math.cos(a) };
}

// The fan: N beam azimuth centers spread across [fanCenter-span, fanCenter+span].
export function fanAzimuths(fanCenter, span = 30) {
  const out = [];
  const step = (2 * span) / (N_BEAMS - 1);
  for (let i = 0; i < N_BEAMS; i++) out.push(fanCenter - span + i * step);
  return out;
}

// Count how many UEs fall inside each beam. A UE is "in" beam b if its azimuth is within
// FAN_HALF_WIDTH of the beam center AND its range is within the tilted coverage band.
// This is what the gNB reports as KPM — counts only.
export function countPerBeam(ues, fanCenter, tiltDeg) {
  const azs = fanAzimuths(fanCenter);
  const centerRange = tiltToRange(tiltDeg);
  const near = centerRange * 0.45, far = centerRange * 1.75; // coverage band depth
  const counts = new Array(N_BEAMS).fill(0);
  for (const u of ues) {
    const { az, range } = toPolar(u.x, u.y);
    if (range < near || range > far) continue;
    for (let b = 0; b < azs.length; b++) {
      if (Math.abs(az - azs[b]) <= FAN_HALF_WIDTH) { counts[b]++; break; }
    }
  }
  return counts;
}

// Count-weighted centroid of the beams (azimuth space) + total load + spread.
// Consistent and directionally faithful — a small steady bias is fine for beam-following,
// and the Kalman smoother absorbs the beam-quantization stair-step.
export function beamCentroid(counts, fanCenter) {
  const azs = fanAzimuths(fanCenter);
  let sw = 0, saz = 0;
  for (let b = 0; b < counts.length; b++) { sw += counts[b]; saz += counts[b] * azs[b]; }
  if (sw === 0) return { az: fanCenter, load: 0, spread: 0 };
  const az = saz / sw;
  let sv = 0;
  for (let b = 0; b < counts.length; b++) sv += counts[b] * (azs[b] - az) ** 2;
  const spread = Math.sqrt(sv / sw);
  return { az, load: sw, spread };
}
// Real RF sensing: per-beam SS-RSRP.
//
// This replaces countPerBeam() as the gNB's measurement. A real gNodeB cannot
// count UEs per beam (no such standard counter exists). What it DOES report is
// SS-RSRP per SSB beam (3GPP TS 28.552) plus a cell-level UE count.
//
// Physics: 3GPP TR 38.901 UMi-Street-Canyon LOS path loss, a cos^2 antenna
// pattern, log-normal shadow fading, quantized to the TS 38.133 reporting range.
//
// countPerBeam() is left in place — nothing else that uses it breaks.

export const FC_GHZ       = 3.5;   // mid-band carrier
export const P_TX_DBM     = 18;    // per-SSB transmit power (dBm)
export const G_MAX_DBI    = 15;    // peak beam gain at boresight
export const SF_SIGMA_DB  = 4;     // TR 38.901 UMi-LOS shadow fading sigma
export const RSRP_MIN     = -156;  // TS 38.133 reportable floor (dBm)
export const RSRP_MAX     = -31;   // TS 38.133 reportable ceiling (dBm)

// 3GPP TR 38.901 UMi-Street-Canyon LOS path loss (dB). d in metres, fc in GHz.
export function pathLoss38901(d) {
  const dd = Math.max(1, d);
  return 32.4 + 21 * Math.log10(dd) + 20 * Math.log10(FC_GHZ);
}

// 3GPP-style parabolic element pattern (TR 38.901 §7.3):
//   A(theta) = -min( 12 * (theta / theta_3dB)^2 , A_max )
// A cos^2 pattern is far too broad for 15 degree beam spacing — adjacent beams differ by
// barely a dB, which flattens the profile and destroys the steering gradient. A realistic
// half-power beamwidth gives beams that actually discriminate between directions.
export const HPBW_DEG = 20;      // half-power beamwidth per beam
export const FRONT_BACK_DB = 30; // maximum attenuation (side-lobe floor)

function beamGainDb(azOffsetDeg) {
  const off = Math.abs(azOffsetDeg);
  const atten = Math.min(12 * Math.pow(off / HPBW_DEG, 2), FRONT_BACK_DB);
  return G_MAX_DBI - atten;
}

function gaussianNoise(sigma) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Quantize to TS 38.133 integer dBm levels (1 dB steps), clamped to reportable range.
function quantizeRsrp(dbm) {
  return Math.max(RSRP_MIN, Math.min(RSRP_MAX, Math.round(dbm)));
}

// The gNB's sensing. For each UE compute RSRP on every beam, assign the UE to its
// best (serving) beam, and report per-beam aggregate RSRP plus beam membership.
//
// Returns { rsrp: [dBm x N], members: [count x N], azimuths: [deg x N] }
//   rsrp     -> SS-RSRP per SSB  (the standard per-beam quantity)
//   members  -> how many UEs each beam serves (derived, NOT a standard counter)
//   azimuths -> where each beam currently points (from our own commanded state)
export function rsrpPerBeam(ues, fanCenter) {
  const azs = fanAzimuths(fanCenter);
  const N = azs.length;
  const linSum  = new Array(N).fill(0);   // total received power per beam
  const members = new Array(N).fill(0);   // best-beam assignment (display only)

  for (const u of ues) {
    const { az, range } = toPolar(u.x, u.y);
    const d3d = Math.hypot(range, TOWER_H);
    const pl  = pathLoss38901(d3d);
    const sf  = gaussianNoise(SF_SIGMA_DB);      // one shadow draw per UE

    // EVERY beam hears EVERY UE, at a strength set by how far off boresight it is.
    // Real grid-of-beams patterns overlap; a beam does not go silent because a user is
    // better served elsewhere. Reporting only the best-beam assignment produced a nearly
    // flat profile (~2 dB) with no gradient to steer on. Summing what each beam actually
    // receives gives the monotonic roll-off a real RSRP profile has.
    let bestB = 0, bestR = -Infinity;
    for (let b = 0; b < N; b++) {
      const rsrp = P_TX_DBM - pl + beamGainDb(az - azs[b]) + sf;
      linSum[b] += Math.pow(10, rsrp / 10);
      if (rsrp > bestR) { bestR = rsrp; bestB = b; }
    }
    members[bestB]++;
  }

  const rsrp = new Array(N).fill(RSRP_MIN);
  for (let b = 0; b < N; b++) {
    if (linSum[b] > 0) rsrp[b] = quantizeRsrp(10 * Math.log10(linSum[b]));
  }
  return { rsrp, members, azimuths: azs.map(a => +a.toFixed(1)) };
}

// RSRP-weighted azimuth: where the RF demand actually sits.
// This is the steering signal. Linear power weights, NOT dBm (dBm is logarithmic
// and cannot be averaged directly). Beams with no served UE are excluded.
export function rsrpCentroid(rsrp, fanCenter) {
  const azs = fanAzimuths(fanCenter);
  const served = rsrp.filter(r => r > RSRP_MIN);
  if (!served.length) return { az: fanCenter, profile: rsrp.map(() => 0) };

  // Weight on CONTRAST, not absolute power.
  //
  // Overlapping beams all hear the crowd, so absolute powers sit within a few dB of each
  // other. Converting those straight back to linear gives near-equal weights and the
  // centroid collapses toward boresight. What carries the direction is how far each beam
  // sits ABOVE the weakest beam. Subtracting the floor and then going to linear restores
  // the contrast, and the exponent sharpens it so the peak beam dominates the average.
  const floor = Math.min(...served);
  const SHARPNESS = 1.0;                       // plain dB contrast; the pattern now supplies it
  const lin = rsrp.map(r => r <= RSRP_MIN ? 0 : Math.pow(10, (r - floor) * SHARPNESS / 10));
  const tot = lin.reduce((a, b) => a + b, 0);
  if (tot <= 0) return { az: fanCenter, profile: rsrp.map(() => 0) };

  const az = lin.reduce((s, w, i) => s + w * azs[i], 0) / tot;
  return { az, profile: lin.map(w => +(w / tot).toFixed(4)) };
}
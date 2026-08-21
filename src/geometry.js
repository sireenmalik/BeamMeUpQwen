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

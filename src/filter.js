// filter.js — a deliberately caged Kalman filter.
// It smooths the noisy beam-centroid azimuth. By default it does NOT run a predict step
// into the future — that job belongs to the LLM. This is the "cage Kalman to smoothing"
// decision: we keep a velocity estimate for display/telemetry, but the forecast is the model's.
//
// L1/L2 note: project(leadTicks) is an OPTIONAL, deterministic forward projection used by the
// Lead and Momentum tool modes. It does not change update()'s smoothing behavior; it just
// exposes "where the smoothed centroid is heading" so the tool can aim ahead of the crowd.

export class AzimuthSmoother {
  constructor() {
    this.x = null;    // smoothed azimuth
    this.v = 0;       // estimated angular velocity (deg/tick) — telemetry only
    this.a = 0.45;    // position smoothing (higher = snappier)
    this.b = 0.25;    // velocity smoothing
    this.vHist = [];  // recent velocity samples, for the confidence gate
  }
  update(measuredAz) {
    if (this.x === null) { this.x = measuredAz; return { az: this.x, vel: 0 }; }
    const prev = this.x;
    // exponential position smoothing (no forward prediction)
    this.x = this.x + this.a * (measuredAz - this.x);
    const instV = this.x - prev;
    this.v = this.v + this.b * (instV - this.v);
    // keep a short velocity history for the motion-consistency (confidence) check
    this.vHist.push(this.v);
    if (this.vHist.length > 5) this.vHist.shift();
    return { az: this.x, vel: this.v };
  }

  // Deterministic forward projection of the smoothed centroid, leadTicks ahead.
  // Used by Lead (L1) and Momentum (L2). Pure function of current smoothed state.
  project(leadTicks) {
    if (this.x === null) return 0;
    return this.x + this.v * leadTicks;
  }

  // Motion-consistency signal for the confidence gate.
  // Returns true when recent velocity is steady (same direction, low variance),
  // false on reversals / jitter / not-enough-history — where leading is unsafe.
  isMotionConsistent() {
    if (this.vHist.length < 3) return false;
    const v = this.vHist;
    // all recent samples share the same sign (no reversal in the window)?
    const signs = v.map(s => Math.sign(s)).filter(s => s !== 0);
    const sameDir = signs.length > 0 && signs.every(s => s === signs[0]);
    // variance low relative to magnitude (not jittery)?
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const varc = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
    const lowJitter = varc < 4.0; // deg/tick^2; tune against real motion
    return sameDir && lowJitter;
  }
}
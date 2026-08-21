// filter.js — a deliberately caged Kalman filter.
// It smooths the noisy beam-centroid azimuth ONLY. It does not run a predict step into
// the future — that job belongs to the LLM. This is the "cage Kalman to smoothing" decision:
// we keep a velocity estimate for display/telemetry, but the forecast is the model's.

export class AzimuthSmoother {
  constructor() {
    this.x = null;    // smoothed azimuth
    this.v = 0;       // estimated angular velocity (deg/tick) — telemetry only
    this.a = 0.45;    // position smoothing (higher = snappier)
    this.b = 0.25;    // velocity smoothing
  }
  update(measuredAz) {
    if (this.x === null) { this.x = measuredAz; return { az: this.x, vel: 0 }; }
    const prev = this.x;
    // exponential position smoothing (no forward prediction)
    this.x = this.x + this.a * (measuredAz - this.x);
    const instV = this.x - prev;
    this.v = this.v + this.b * (instV - this.v);
    return { az: this.x, vel: this.v };
  }
}

// loop.js — one tick of the gNB / SMO / rApp control loop.
// Produces (a) the new beam target and (b) a structured signaling log the UI renders,
// showing the REAL messages each interface would carry.

import { Crowd } from "./crowd.js";
import { AzimuthSmoother } from "./filter.js";
import { decide, MODEL_INFO } from "./model.js";
import { validateAndFormat } from "./formatter.js";
import { countPerBeam, beamCentroid, fanAzimuths, rangeToTilt, toPolar } from "./geometry.js";

export class ControlLoop {
  constructor() {
    this.crowd = new Crowd();
    this.smoother = new AzimuthSmoother();
    this.fanCenter = -10;
    this.tilt = 20;
    this.history = [];       // recent count vectors
    this.tick = 0;
    this.lastLog = null;
    this.lastProposal = null;
    this.escalation = null;  // {pending:true} when chaos flags human gate
  }

  // detect a load split across the two edges of the fan (allocate signal)
  _splitDetected(counts) {
    const n = counts.length;
    const left = counts.slice(0, Math.floor(n / 2)).reduce((a, b) => a + b, 0);
    const right = counts.slice(Math.ceil(n / 2)).reduce((a, b) => a + b, 0);
    const mid = counts[Math.floor(n / 2)] || 0;
    const tot = left + right + mid || 1;
    return left / tot > 0.3 && right / tot > 0.3 && mid / tot < 0.2;
  }

  async stepAsync() {
    this.tick++;
    this.crowd.step();
    const ues = this.crowd.ues;

    // --- gNB: measure counts per beam (KPM) ---
    const counts = countPerBeam(ues, this.fanCenter, this.tilt);
    this.history.push(counts);
    if (this.history.length > 6) this.history.shift();

    const { az: centAz, load, spread } = beamCentroid(counts, this.fanCenter);
    // smooth the TRUE crowd bearing (computed below) — but we need trueAz first, so this
    // smoother call is moved; see below. Keep centAz/load/spread for the KPM/R1 display.

    // spread-rising detection over last few ticks (chaos signal)
    let spreadRising = false;
    if (this.history.length >= 3) {
      const spreads = this.history.map(c => beamCentroid(c, this.fanCenter).spread);
      const d = spreads[spreads.length - 1] - spreads[0];
      spreadRising = d > 8; // degrees of azimuth spread growth
    }
    const splitDetected = this._splitDetected(counts);

    let meanRange = 0, sumX = 0, sumY = 0;
    for (const u of ues) { meanRange += Math.hypot(u.x, u.y); sumX += u.x; sumY += u.y; }
    meanRange = ues.length ? meanRange / ues.length : 60;
    const cx = ues.length ? sumX / ues.length : 0;
    const cy = ues.length ? sumY / ues.length : 60;
    const centAzTrue = Math.atan2(sumX, sumY) * 180 / Math.PI;
    // real spatial spread radius (meters) around the centroid — grows fast on dispersal
    let spreadR = 0;
    for (const u of ues) spreadR += (u.x - cx) ** 2 + (u.y - cy) ** 2;
    spreadR = ues.length ? Math.sqrt(spreadR / ues.length) : 8;

    // ONE centroid. Smooth it lightly so it isn't jumpy, then the beam aims exactly here.
    const { az: smAz, vel } = this.smoother.update(centAzTrue);
    const beamRangeTilt = rangeToTilt(meanRange);

    // Point 1: the centroid (what we show as the green dot + coords)
    this.centroid = {
      az: +smAz.toFixed(2),
      range: +meanRange.toFixed(1),
      x: +cx.toFixed(1),
      y: +cy.toFixed(1),
      spreadR: +spreadR.toFixed(1)
    };
    // Trail: remember where the centroid has been (last 24 points), for breadcrumbs
    this.trail = this.trail || [];
    this.trail.push({ az: this.centroid.az, range: this.centroid.range });
    if (this.trail.length > 24) this.trail.shift();

    // --- rApp (model): decide parameters only ---
    const obs = {
      currentFanCenter: +this.fanCenter.toFixed(2),
      currentTilt: +this.tilt.toFixed(2),
      beamAzimuths: fanAzimuths(this.fanCenter).map(a => +a.toFixed(1)),
      countHistory: this.history,
      centroidAz: this.centroid.az,
      centroidVel: +vel.toFixed(3),
      spreadNow: +spread.toFixed(2),
      spreadRising, splitDetected,
      load
    };
    const params = await decide(obs);
    // Point 2 & 3: beam math derives from the centroid; beam points AT the centroid.
    params.fan_center = this.centroid.az;
    params.tilt = +beamRangeTilt.toFixed(1);

    // --- SMO: validate + format into A1/O1 (deterministic tool) ---
    const ts = Date.now();
    const formatted = validateAndFormat(params, {
      currentFanCenter: this.fanCenter, currentTilt: this.tilt, ts
    });

    // apply the committed target
    this.fanCenter = formatted.a1Policy.target.fan_center_deg;
    this.tilt = formatted.a1Policy.target.tilt_deg;

    // widen action -> visibly wider fan handled in UI via action flag
    // escalation gate for chaos
    if (params.action === "widen" && spreadRising) {
      this.escalation = { pending: true, ts, reason: "Radial dispersal detected" };
    } else if (params.action !== "widen") {
      // keep any pending escalation until user clears it; do not auto-clear on normal ticks
    }

    // --- build the signaling log (what each interface carries) ---
    const log = {
      tick: this.tick,
      gNB_to_SMO_KPM: {
        schema: "demo.e2sm-kpm.v1", note: "ASN.1 on the wire; decoded here",
        beam_counts: counts, total_ue: load
      },
      SMO_to_rApp_R1: {
        schema: "demo.r1.data.v1",
        count_history: this.history,
        centroid_method: "count_weighted",
        centroid_az: obs.centroidAz, centroid_vel: obs.centroidVel,
        spread: obs.spreadNow, spread_rising: spreadRising, split: splitDetected
      },
      rApp_proposal: {
        params_only: params,       // the model's raw output — numbers only
        model: MODEL_INFO
      },
      SMO_to_gNB_A1_O1: {
        a1_policy: formatted.a1Policy,
        o1_config: formatted.o1Config,
        validation: formatted.validation
      },
      escalation: this.escalation
    };
    this.lastLog = log;
    this.lastProposal = params;
    // rolling proposal history (newest first, keep last 12) with timestamps
    this.proposalHistory = this.proposalHistory || [];
    const t = new Date();
    const hhmmss = t.toTimeString().slice(0, 8);
    this.proposalHistory.unshift({
      t: hhmmss,
      tick: this.tick,
      fan_center: params.fan_center,
      tilt: params.tilt,
      action: params.action,
      reason: params.reason
    });
    if (this.proposalHistory.length > 12) this.proposalHistory.pop();
    return log;
  }

  clearEscalation() { this.escalation = null; }

  state() {
    return {
      tick: this.tick,
      tower: { h: 25 },
      fanCenter: this.fanCenter,
      tilt: this.tilt,
      centroid: this.centroid || { az: 0, range: 0, x: 0, y: 0 },
      trail: this.trail || [],
      beamAzimuths: fanAzimuths(this.fanCenter),
      ues: this.crowd.snapshot(),
      mode: this.crowd.mode,
      action: this.lastProposal?.action || "follow",
      proposals: this.proposalHistory || [],
      escalation: this.escalation,
      log: this.lastLog,
      model: MODEL_INFO
    };
  }
}
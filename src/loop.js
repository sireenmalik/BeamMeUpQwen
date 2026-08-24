// loop.js — one tick of the gNB / SMO / rApp control loop.
// Produces (a) the new beam target and (b) a structured signaling log the UI renders,
// showing the REAL messages each interface would carry.

import { Crowd } from "./crowd.js";
import { AzimuthSmoother } from "./filter.js";
import { decide, MODEL_INFO } from "./model.js";
import { validateAndFormat } from "./formatter.js";
import { countPerBeam, beamCentroid, fanAzimuths, rangeToTilt, toPolar } from "./geometry.js";

// forecasting tool modes. reactive = today's follower. lead/momentum = deterministic
// forward projection on the SAME model. predictive = reserved for the L3 tuned model (WIP).
export const FORECAST_MODES = ["reactive", "lead", "momentum", "predictive"];
const LEAD_TICKS = 1.5;        // how far ahead Lead aims (tunable)
const MOMENTUM_TICKS = 1.0;    // projection horizon for Momentum
const UE_FLOOR = 3;            // below this many total UEs, hold (don't chase noise)

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
    this.mode = "momentum"; // forecasting mode; set via setMode() — momentum is the default
    this.lastGoodFan = -10;  // last committed fan_center, for UE-floor hold
    // --- chaos detector (read-only observer; never touches the beam path) ---
    this.prevSpreadR = null;   // last tick's spatial spread radius, for rate-of-rise
    this.anomaly = null;       // {active, blinksLeft, pattern, tick} when chaos flagged
    this.anomalyArmed = false; // detector only watches while Detect Chaos use case is active
    this.anomalyFiring = false;// true while one event is ongoing, so we don't re-trigger every tick
  }

  setMode(m) { if (FORECAST_MODES.includes(m)) this.mode = m; return this.mode; }

  // arm the chaos detector ONLY while the Detect Chaos use case is active.
  // arming/disarming also clears any visible anomaly (switching use case wipes the banner).
  setAnomalyArmed(on) {
    this.anomalyArmed = !!on;
    this.anomaly = null;
    this.anomalyFiring = false;
    this.prevSpreadR = null;
    return this.anomalyArmed;
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

  // Deterministic aim selection based on the active forecasting mode.
  // Returns { aim, effectiveMode } — effectiveMode may drop back to "reactive"
  // when the confidence gate or UE floor says leading is unsafe.
  _aimForMode(centroidAz, totalUe) {
    const base = centroidAz;                 // reactive baseline (aim at the crowd now)
    // UE floor: too few users -> centroid is noise. Hold the last good position.
    if (totalUe < UE_FLOOR) {
      return { aim: this.lastGoodFan, effectiveMode: "hold" };
    }
    // predictive (L3 tuned model) not wired yet -> behave as lead for now (WIP)
    const wanted = this.mode === "predictive" ? "lead" : this.mode;

    if (wanted === "reactive") {
      return { aim: base, effectiveMode: "reactive" };
    }
    // lead / momentum both need consistent motion; otherwise fall back to reactive
    if (!this.smoother.isMotionConsistent()) {
      return { aim: base, effectiveMode: "reactive" };
    }
    if (wanted === "lead") {
      return { aim: this.smoother.project(LEAD_TICKS), effectiveMode: "lead" };
    }
    if (wanted === "momentum") {
      // momentum: blend the smoothed position with a shorter forward projection
      const proj = this.smoother.project(MOMENTUM_TICKS);
      return { aim: 0.5 * base + 0.5 * proj, effectiveMode: "momentum" };
    }
    return { aim: base, effectiveMode: "reactive" };
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

    // --- CHAOS DETECTOR (read-only; armed only in Detect Chaos use case) ---
    // Watches the rate-of-rise of the spatial spread radius. Radial dispersal (a burst)
    // makes spreadR balloon while the centroid stays roughly put. This sets a blinking
    // flag ONLY. It does not touch params, the beam, or the loop. If removed, nothing
    // about tracking changes.
    if (this.anomalyArmed) {
      const rise = this.prevSpreadR === null ? 0 : (spreadR - this.prevSpreadR);
      const DISPERSAL_RISE = 6; // meters/tick of spread growth that counts as "fanning out"
      if (rise > DISPERSAL_RISE && !this.anomalyFiring) {
        // fresh event -> arm a bounded 20-blink banner
        this.anomaly = { active: true, blinksLeft: 20, pattern: "dispersal", tick: this.tick };
        this.anomalyFiring = true;
      } else if (rise <= 1 && this.anomalyFiring && (!this.anomaly || !this.anomaly.active)) {
        // spread settled AND banner finished -> re-arm so a later burst can fire again
        this.anomalyFiring = false;
      }
    }
    this.prevSpreadR = spreadR;

    // capture the beam position BEFORE this tick's update, so the reason text can
    // describe the actual direction of movement (fixes "left" showing while steering right)
    const prevFanCenter = this.fanCenter;

    // ONE centroid. Smooth it lightly so it isn't jumpy.
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

    // Point 2 & 3: beam math derives from the centroid. The forecasting MODE decides
    // whether we aim AT the crowd (reactive) or AHEAD of it (lead/momentum), via a
    // deterministic tool step with a confidence gate + UE floor. Same model either way.
    const { aim, effectiveMode } = this._aimForMode(this.centroid.az, load);
    params.fan_center = +aim.toFixed(2);
    params.tilt = +beamRangeTilt.toFixed(1);

    // --- SMO: validate + format into A1/O1 (deterministic tool) ---
    const ts = Date.now();
    const formatted = validateAndFormat(params, {
      currentFanCenter: this.fanCenter, currentTilt: this.tilt, ts
    });

    // apply the committed target
    this.fanCenter = formatted.a1Policy.target.fan_center_deg;
    this.tilt = formatted.a1Policy.target.tilt_deg;
    this.lastGoodFan = this.fanCenter;   // remember for UE-floor hold

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

    // direction-aware reason, computed from the ACTUAL committed move (post-clamp),
    // and annotated with the effective forecasting mode so the audit text is honest
    // about whether we led, followed, or held.
    const committedFan = this.fanCenter;
    let dir;
    if (committedFan > prevFanCenter + 1) dir = "right";
    else if (committedFan < prevFanCenter - 1) dir = "left";
    else dir = "hold";
    let reasonText;
    if (effectiveMode === "hold") {
      reasonText = "holding last position, too few UEs to track reliably";
    } else if (dir === "hold") {
      reasonText = "holding on the count-weighted centroid";
    } else if (effectiveMode === "lead") {
      reasonText = `leading ${dir} ahead of the crowd on steady motion`;
    } else if (effectiveMode === "momentum") {
      reasonText = `steering ${dir} with momentum toward the centroid`;
    } else {
      reasonText = `steering the fan ${dir} toward the count-weighted centroid`;
    }

    // rolling proposal history (oldest first, newest at end, keep last 100) with timestamps
    this.proposalHistory = this.proposalHistory || [];
    const t = new Date();
    const hhmmss = t.toTimeString().slice(0, 8);
    this.proposalHistory.push({
      t: hhmmss,
      tick: this.tick,
      fan_center: params.fan_center,
      tilt: params.tilt,
      action: params.action,
      mode: effectiveMode,
      reason: reasonText
    });
    if (this.proposalHistory.length > 100) this.proposalHistory.shift();
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
      forecastMode: this.mode,
      anomaly: this.anomaly,
      anomalyArmed: this.anomalyArmed,
      action: this.lastProposal?.action || "follow",
      proposals: this.proposalHistory || [],
      escalation: this.escalation,
      log: this.lastLog,
      model: MODEL_INFO
    };
  }
}
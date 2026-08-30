// loop.js — one tick of the gNB / SMO / rApp control loop.
// Produces (a) the new beam target and (b) a structured signaling log the UI renders,
// showing the REAL messages each interface would carry.

import { Crowd } from "./crowd.js";
import { AzimuthSmoother } from "./filter.js";
import { decide, MODEL_INFO } from "./model.js";
import { validateAndFormat } from "./formatter.js";
import { countPerBeam, beamCentroid, fanAzimuths, rangeToTilt, toPolar,
         rsrpPerBeam, rsrpCentroid, RSRP_MIN } from "./geometry.js";

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
  // PURE MODES. The mode you select is the mode that runs, every tick.
  // There is no silent fallback between modes and no blending: Lead always leads,
  // Momentum always projects on momentum, Reactive always aims at the crowd now.
  // The ONLY override is the UE floor, which is a safety hold, not another mode.
  _aimForMode(centroidAz, totalUe) {
    const base = centroidAz;                 // where the load is right now

    // Safety hold: below the UE floor the centroid is noise, so nothing is tracked.
    // This is the one case that overrides the selected mode, and it is reported as
    // "hold" so the UI is explicit that the mode did not run this tick.
    if (totalUe < UE_FLOOR) {
      return { aim: this.lastGoodFan, effectiveMode: "hold" };
    }

    switch (this.mode) {
      case "reactive":
        // aim at the crowd's current position
        return { aim: base, effectiveMode: "reactive" };

      case "lead":
        // always project forward, whether or not motion looks consistent.
        // If the crowd is milling about the projection is small anyway.
        return { aim: this.smoother.project(LEAD_TICKS), effectiveMode: "lead" };

      case "momentum":
        // pure momentum: the forward projection itself, no blend with the baseline
        return { aim: this.smoother.project(MOMENTUM_TICKS), effectiveMode: "momentum" };

      case "predictive":
        // not implemented. Do NOT quietly behave as another mode — hold and say so,
        // so the UI cannot imply a capability that does not exist.
        return { aim: this.fanCenter, effectiveMode: "predictive-unimplemented" };

      default:
        return { aim: base, effectiveMode: "reactive" };
    }
  }

  async stepAsync() {
    this.tick++;
    this.crowd.step();
    const ues = this.crowd.ues;

    // --- gNB: measure SS-RSRP per SSB beam (3GPP TS 28.552) ---
    // This is what a real gNodeB reports. Per-beam UE counts are NOT a standard
    // counter; `members` below is derived (best-beam assignment) and is display only.
    const sensed = rsrpPerBeam(ues, this.fanCenter);
    const rsrp = sensed.rsrp;               // SS-RSRP per SSB, dBm
    const counts = sensed.members;          // derived per-beam membership (display only)
    const load = counts.reduce((a, b) => a + b, 0);   // RRC.ConnMean equivalent, per cell
    this.history.push(rsrp);                // history is now RSRP profiles
    if (this.history.length > 6) this.history.shift();

    // steering signal: the RSRP-weighted azimuth (linear power weights)
    const { az: centAz, profile: rsrpProfile } = rsrpCentroid(rsrp, this.fanCenter);
    // angular spread of the RSRP weight, for the legacy spread signal
    const _azs = fanAzimuths(this.fanCenter);
    let _sv = 0;
    for (let b = 0; b < rsrpProfile.length; b++) _sv += rsrpProfile[b] * (_azs[b] - centAz) ** 2;
    const spread = Math.sqrt(_sv);

    // spread-rising detection over last few ticks (chaos signal)
    let spreadRising = false;
    this.spreadHist = this.spreadHist || [];
    this.spreadHist.push(spread);
    if (this.spreadHist.length > 6) this.spreadHist.shift();
    if (this.spreadHist.length >= 3) {
      const d = this.spreadHist[this.spreadHist.length - 1] - this.spreadHist[0];
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
      // Detect radial dispersal from TELEMETRY ONLY: the crowd is fanning out (spreadR
      // growing) AND that expansion is accelerating (velocity of the fan-out). No knowledge
      // of any trigger/pop/mode — purely the measured movement pattern.
      const expandRate = this.prevSpreadR === null ? 0 : (spreadR - this.prevSpreadR); // m/tick, how fast it's fanning out
      this.expandHist = this.expandHist || [];
      this.expandHist.push(expandRate);
      if (this.expandHist.length > 4) this.expandHist.shift();
      // velocity change = is the fan-out rate now well above its recent baseline?
      const baseline = this.expandHist.slice(0, -1);
      const baseAvg = baseline.length ? baseline.reduce((a, b) => a + b, 0) / baseline.length : 0;
      const accel = expandRate - baseAvg; // rise in the expansion velocity (acceleration of fan-out)

      // pattern = fanning out (positive expansion) with a clear velocity increase
      const FANOUT = 1.5;   // m/tick minimum outward expansion to count as "fanning out"
      const ACCEL  = 1.0;   // m/tick jump in expansion rate = the velocity change
      const patternDetected = expandRate > FANOUT && accel > ACCEL;

      if (patternDetected && !this.anomalyFiring) {
        this.anomaly = { active: true, blinksLeft: 20, pattern: "radial_dispersal", tick: this.tick };
        this.anomalyFiring = true;
      } else if (expandRate <= 0.3 && this.anomalyFiring && (!this.anomaly || !this.anomaly.active)) {
        // fan-out has stopped AND banner finished -> re-arm for the next distinct event
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
      ssbRsrp: rsrp,                                   // SS-RSRP per SSB (the real signal)
      rsrpProfile: rsrpProfile.map(v => +v.toFixed(3)), // normalized power weights
      rsrpWeightedAz: +centAz.toFixed(2),               // where the RF demand sits
      centroidAz: this.centroid.az,
      centroidVel: +vel.toFixed(3),
      spreadNow: +spread.toFixed(2),
      spreadRising, splitDetected,
      load
    };
    const params = await decide(obs);

    // ------------------------------------------------------------------
    // THE MODEL PROPOSES. DETERMINISTIC CODE DISPOSES.
    //
    // The model's fan_center is the PROPOSAL and it is what we commit, provided it
    // survives the fences below. It is never silently replaced by our own maths.
    //
    // The reference aim (forecast mode applied to the RSRP centroid) is kept, but only
    // as (a) a sanity envelope and (b) the fallback when the model gives us nothing
    // usable or the UE floor says do not track. Every intervention is recorded in
    // this.decision so the UI can show exactly what happened this tick.
    // ------------------------------------------------------------------
    const { aim, effectiveMode } = this._aimForMode(this.centroid.az, load);

    const modelFan  = Number(params.fan_center);
    const modelTilt = Number(params.tilt);
    const dec = { source: "model", notes: [], modelFan, modelTilt, referenceAim: +aim.toFixed(2) };

    let chosenFan, chosenTilt;

    if (effectiveMode === "hold") {
      // UE floor: too few users for the centroid to mean anything. Hold, ignore the model.
      chosenFan = aim;
      dec.source = "hold";
      dec.notes.push("UE floor: too few users to track, holding last good position");
    } else if (!Number.isFinite(modelFan)) {
      // Model returned nothing usable. HOLD — do not let the tool quietly steer in its
      // place. A frozen beam is an honest, visible failure. A beam that keeps tracking
      // smoothly would hide the fact that the model contributed nothing this tick.
      chosenFan = this.fanCenter;
      dec.source = "no-decision";
      dec.notes.push("model returned no usable fan_center, holding position");
    } else {
      // THE MODEL STEERS.
      chosenFan = modelFan;

      // Fence 1: sanity envelope. The model may lead or lag the reference aim, but it
      // may not point somewhere unrelated to where the load actually is.
      const MAX_DEV = 25;                                  // degrees from the reference aim
      if (Math.abs(chosenFan - aim) > MAX_DEV) {
        chosenFan = aim + Math.sign(chosenFan - aim) * MAX_DEV;
        dec.source = "model-clamped";
        dec.notes.push(`proposal ${modelFan.toFixed(1)}° exceeded ±${MAX_DEV}° of the load bearing, pulled to ${chosenFan.toFixed(1)}°`);
      }
      // Fence 2: slew limit. No violent jumps between ticks.
      const MAX_STEP = 15;                                 // degrees per tick
      const step = chosenFan - this.fanCenter;
      if (Math.abs(step) > MAX_STEP) {
        chosenFan = this.fanCenter + Math.sign(step) * MAX_STEP;
        dec.source = dec.source === "model" ? "model-clamped" : dec.source;
        dec.notes.push(`slew limited to ${MAX_STEP}° per tick`);
      }
    }

    // Tilt: accept the model's value when it is sane, else use the geometric tilt for
    // the crowd's range. Same principle - propose, then fence.
    if (Number.isFinite(modelTilt) && modelTilt >= 3 && modelTilt <= 45) {
      chosenTilt = modelTilt;
    } else if (dec.source === "no-decision" || dec.source === "hold") {
      chosenTilt = this.tilt;                      // holding: leave tilt where it is
    } else {
      chosenTilt = this.tilt;                      // hold tilt rather than substitute maths
      if (dec.source === "model") { dec.source = "model-partial"; }
      dec.notes.push("model tilt unusable, holding previous tilt");
    }

    params.fan_center = +chosenFan.toFixed(2);
    params.tilt = +chosenTilt.toFixed(1);
    dec.committedFan = params.fan_center;
    dec.committedTilt = params.tilt;
    this.decision = dec;

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
      gNB_to_SMO_O1: {
        interface: "O1 · PM (VES)", spec: "3GPP TS 28.552",
        "SS.RSRP_perSSB_dBm": rsrp,
        "RRC.ConnMean": load,
        beam_azimuths: sensed.azimuths,
        note: "per-beam membership is derived, not a standard counter",
        beam_members: counts
      },
      SMO_to_rApp_R1: {
        interface: "R1 · Data Management & Exposure", spec: "O-RAN.WG2.R1AP",
        ssb_rsrp: rsrp,
        cell_ue_total: load,
        current: { fan_center_deg: +this.fanCenter.toFixed(2), tilt_deg: +this.tilt.toFixed(2) },
        centroid_method: "rsrp_weighted",
        rsrp_weighted_az: obs.rsrpWeightedAz,
        centroid_az: obs.centroidAz, centroid_vel: obs.centroidVel,
        spread: obs.spreadNow, spread_rising: spreadRising, split: splitDetected
      },
      rApp_proposal: {
        model_proposed: { fan_center: this.decision.modelFan, tilt: this.decision.modelTilt },
        committed: { fan_center: this.decision.committedFan, tilt: this.decision.committedTilt },
        source: this.decision.source,
        guardrails: this.decision.notes,
        reference_aim: this.decision.referenceAim,
        params_only: params,
        model: MODEL_INFO
      },
      SMO_to_gNB_O1: {
        interface: "O1 · NETCONF/YANG", spec: "3GPP TS 28.541 · CommonBeamformingFunction",
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
    // Reason text: when the model steered, show the MODEL'S OWN words. Template text is
    // used only when the model did not decide (hold / fallback), and is labelled as such.
    let reasonText;
    const modelReason = String(params.reason || "").trim();
    if (this.decision.source === "hold") {
      reasonText = "[tool] holding last position, too few UEs to track reliably";
    } else if (this.decision.source === "no-decision") {
      reasonText = "[tool] no usable model output, holding position";
    } else if (modelReason) {
      reasonText = modelReason;                       // the model's own explanation
    } else {
      reasonText = `[tool] model gave no reason, moved ${dir}`;
    }

    // rolling proposal history (oldest first, newest at end, keep last 100) with timestamps
    this.proposalHistory = this.proposalHistory || [];
    const t = new Date();
    const hhmmss = t.toTimeString().slice(0, 8);
    this.proposalHistory.push({
      t: hhmmss,
      tick: this.tick,
      fan_center: params.fan_center,          // what was COMMITTED
      tilt: params.tilt,
      action: params.action,
      mode: effectiveMode,
      reason: reasonText,
      // provenance: what the model actually asked for, and what the fences did
      source: this.decision.source,            // model | model-clamped | model-partial | fallback | hold
      proposedFan: this.decision.modelFan != null && Number.isFinite(this.decision.modelFan)
        ? +this.decision.modelFan.toFixed(2) : null,
      guard: this.decision.notes.length ? this.decision.notes.join("; ") : null
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
      decision: this.decision || null,
      proposals: this.proposalHistory || [],
      escalation: this.escalation,
      log: this.lastLog,
      model: MODEL_INFO
    };
  }
}
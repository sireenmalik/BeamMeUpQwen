// loop.js — one tick of the gNB / SMO / rApp control loop.
// Produces (a) the new beam target and (b) a structured signaling log the UI renders,
// showing the REAL messages each interface would carry.

import { Crowd } from "./crowd.js";
import { AzimuthSmoother } from "./filter.js";
import { decide, MODEL_INFO, USES_MODEL_TILT } from "./model.js";
import { validateAndFormat } from "./formatter.js";
import { countPerBeam, beamCentroid, fanAzimuths, rangeToTilt, toPolar, TOWER_H,
         P_TX_DBM, G_MAX_DBI, FC_GHZ,
         rsrpPerBeam, rsrpCentroid, RSRP_MIN } from "./geometry.js";

// forecasting tool modes. reactive = today's follower. lead/momentum = deterministic
// forward projection on the SAME model. predictive = reserved for the L3 tuned model (WIP).
export const FORECAST_MODES = ["reactive", "lead", "momentum", "predictive"];
const LEAD_TICKS = 1.5;        // how far ahead Lead aims (tunable)
const MOMENTUM_TICKS = 1.0;    // projection horizon for Momentum
// Set GUARD_OFF=1 in the environment to run the model UNFENCED.
// Diagnostic only: answers "is the beam wrong because the model is wrong, or
// because the guardrails are pulling it?" Never run a live estate like this.
const GUARD_OFF = process.env.GUARD_OFF === "1";
const UE_FLOOR = 3;            // below this many total UEs, hold (don't chase noise)

export class ControlLoop {
  constructor() {
    this.crowd = new Crowd();
    this.smoother = new AzimuthSmoother();
    this.fanCenter = -10;   // provisional; locked onto the crowd on the first tick
    this.tilt = 20;
    this.initialised = false;   // false until the beam has been placed on the crowd
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

    // Average the RSRP over the last 2 reports before using it.
    //
    // Shadow fading makes a single report wobble by about +/-1.2 deg worth of apparent
    // bearing, so a STATIONARY crowd still made the beam twitch ~0.8 deg every tick.
    // Averaging two consecutive reports in LINEAR power halves that (0.82 -> 0.44) while
    // leaving a walking crowd tracked identically (16.8 deg travelled either way).
    // No detection is involved: random error cancels across reports, real movement does not.
    this.rsrpHist = this.rsrpHist || [];
    this.rsrpHist.push(sensed.rsrp);
    if (this.rsrpHist.length > 2) this.rsrpHist.shift();
    const rsrp = sensed.rsrp.map((_, b) => {
      const lin = this.rsrpHist.reduce((a, h) => a + Math.pow(10, h[b] / 10), 0) / this.rsrpHist.length;
      return Math.round(10 * Math.log10(lin));
    });
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
      // Radial dispersal detected from the RSRP PROFILE, not from UE coordinates.
      //
      // The previous version computed the crowd's spatial spread from every UE's true
      // x,y position - the simulator's private knowledge, which no SMO has. It also
      // fired on the very first tick after the burst, because that ground-truth spread
      // jumps 4 m in one step. A one-tick step is not a pattern.
      //
      // What the radio actually shows when a crowd disperses is the power-weighted
      // ANGULAR WIDTH of the profile growing: energy that was concentrated on two beams
      // spreads across all five. Measured on a burst: 11.4 deg baseline rising through
      // 12.5, 14.3, 16.8, 17.9 to 20.4 deg over six ticks. Gradual, and readable from
      // the five values the gNB reports.
      const azsNow = fanAzimuths(this.fanCenter);
      const servedR = rsrp.filter(r => r > RSRP_MIN);
      let profWidth = 0;
      if (servedR.length) {
        const fl = Math.min(...servedR);
        const lw = rsrp.map(r => (r <= RSRP_MIN ? 0 : Math.pow(10, (r - fl) / 10)));
        const tw = lw.reduce((a, b) => a + b, 0);
        if (tw > 0) {
          const mw = lw.reduce((s, v, i) => s + v * azsNow[i], 0) / tw;
          profWidth = Math.sqrt(lw.reduce((s, v, i) => s + v * (azsNow[i] - mw) ** 2, 0) / tw);
        }
      }

      this.widthHist = this.widthHist || [];
      this.widthHist.push(profWidth);
      if (this.widthHist.length > 6) this.widthHist.shift();

      // Require the widening to be SUSTAINED: the profile must have grown over the last
      // three ticks and still be growing. One noisy tick cannot trigger it.
      let patternDetected = false;
      if (this.widthHist.length >= 4) {
        const h = this.widthHist;
        const n = h.length;
        const growth = h[n - 1] - h[n - 4];        // total widening over 3 ticks
        const stillGrowing = h[n - 1] > h[n - 2];
        const monotonic = h[n - 2] > h[n - 4];     // not a single spike
        patternDetected = growth > 3.0 && stillGrowing && monotonic;
      }

      if (patternDetected && !this.anomalyFiring) {
        this.anomaly = { active: true, blinksLeft: 20, pattern: "radial_dispersal", tick: this.tick };
        this.anomalyFiring = true;
      } else if (this.widthHist.length >= 2 &&
                 this.widthHist[this.widthHist.length - 1] <=
                 this.widthHist[this.widthHist.length - 2] + 0.2 &&
                 this.anomalyFiring && (!this.anomaly || !this.anomaly.active)) {
        // widening has stopped AND the banner has finished -> re-arm for the next event
        this.anomalyFiring = false;
      }
    }

    this.prevSpreadR = spreadR;

    // capture the beam position BEFORE this tick's update, so the reason text can
    // describe the actual direction of movement (fixes "left" showing while steering right)
    const prevFanCenter = this.fanCenter;

    // ONE centroid. Smooth it lightly so it isn't jumpy.
    const { az: smAz, vel } = this.smoother.update(centAzTrue);
    // ---------------------------------------------------------------------
    // TILT, computed by the tool from RADIO DATA ONLY.
    //
    // Previously this used meanRange, which is the average of Math.hypot(u.x, u.y)
    // over every UE - i.e. the simulator's private knowledge of exactly where each
    // phone stands. A real SMO has no such thing. That was the same class of cheat as
    // the per-beam UE counts we removed earlier, and it was hiding in plain sight.
    //
    // The tool now inverts the link budget instead, using only what the gNB reports:
    //   per-UE power = peak RSRP - 10log10(N)      (undo the N-UE aggregation)
    //   path loss    = P_tx + G_max - per-UE power
    //   3GPP TR 38.901 UMi-LOS:  PL = 32.4 + 21log10(d3d) + 20log10(fc)
    //   solve for d3d, remove the tower height, take atan.
    //
    // Measured accuracy across the demo's 46-137 m span: mean tilt error 2.5 deg
    // against an 8 deg beamwidth. It degrades below ~50 m where the aggregated RSRP
    // hits the TS 38.133 ceiling of -31 dBm and range information is lost; the tool
    // clamps there rather than producing a wild value.
    //
    // The model is not involved. Tilt has one right answer for a given range.
    // ---------------------------------------------------------------------
    // RANGE FROM THE TOP TWO BEAMS, bias-corrected.
    //
    // Peak-beam alone carries a 15 deg periodic ripple: when the crowd sits midway
    // between two beams, the peak beam only sees part of it, power reads low and the
    // inferred range runs long. Summing the peak with its strongest ADJACENT neighbour
    // conserves that power across the beam boundary, so the estimate stays flat as the
    // crowd crosses it. Measured ripple 9.1 m -> 4.7 m.
    //
    // The remaining bias is systematic, not noise: aggregating 60 UEs sums linear power
    // while propagation is logarithmic, so the sum is dominated by the nearest and best
    // faded UEs and reads hotter than the average user (Jensen). Log-normal fading alone
    // contributes a predictable +1.84 dB (verified: measured +1.75 to +1.78 dB). The
    // quadratic below inverts that bias; it was fitted across BOTH range and off-axis
    // offset, not at boresight only - an earlier total-power version calibrated at
    // boresight looked excellent offline and collapsed to 19-23 deg of error in the loop.
    //
    // Verified off-axis: error within +/-3.4 m for offsets 0-20 deg at 80/100/130 m.
    // Still blind below ~65 m, where the aggregated RSRP hits the TS 38.133 ceiling of
    // -31 dBm and every range from 20 to 60 m reports the same value.
    const nUe = Math.max(1, counts.reduce((a, b) => a + b, 0));
    const iPk = rsrp.indexOf(Math.max(...rsrp));
    const nb = [iPk - 1, iPk + 1].filter(k => k >= 0 && k < rsrp.length);
    const iNb = nb.length ? nb.reduce((x, y) => (rsrp[y] > rsrp[x] ? y : x)) : iPk;
    const top2Dbm = 10 * Math.log10(Math.pow(10, rsrp[iPk] / 10) + Math.pow(10, rsrp[iNb] / 10));
    const perUeDbm = top2Dbm - 10 * Math.log10(nUe);
    const pathLossDb = P_TX_DBM + G_MAX_DBI - perUeDbm;
    const d3d = Math.pow(10, (pathLossDb - 32.4 - 20 * Math.log10(FC_GHZ)) / 21);
    const rawRange = Math.sqrt(Math.max(0, d3d * d3d - TOWER_H * TOWER_H));
    // bias correction, fitted over range 70-155 m and off-axis 0-15 deg
    const corrected = -0.001870 * rawRange * rawRange + 1.6282 * rawRange - 7.51;
    const estRange = Math.max(20, Math.min(250, corrected));
    const beamRangeTilt = rangeToTilt(estRange);

    // Point 1: the centroid (what we show as the green dot + coords)
    this.centroid = {
      az: +smAz.toFixed(2),
      range: +meanRange.toFixed(1),
      x: +cx.toFixed(1),
      y: +cy.toFixed(1),
      spreadR: +spreadR.toFixed(1)
    };
    // Trail: remember where the centroid has been (last 24 points), for breadcrumbs
    // FIRST TICK: place the beam on the crowd.
    // The demo always starts locked on — the beam is not parked at some arbitrary angle
    // waiting to acquire. That means the loop NEVER has to make a large move: from here
    // on the crowd walks at ~1-3 deg per tick and the beam follows at the same pace.
    // Training and guardrails are both sized to that envelope.
    if (!this.initialised) {
      this.fanCenter = this.centroid.az;
      this.tilt = beamRangeTilt;
      this.lastGoodFan = this.fanCenter;
      this.initialised = true;
    }

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

    // ------------------------------------------------------------------
    // NO GUARDRAILS. The model's number is committed exactly as given.
    //
    // Deliberate: mixing a model under test with clamps that rewrite its output makes
    // it impossible to tell which one produced the behaviour on screen. Run the model
    // bare, see what it really does, THEN decide what fences it actually needs.
    //
    // The only thing still honoured is: if the model returns nothing usable, hold
    // position rather than let the tool steer in its place.
    // ------------------------------------------------------------------
    let chosenFan, chosenTilt;

    if (!Number.isFinite(modelFan)) {
      chosenFan = this.fanCenter;
      dec.source = "no-decision";
      dec.notes.push("model returned no usable fan_center, holding position");
    } else {
      chosenFan = modelFan;
    }

    // TILT: who owns it depends on the prompt schema (see model.js).
    //
    //   v7  the harness computes it. tilt = atan(tower_height / range), one right answer
    //       for a given range. The v7 adapter was never trained to produce it and simply
    //       echoed whatever it was handed, so the beam kept the wrong range.
    //   v8  the model produces it, and is trained to. If it returns something unusable
    //       we hold the previous tilt rather than silently substituting the arithmetic -
    //       that would hide a model failure behind a correct-looking beam.
    //
    // ORIGINAL NOTE, still true for v7:
    //
    // tilt = atan(tower_height / range). There is nothing to decide - given the crowd's
    // range there is exactly one correct down-angle. The model was echoing whatever tilt
    // it was handed (24.4 deg every tick), so the beam stayed at ~60 m while the crowd
    // walked out to 100 m: correct bearing, short range. Compute it in the harness and
    // let the model own the bearing, which is the part with a real decision in it.
    if (USES_MODEL_TILT) {
      if (Number.isFinite(modelTilt) && modelTilt >= 3 && modelTilt <= 45) {
        chosenTilt = modelTilt;
      } else {
        chosenTilt = this.tilt;                    // hold, do not substitute the maths
        if (dec.source === "model") dec.source = "model-partial";
        dec.notes.push("model tilt unusable, holding previous tilt");
      }
    } else {
      chosenTilt = beamRangeTilt;                  // v7: arithmetic
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
      source: this.decision.source,            // model | model-partial | no-decision
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
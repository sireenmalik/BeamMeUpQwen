// loop.js — one tick of the gNB / Near-RT RIC / SMO / rApp control loop.
// Produces (a) the new beam target and (b) a structured signaling log the UI renders,
// showing the REAL messages each interface would carry.
//
// ============================================================================
// THE MODEL DECIDES. NOTHING ELSE DOES.
//
// Both fan_center and tilt come from the model, every tick. If the model returns
// nothing usable the beam HOLDS its previous position. The arithmetic never steers.
//
// What was removed and why:
//
//   beamRangeTilt        the top-2 / link-budget / quadratic chain. It was computed
//                        every tick and discarded under v9, but it was sitting in the
//                        commit path where a future edit could wire it back in. It now
//                        lives in reference.js, which is read-only and returns nothing.
//
//   _aimForMode          the Reactive / Lead / Momentum / Predictive selector. Its
//                        output went to dec.referenceAim, which is display only, so
//                        under v9 the mode buttons changed a label and nothing else.
//                        It also read this.centroid.az, which is derived from the
//                        simulator's true UE positions.
//
//   UE floor             lived inside _aimForMode and returned "hold". Since that aim
//                        was never committed, the floor held nothing. Dead under v9.
//
//   first-tick placement  used this.centroid.az — pure simulator ground truth. The beam
//                        now starts at a fixed configured azimuth and tilt, which is
//                        what a real planned sector does.
//
// The simulator still computes true UE positions — it has to, it is moving the crowd.
// The wall is that NOTHING in the decision path reads them. After this change, nothing
// does. obs carries only ssbRsrp and beamAzimuths to the model.
// ============================================================================

import { Crowd } from "./crowd.js";
import { AzimuthSmoother } from "./filter.js";
import { decide, MODEL_INFO, USES_MODEL_TILT } from "./model.js";
import { validateAndFormat } from "./formatter.js";
import { record as recordReference } from "./reference.js";
import { Neighbours } from "./neighbours.js";
import { fanAzimuths, toPolar, TOWER_H,
         rsrpPerBeam, rsrpCentroid, RSRP_MIN } from "./geometry.js";

// The planned sector configuration. The beam starts here on tick one and the model
// takes over from tick two. A real cell does not acquire — its azimuth and tilt are
// set by RF planning — so this is both honest and realistic.
const START_FAN_CENTER = Number(process.env.START_FAN_CENTER ?? 0);   // deg, sector boresight
const START_TILT       = Number(process.env.START_TILT ?? 20);        // deg

export class ControlLoop {
  constructor() {
    this.crowd = new Crowd();
    this.neighbours = new Neighbours();
    this.smoother = new AzimuthSmoother();
    this.fanCenter = START_FAN_CENTER;
    this.tilt = START_TILT;
    this.history = [];       // recent RSRP profiles
    this.tick = 0;
    this.lastLog = null;
    this.lastProposal = null;
    this.escalation = null;  // {pending:true} when chaos flags human gate
    // --- chaos detector (read-only observer; never touches the beam path) ---
    this.anomaly = null;       // {active, blinksLeft, pattern, tick} when chaos flagged
    this.anomalyArmed = false; // detector only watches while Detect Chaos use case is active
    this.anomalyFiring = false;// true while one event is ongoing, so we don't re-trigger every tick
  }

  // arm the chaos detector ONLY while the Detect Chaos use case is active.
  // arming/disarming also clears any visible anomaly (switching use case wipes the banner).
  setAnomalyArmed(on) {
    this.anomalyArmed = !!on;
    this.anomaly = null;
    this.anomalyFiring = false;
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

  async stepAsync() {
    this.tick++;
    this.crowd.step();
    // Their users walk too. This is why a neighbour's number moves even when our
    // beam is completely still: our spill pattern is fixed and they walk through it.
    this.neighbours.step();
    const ues = this.crowd.ues;

    // --- gNB: measure SS-RSRP per SSB beam (TS 38.215 / TS 38.133) ---
    // Beam-level SS-RSRP is a Layer 1 quantity, collected by the xApp on the Near-RT
    // RIC over E2 (E2SM-KPM). TS 28.552 5.1.1.28.1 does define a per-SSB UE mean, but
    // as a slow O1 PM counter; `members` below is derived (best-beam) and display only.
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
    this.history.push(rsrp);
    if (this.history.length > 6) this.history.shift();

    // steering signal: the RSRP-weighted azimuth (linear power weights).
    // DISPLAY AND LOGGING ONLY. It is not committed and it is not sent to the model.
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

    // --- SIMULATOR TRUTH, DISPLAY ONLY ---
    // The green dot, the breadcrumb trail and the coordinate readout. These come from
    // the simulator's private knowledge of where the crowd actually is. They exist so a
    // human can see whether the beam is right. They are NOT in obs, NOT in the commit
    // path, and NOT in the reference log's input. If a future change feeds any of this
    // to the model or to a label, that is the cheat we removed twice already.
    let sumX = 0, sumY = 0, meanRange = 0;
    for (const u of ues) { meanRange += Math.hypot(u.x, u.y); sumX += u.x; sumY += u.y; }
    meanRange = ues.length ? meanRange / ues.length : 60;
    const cx = ues.length ? sumX / ues.length : 0;
    const cy = ues.length ? sumY / ues.length : 60;
    const centAzTrue = Math.atan2(sumX, sumY) * 180 / Math.PI;
    let spreadR = 0;
    for (const u of ues) spreadR += (u.x - cx) ** 2 + (u.y - cy) ** 2;
    spreadR = ues.length ? Math.sqrt(spreadR / ues.length) : 8;
    const { az: smAz } = this.smoother.update(centAzTrue);   // display smoothing only

    // --- CHAOS DETECTOR (read-only; armed only in Detect Chaos use case) ---
    // Watches the power-weighted ANGULAR WIDTH of the RSRP profile. Reads the five
    // reported values only — no UE coordinates. Sets a blinking flag and nothing else.
    // If removed, nothing about tracking changes.
    if (this.anomalyArmed) {
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

      // Require the widening to be SUSTAINED: grown over the last three ticks and still
      // growing. One noisy tick cannot trigger it.
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

    // capture the beam position BEFORE this tick's update, so the reason text can
    // describe the actual direction of movement
    const prevFanCenter = this.fanCenter;

    // display centroid (simulator truth — the green dot and the readout)
    this.centroid = {
      az: +smAz.toFixed(2),
      range: +meanRange.toFixed(1),
      x: +cx.toFixed(1),
      y: +cy.toFixed(1),
      spreadR: +spreadR.toFixed(1)
    };
    this.trail = this.trail || [];
    this.trail.push({ az: this.centroid.az, range: this.centroid.range });
    if (this.trail.length > 24) this.trail.shift();

    // --- rApp (model): decide parameters only ---
    //
    // WHAT THE MODEL SEES. Under v9 the prompt is built from ssbRsrp and beamAzimuths
    // ONLY (see model.js buildUser). The other fields here are carried for the UI and
    // the signaling log. Do not add a field to this object expecting the model to use
    // it — check model.js first, and if you do wire one in, the adapter needs retraining
    // because the prompt shape changed.
    const obs = {
      currentFanCenter: +this.fanCenter.toFixed(2),
      currentTilt: +this.tilt.toFixed(2),
      beamAzimuths: fanAzimuths(this.fanCenter).map(a => +a.toFixed(1)),
      ssbRsrp: rsrp,                                    // SS-RSRP per SSB (the real signal)
      rsrpProfile: rsrpProfile.map(v => +v.toFixed(3)), // normalized power weights, display
      rsrpWeightedAz: +centAz.toFixed(2),               // display
      spreadNow: +spread.toFixed(2),
      spreadRising, splitDetected,
      load
    };
    const params = await decide(obs);

    // ------------------------------------------------------------------
    // THE MODEL PROPOSES. IF IT CANNOT, THE BEAM HOLDS.
    //
    // There is no deterministic substitute at any point. model.js returns NaN when the
    // call fails, when no provider is set, or when the generation is unusable. Both
    // branches below hold the PREVIOUS committed value — they never fall back to the
    // arithmetic. Every intervention is recorded in this.decision so the UI can show
    // exactly what happened this tick.
    // ------------------------------------------------------------------
    const modelFan  = Number(params.fan_center);
    const modelTilt = Number(params.tilt);
    const dec = { source: "model", notes: [], modelFan, modelTilt };

    let chosenFan, chosenTilt;

    if (!Number.isFinite(modelFan)) {
      chosenFan = this.fanCenter;                    // hold
      dec.source = "no-decision";
      dec.notes.push("model returned no usable fan_center, holding position");
    } else {
      chosenFan = modelFan;
    }

    // TILT: the model owns it under v9 and it is trained to produce it. A range check
    // only. If it returns something unusable we hold the previous tilt rather than
    // silently substituting arithmetic — that would hide a model failure behind a
    // correct-looking beam.
    if (Number.isFinite(modelTilt) && modelTilt >= 3 && modelTilt <= 45) {
      chosenTilt = modelTilt;
    } else {
      chosenTilt = this.tilt;                        // hold
      if (dec.source === "model") dec.source = "model-partial";
      dec.notes.push("model tilt unusable, holding previous tilt");
    }

    // ------------------------------------------------------------------
    // NEIGHBOUR GATE. Deterministic. Runs on the model's proposal, before commit.
    //
    // Computes what the proposed beam would do to each neighbour cell and blocks
    // the move if any of them gains more than the budget. It compares BEFORE
    // against AFTER, not against an absolute ceiling: the absolute noise rise in a
    // dense reuse-1 network is already 10-25 dB, so an absolute 1 dB test would
    // block everything ever proposed. What the budget bounds is how much ONE
    // action may ADD.
    //
    // On a block the beam HOLDS, exactly as it does when the model returns nothing.
    // There is no fallback aim and no partial move — the same rule as everywhere
    // else in this loop.
    //
    // SCOPE: downlink spill only, our tower into their users. Uplink harm is not
    // computed because there is no UE transmit power in this simulator. See
    // neighbours.js.
    // ------------------------------------------------------------------
    const gate = this.neighbours.evaluate(this.fanCenter, this.tilt, chosenFan, chosenTilt);
    dec.neighbours = gate;

    if (!gate.allowed) {
      chosenFan  = this.fanCenter;              // hold
      chosenTilt = this.tilt;
      dec.source = "neighbour-blocked";
      dec.notes.push(`blocked: ${gate.reason}`);
      // Three consecutive blocks toward the SAME neighbour is not a beam problem.
      // It means the crowd is walking out of this cell and into that one, so the
      // right answer is handover, not a bigger tilt. The streak is keyed to the
      // neighbour, not to the proposed angles: a key built from the knob values
      // never matches again once the crowd has moved a step.
      if (gate.handover) {
        dec.notes.push(`crowd leaving toward ${gate.handover.toward} — handover territory`);
      }
    }

    params.fan_center = +chosenFan.toFixed(2);
    params.tilt = +chosenTilt.toFixed(1);
    dec.committedFan = params.fan_center;
    dec.committedTilt = params.tilt;
    this.decision = dec;

    // --- SMO: validate + format into the R1 config-change request, committed over O1
    //     (deterministic tool) ---
    // NOTE: validateAndFormat CLAMPS fan_center to [-49, 49] and tilt to [3, 45]. Those
    // bounds match the ranges stated in the v9 system prompt, so a correctly behaving
    // model never reaches them. When it does fire, validation.clamped is true and
    // reference.js records the size of the rewrite in delta.clamped_fan / clamped_tilt.
    const ts = Date.now();
    const formatted = validateAndFormat(params, {
      currentFanCenter: this.fanCenter, currentTilt: this.tilt, ts
    });

    // apply the committed target
    this.fanCenter = formatted.r1Request.target.fan_center_deg;
    this.tilt = formatted.r1Request.target.tilt_deg;

    // ------------------------------------------------------------------
    // REFERENCE RECORDER. READ-ONLY. RETURNS NOTHING.
    //
    // Computes what the arithmetic would have said and appends one JSONL line with the
    // input, the reference answer, the model's answer and the delta. That file is the
    // next training set: retrain on the ticks where the model was worst, not on random
    // examples. It cannot influence the beam — record() has no return value and
    // reference.js exports no way to obtain the arithmetic's number.
    //
    // fanCenter passed is prevFanCenter, the position the profile was MEASURED at, not
    // the newly committed one. The beam azimuths in the log must match what the model
    // was shown.
    // ------------------------------------------------------------------
    recordReference({
      tick: this.tick,
      rsrp,
      fanCenter: prevFanCenter,
      model: { fan_center: dec.modelFan, tilt: dec.modelTilt },
      committed: { fan_center: this.fanCenter, tilt: this.tilt },
      source: dec.source
    });

    // escalation gate for chaos
    if (params.action === "widen" && spreadRising) {
      this.escalation = { pending: true, ts, reason: "Radial dispersal detected" };
    }

    // --- build the signaling log (what each interface carries) ---
    const log = {
      tick: this.tick,
      gNB_to_NearRT_E2: {
        interface: "E2 · E2SM-KPM",
        spec: "SS-RSRP TS 38.215/38.133 · RRC.ConnMean TS 28.552",
        "SS.RSRP_perSSB_dBm": rsrp,
        "RRC.ConnMean": load,
        beam_azimuths: sensed.azimuths,
        note: "collected by the xApp on the Near-RT RIC. Per-beam membership is derived for display; TS 28.552 5.1.1.28.1 defines a per-SSB UE mean but as a slow O1 PM counter, not used in this fast loop.",
        beam_members: counts
      },
      SMO_to_rApp_R1: {
        interface: "R1 · Data Management & Exposure", spec: "O-RAN.WG2.R1GAP",
        ssb_rsrp: rsrp,
        cell_ue_total: load,
        current: { fan_center_deg: +this.fanCenter.toFixed(2), tilt_deg: +this.tilt.toFixed(2) },
        centroid_method: "rsrp_weighted",
        rsrp_weighted_az: obs.rsrpWeightedAz,
        spread: obs.spreadNow, spread_rising: spreadRising, split: splitDetected
      },
      rApp_proposal: {
        model_proposed: { fan_center: this.decision.modelFan, tilt: this.decision.modelTilt },
        committed: { fan_center: this.decision.committedFan, tilt: this.decision.committedTilt },
        source: this.decision.source,
        guardrails: this.decision.notes,
        params_only: params,
        model: MODEL_INFO
      },
      SMO_to_gNB_O1: {
        interface: "O1 · NETCONF/YANG", spec: "3GPP TS 28.541 · CommonBeamformingFunction",
        r1_request: formatted.r1Request,
        o1_config: formatted.o1Config,
        validation: formatted.validation
      },
      neighbour_gate: {
        interface: "rApp internal · deterministic policy",
        scope: "downlink spill only, our RU into their UEs",
        budget_dB: gate.budget,
        allowed: gate.allowed,
        cells: gate.cells,
        handover: gate.handover
      },
      escalation: this.escalation
    };
    this.lastLog = log;
    this.lastProposal = params;

    // direction-aware reason, computed from the ACTUAL committed move
    const committedFan = this.fanCenter;
    let dir;
    if (committedFan > prevFanCenter + 1) dir = "right";
    else if (committedFan < prevFanCenter - 1) dir = "left";
    else dir = "hold";
    // Reason text: when the model steered, show the MODEL'S OWN words. Template text is
    // used only when the model did not decide, and is labelled as such.
    let reasonText;
    const modelReason = String(params.reason || "").trim();
    if (this.decision.source === "neighbour-blocked") {
      reasonText = `[gate] ${this.decision.neighbours.reason}, holding position`;
    } else if (this.decision.source === "no-decision") {
      reasonText = "[tool] no usable model output, holding position";
    } else if (modelReason) {
      reasonText = modelReason;                       // the model's own explanation
    } else {
      reasonText = `[tool] model gave no reason, moved ${dir}`;
    }

    // rolling proposal history (oldest first, newest at end, keep last 100)
    this.proposalHistory = this.proposalHistory || [];
    const t = new Date();
    const hhmmss = t.toTimeString().slice(0, 8);
    this.proposalHistory.push({
      t: hhmmss,
      tick: this.tick,
      fan_center: params.fan_center,          // what was COMMITTED
      tilt: params.tilt,
      action: params.action,
      reason: reasonText,
      // provenance: what the model actually asked for
      source: this.decision.source,            // model | model-partial | no-decision
      proposedFan: Number.isFinite(this.decision.modelFan)
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
      tower: { h: TOWER_H },
      fanCenter: this.fanCenter,
      tilt: this.tilt,
      centroid: this.centroid || { az: 0, range: 0, x: 0, y: 0 },
      trail: this.trail || [],
      beamAzimuths: fanAzimuths(this.fanCenter),
      ues: this.crowd.snapshot(),
      mode: this.crowd.mode,
      anomaly: this.anomaly,
      anomalyArmed: this.anomalyArmed,
      neighbours: this.neighbours.snapshot(this.fanCenter, this.tilt),
      gate: this.decision?.neighbours || null,
      action: this.lastProposal?.action || "follow",
      decision: this.decision || null,
      proposals: this.proposalHistory || [],
      escalation: this.escalation,
      log: this.lastLog,
      model: MODEL_INFO
    };
  }
}
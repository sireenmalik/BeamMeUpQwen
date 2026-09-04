import React, { useEffect, useState, useCallback, useRef } from "react";
import Radar from "./Radar.jsx";

const api = (path, body) => {
  const isGet = path === "/api/state";
  return fetch(path, {
    method: isGet ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: !isGet && body ? JSON.stringify(body) : undefined
  }).then(r => r.json()).catch(() => null);
};

const MODES = [
  { key: "auto",   label: "Auto Drift",   hint: "Crowd wanders randomly. Beam follows.",        color: "teal" },
  { key: "linear", label: "Crowd Linear", hint: "Click the field. Crowd walks there, beam follows.", color: "teal" },
  { key: "chaos",  label: "Detect Chaos", hint: "Fire the burst. Detector flags radial dispersal. Beam keeps tracking.", color: "teal" },
];

// NOTE: the Reactive / Lead / Momentum / Predictive selector was removed.
//
// Under PROMPT_SCHEMA=v9 those buttons changed a label and nothing else. The mode fed
// _aimForMode() in loop.js, whose output went to dec.referenceAim — display only, never
// committed. Switching modes produced an identical beam. The selector also implied a
// capability that did not exist.
//
// If forecast modes come back they have to change the TRAINING LABELS (Lead means labels
// generated with forward projection), which is a new dataset and a new adapter, not a
// button. See gen_v9.py.

function ModeButton({ label, on, color, onClick, disabled }) {
  const onCls = color === "red" ? "bg-red-600 text-white border-red-600" : "bg-teal-600 text-white border-teal-600";
  const offCls = "bg-white text-slate-700 border-slate-300 hover:bg-slate-50";
  const disabledCls = "bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed";
  return (
    <button onClick={disabled ? undefined : onClick} disabled={disabled}
      className={`shrink-0 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${disabled ? disabledCls : (on ? onCls : offCls)}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle ${disabled ? "bg-slate-300" : (on ? "bg-white" : "bg-slate-300")}`} />
      {label}
      <span className="ml-1 opacity-70">{disabled ? "SOON" : (on ? "ON" : "OFF")}</span>
    </button>
  );
}


// ---------------------------------------------------------------------------
// NEIGHBOUR TILES
//
// Deliberately a strip beside the radar rather than zooming the radar out to fit
// four cells. Zooming out costs the crowd, the beam fan and the detail that the
// radar exists to show. The tiles carry one number each, which is all a neighbour
// needs on screen.
//
// The number is the noise rise OUR beam causes at that cell's users, in dB. It is
// downlink spill only — our RU into their UEs. See neighbours.js.
//
// It moves even when our beam is still, because their users are walking through a
// fixed spill pattern. That is real, not jitter.
// ---------------------------------------------------------------------------
function NeighbourTile({ cell, gateCell, budget }) {
  const delta = gateCell?.delta;
  const over  = gateCell?.overBudget;
  const tone  = over ? "border-red-400 bg-red-50"
              : (delta != null && delta > budget * 0.6) ? "border-amber-300 bg-amber-50"
              : "border-slate-200 bg-white";
  const numTone = over ? "text-red-600" : "text-slate-800";
  return (
    <div className={`rounded-lg border px-2.5 py-1.5 ${tone}`}>
      <div className="flex justify-between items-baseline">
        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Cell {cell.id}</span>
        <span className="text-[9px] text-slate-400 font-mono">{cell.dist}m · {cell.az}°</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-2xl font-bold font-mono ${numTone}`}>{cell.noiseRise.toFixed(1)}</span>
        <span className="text-[10px] text-slate-400">dB rise</span>
      </div>
      {delta != null && (
        <div className={`text-[10px] font-mono ${over ? "text-red-600 font-bold" : "text-slate-500"}`}>
          proposed {delta >= 0 ? "+" : ""}{delta.toFixed(2)} dB {over ? "· OVER" : ""}
        </div>
      )}
      {cell.blockStreak > 0 && (
        <div className="flex gap-0.5 mt-1">
          {[0,1,2].map(i => (
            <span key={i} className={`inline-block w-3 h-1 rounded-sm ${i < cell.blockStreak ? "bg-red-500" : "bg-slate-200"}`} />
          ))}
        </div>
      )}
    </div>
  );
}

function KVPanel({ title, rows, tone }) {
  const toneMap = { teal: "text-teal-700", slate: "text-slate-600" };
  return (
    <div className="flex flex-col min-h-0 bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className={`text-[11px] font-semibold uppercase tracking-wide px-3 py-2 border-b border-slate-200 shrink-0 ${toneMap[tone]}`}>{title}</div>
      <div className="flex-1 min-h-0 overflow-auto p-3 text-[12px] font-mono text-slate-700 space-y-1.5">
        {rows.map(([k, v], i) => (
          <div key={i} className="flex justify-between gap-3">
            <span className="text-slate-400">{k}</span>
            <span className="text-slate-800 text-right break-all">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [active, setActive] = useState(null); // 'auto' | 'linear' | 'chaos' | null
  const activeRef = useRef(null);
  activeRef.current = active;

  const refresh = useCallback(async () => { try { setState(await api("/api/state")); } catch {} }, []);
  useEffect(() => { refresh(); const id = setInterval(refresh, 500); return () => clearInterval(id); }, [refresh]);

  // ---- proposals scroll: pin to bottom unless the user has scrolled up ----
  const scrollRef = useRef(null);
  const pinnedRef = useRef(true);          // is the view currently stuck to the newest (bottom)?
  const lastTickRef = useRef(0);           // newest tick we have already auto-scrolled to
  const [showJump, setShowJump] = useState(false);

  const onProposalScroll = useCallback(() => {
    const el = scrollRef.current; if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    pinnedRef.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  // click on the field only does something in linear mode (uses ref, no stale closure)
  const onWalk = useCallback((pt) => { if (activeRef.current === "linear") api("/api/walk", pt); }, []);

  const selectMode = (which) => {
    if (MODES.find(m => m.key === which)?.disabled) return; // disabled modes do nothing
    if (active === which) {
      // turn the active one OFF -> STOP the loop (clean off: no ticks, beam frozen)
      setActive(null);
      api("/api/anomaly/arm", { on: false }); // leaving any use case disarms + clears the banner
      api("/api/stop");
    } else {
      // switch to this mode; others turn off automatically (single active value)
      setActive(which);
      // arm the chaos detector ONLY in Detect Chaos; disarm (and clear banner) otherwise
      api("/api/anomaly/arm", { on: which === "chaos" });
      if (which === "auto")   { api("/api/auto"); }    // starts loop + wander
      if (which === "linear") { api("/api/idle"); api("/api/run"); } // run; click sets target
      if (which === "chaos")  { api("/api/auto"); api("/api/run"); } // crowd auto-drifts; press Burst to disperse
    }
  };

  const log = state?.log;

  // pop sound mimicking a firecracker/gunshot for the chaos trigger
  const playPop = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const now = ctx.currentTime;
      // sharp noise burst
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.15, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.6, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      src.connect(g); g.connect(ctx.destination); src.start(now);
    } catch (e) { /* audio not available */ }
  };

  const triggerBurst = () => { playPop(); api("/api/chaos"); };

  const esc = state?.escalation;
  const model = state?.model;
  const e2  = log?.gNB_to_NearRT_E2;
  const r1 = log?.SMO_to_rApp_R1;
  const proposals = state?.proposals || [];
  const neighbours = state?.neighbours || [];
  const gate = state?.gate || null;
  const budget = gate?.budget ?? 1.0;
  const activeHint = MODES.find(m => m.key === active)?.hint || "Pick a mode to start tracking.";

  // auto-scroll to newest ONLY when a genuinely new tick arrives AND the user is pinned to bottom.
  // (the 500ms poll re-sends the same list; keying off the newest tick stops per-poll jitter.)
  const newestTick = proposals.length ? proposals[proposals.length - 1].tick : 0;
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    if (newestTick !== lastTickRef.current) {
      lastTickRef.current = newestTick;
      if (pinnedRef.current) {
        el.scrollTop = el.scrollHeight;   // stick to newest
        setShowJump(false);
      } else {
        setShowJump(true);                // new item arrived while scrolled up
      }
    }
  }, [newestTick]);

  const jumpToNewest = () => {
    const el = scrollRef.current; if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setShowJump(false);
  };

  // --- chaos banner blink control: show while armed+active, blink up to 20 times, then hide ---
  const anomaly = state?.anomaly;
  const [blinkOn, setBlinkOn] = useState(false);
  const blinksDoneRef = useRef(0);
  const anomalyTickRef = useRef(0);
  const [bannerVisible, setBannerVisible] = useState(false);

  // when a NEW anomaly event arrives (new tick), reset the blink counter and show it
  useEffect(() => {
    if (anomaly?.active && anomaly.tick !== anomalyTickRef.current) {
      anomalyTickRef.current = anomaly.tick;
      blinksDoneRef.current = 0;
      setBannerVisible(true);
    }
    // if the anomaly was cleared server-side (use-case switch), hide immediately
    if (!anomaly && bannerVisible) {
      setBannerVisible(false);
      blinksDoneRef.current = 0;
    }
  }, [anomaly, bannerVisible]);

  // drive the blink: toggle every 400ms, count on-cycles, stop after 20
  useEffect(() => {
    if (!bannerVisible) { setBlinkOn(false); return; }
    const id = setInterval(() => {
      setBlinkOn(prev => {
        const next = !prev;
        if (next) { // count each time it turns ON
          blinksDoneRef.current += 1;
          if (blinksDoneRef.current >= 20) { setBannerVisible(false); }
        }
        return next;
      });
    }, 400);
    return () => clearInterval(id);
  }, [bannerVisible]);

  return (
    <div className="h-screen flex flex-col text-slate-800 bg-white overflow-hidden">
      <header className="flex items-center justify-between px-4 py-1.5 border-b border-slate-200 shrink-0">
        <div>
          <h1 className="text-sm font-bold text-slate-900 leading-tight">Crowd-Following Beam</h1>
          <p className="text-[10px] text-slate-500 leading-tight">LLM rApp · gNB → SMO → rApp loop</p>
        </div>
        <div className="text-[11px] text-slate-500 text-right">
          <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold mr-2 ${state?.running ? "bg-teal-100 text-teal-700" : "bg-slate-200 text-slate-500"}`}>
            {state?.running ? "● TRACKING" : "○ STOPPED"}
          </span>
         <span className="text-teal-700 font-mono">{model?.name || "unset"}</span>
         <span className="ml-1.5 px-1.5 py-0.5 rounded bg-teal-600 text-white text-[10px] font-semibold tracking-wide">LoRA TUNED</span>
         <span className="text-slate-500"> · tick {state?.tick ?? "—"}</span>
         </div>
         {active === "chaos" && (
           <button onClick={triggerBurst}
             className="ml-4 px-4 py-1.5 rounded-lg text-sm font-bold bg-red-600 text-white hover:bg-red-700 shadow-sm shrink-0">
             💥 Trigger Burst
           </button>
         )}
      </header>

      {/* single compact control row: use-case modes */}
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-slate-200 shrink-0 flex-wrap">
        {MODES.map(m => (
          <ModeButton key={m.key} label={m.label} color={m.color} disabled={m.disabled}
            on={active === m.key} onClick={() => selectMode(m.key)} />
        ))}
        <span className="mx-1 text-slate-300">|</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Beam</span>
        <span className="text-[11px] text-slate-600 font-mono">
          model decides · no fallback · holds on failure
        </span>
        <div className="text-[11px] text-slate-500 ml-2 truncate">{activeHint}</div>
      </div>

      {esc?.pending && (
        <div className="mx-5 mt-2 p-2.5 rounded-lg bg-red-50 border border-red-200 shrink-0 flex items-center gap-3">
          <div className="text-red-700 font-semibold text-sm">⚠ {esc.reason}</div>
          <div className="text-slate-600 text-xs">Reversible: beams widened automatically. Irreversible: escalation needs a human.</div>
          <button onClick={() => api("/api/escalation/clear")} className="ml-auto px-3 py-1 rounded bg-red-600 text-white text-xs font-semibold">Confirm escalation</button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col gap-2 p-2.5 overflow-hidden">
        <div className="relative flex-[7] min-h-0 bg-slate-50 rounded-2xl border border-slate-200 p-2 flex items-center justify-center overflow-hidden">
          {bannerVisible && (
            <div className="absolute left-0 top-0 bottom-0 w-1/3 flex flex-col items-center justify-center pointer-events-none z-10 px-4">
              <div className={`text-center transition-opacity duration-150 ${blinkOn ? "opacity-100" : "opacity-10"}`}>
                <div className="text-5xl mb-2">⚠</div>
                <div className="text-2xl font-extrabold tracking-wide text-red-600 leading-tight uppercase">Crowd Chaos<br/>Detected</div>
                <div className="mt-2 text-xs font-semibold uppercase tracking-widest text-red-500">Radial dispersal · detection only</div>
              </div>
            </div>
          )}
          <Radar state={state} mode={active === "linear" ? "walk" : "idle"} onWalk={onWalk} onSplit={() => {}} />

          {/* neighbour strip, right edge of the radar panel */}
          {neighbours.length > 0 && (
            <div className="absolute right-2 top-2 bottom-2 w-40 flex flex-col gap-1.5 z-10">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 px-1">
                Neighbours
              </div>
              {neighbours.map(c => (
                <NeighbourTile key={c.id} cell={c} budget={budget}
                  gateCell={gate?.cells?.find(g => g.id === c.id)} />
              ))}
              <div className="mt-auto px-1 text-[9px] text-slate-400 leading-snug">
                budget {budget} dB per move · downlink spill only
              </div>
              {gate?.handover && (
                <div className="rounded-lg bg-amber-500 text-white px-2 py-1.5 text-[10px] font-bold leading-snug">
                  CROWD LEAVING TOWARD {gate.handover.toward}<br/>
                  <span className="font-normal opacity-90">handover territory, not a beam problem</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex-[3] min-h-0 grid grid-cols-3 gap-2 overflow-hidden">
          <KVPanel title="gNodeB → SMO · O1 · PM (VES)" tone="slate" rows={[
            ["SS-RSRP per SSB", e2 ? `[${e2["SS.RSRP_perSSB_dBm"].join(", ")}] dBm` : "—"],
            ["RRC.ConnMean", e2?.["RRC.ConnMean"] ?? "—"],
            ["beam azimuths", e2 ? `[${e2.beam_azimuths.join(", ")}]°` : "—"],
            ["spec", "SS-RSRP TS 38.215/38.133 · RRC.ConnMean TS 28.552"],
            ["carried on", "O1 PM · VES over REST"],
          ]} />
          {/* centroid velocity row removed: centroid_az and centroid_vel were derived from the
              simulator's true UE positions and no longer appear in the R1 log. */}
          <KVPanel title="SMO → rApp · R1 · DME" tone="teal" rows={[
            ["RSRP-weighted az", r1 ? `${r1.rsrp_weighted_az}°` : "—"],
            ["cell UE total", r1?.cell_ue_total ?? "—"],
            ["current fan_center", r1?.current ? `${r1.current.fan_center_deg}°` : "—"],
            ["current tilt", r1?.current ? `${r1.current.tilt_deg}°` : "—"],
            ["spread", r1 ? `${r1.spread}°` : "—"],
            ["spread rising", r1 ? String(r1.spread_rising) : "—"],
          ]} />
          <div className="flex flex-col min-h-0 bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="text-[11px] font-semibold uppercase tracking-wide px-3 py-2 border-b border-slate-200 shrink-0 text-amber-700">Proposals by Non-RT RIC rApp [LLM]</div>
            <div className="relative flex-1 min-h-0">
              <div ref={scrollRef} onScroll={onProposalScroll} className="absolute inset-0 overflow-auto divide-y divide-slate-100">
                {proposals.length === 0 && <div className="p-3 text-xs text-slate-400">waiting…</div>}
                {proposals.map((p, i) => (
                  <div key={p.tick} className={`px-3 py-1.5 text-[11px] ${i === proposals.length - 1 ? "bg-amber-50" : ""}`}>
                    <div className="flex justify-between font-mono text-slate-500">
                      <span>{p.t}</span><span>#{p.tick} · {p.action}</span>
                    </div>
                    <div className="font-mono text-slate-800">
                      az {p.fan_center}° · tilt {p.tilt}°
                      {p.source === "model" && <span className="ml-2 text-emerald-700 not-italic">← LLM</span>}
                      {p.source === "model-partial" && <span className="ml-2 text-amber-700 not-italic">← LLM (tilt held)</span>}
                      {p.source === "no-decision" && <span className="ml-2 text-red-600 not-italic">← no decision · held</span>}
                      {p.source === "neighbour-blocked" && <span className="ml-2 text-red-600 not-italic">← neighbour gate · BLOCKED</span>}
                    </div>
                    {/* The only thing that can still rewrite the model's number is the
                        formatter's clamp (fan −49..49, tilt 3..45). When it fires, show it. */}
                    {p.proposedFan != null && p.proposedFan !== p.fan_center && (
                      <div className="font-mono text-[10px] text-amber-700">LLM asked az {p.proposedFan}° · clamped to {p.fan_center}°</div>
                    )}
                    {p.guard && <div className="text-[10px] text-amber-700 leading-snug">⚠ {p.guard}</div>}
                    <div className="text-slate-500 italic leading-snug">{p.reason}</div>
                  </div>
                ))}
              </div>
              {showJump && (
                <button onClick={jumpToNewest}
                  className="absolute bottom-2 right-2 text-[10px] font-semibold bg-amber-600 text-white px-2 py-1 rounded shadow hover:bg-amber-700">
                  ↓ new
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <footer className="text-[9px] text-slate-400 px-4 py-1 border-t border-slate-200 shrink-0">
        Digital beam steering, not mechanical RET · chaos detection reads the crowd's response, not gunfire · reversible actions auto, irreversible human-gated.
      </footer>
    </div>
  );
}
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
  { key: "linear", label: "Crowd Linear", hint: "Click the field. Crowd walks there, beam leads.", color: "teal" },
  { key: "chaos",  label: "Detect Chaos", hint: "Fire the burst. Detector flags radial dispersal. Beam keeps tracking.", color: "teal" },
];

// forecasting modes for the beam: same tuned model, deterministic tool changes.
// predictive is the L3 tuned model — WIP, disabled and not selectable.
const FORECAST = [
  { key: "reactive", label: "Reactive", hint: "Aims at the crowd now. Baseline follower." },
  { key: "lead",     label: "Lead",     hint: "Aims ahead of the crowd on steady motion." },
  { key: "momentum", label: "Momentum", hint: "Momentum-smoothed lead. Steadier under motion." },
  { key: "predictive", label: "Predictive", hint: "Learned forecast (L3 model). Work in progress.", wip: true, disabled: true },
];

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
  const [forecast, setForecast] = useState("momentum");
  const activeRef = useRef(null);
  activeRef.current = active;

  const refresh = useCallback(async () => { try { setState(await api("/api/state")); } catch {} }, []);
  useEffect(() => { refresh(); const id = setInterval(refresh, 500); return () => clearInterval(id); }, [refresh]);
  // set the default forecasting mode (momentum) on the backend once at load
  useEffect(() => { api("/api/mode", { mode: "momentum" }); }, []);

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

  const selectForecast = (key) => {
    if (FORECAST.find(f => f.key === key)?.disabled) return; // predictive WIP is not selectable
    setForecast(key);
    api("/api/mode", { mode: key });
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
  const activeHint = MODES.find(m => m.key === active)?.hint || "Pick a mode to start tracking.";
  const forecastHint = FORECAST.find(f => f.key === forecast)?.hint || "";

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
         <span className="text-teal-700 font-mono">{model?.name || "qwen2.5-0.5b"}</span>
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

      {/* single compact control row: use-case modes + forecast switch */}
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-slate-200 shrink-0 flex-wrap">
        {MODES.map(m => (
          <ModeButton key={m.key} label={m.label} color={m.color} disabled={m.disabled}
            on={active === m.key} onClick={() => selectMode(m.key)} />
        ))}
        <span className="mx-1 text-slate-300">|</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Forecast</span>
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden">
          {FORECAST.map((f, i) => {
            const on = forecast === f.key;
            const base = "px-2.5 py-1 text-xs font-medium transition-colors";
            const sep = i > 0 ? "border-l border-slate-300" : "";
            const cls = f.disabled
              ? "bg-slate-100 text-slate-400 cursor-not-allowed"
              : on ? "bg-teal-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50";
            return (
              <button key={f.key} onClick={() => selectForecast(f.key)} disabled={f.disabled}
                className={`${base} ${sep} ${cls}`}>
                {f.label}{f.wip && <span className="ml-1 text-[9px] opacity-90">WIP</span>}
              </button>
            );
          })}
        </div>
        <div className="text-[11px] text-slate-500 ml-2 truncate">{active === "chaos" ? activeHint : forecastHint}</div>
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
        </div>

        <div className="flex-[3] min-h-0 grid grid-cols-3 gap-2 overflow-hidden">
          <KVPanel title="gNodeB → SMO · O1 · PM (VES)" tone="slate" rows={[
            ["SS-RSRP per SSB", e2 ? `[${e2["SS.RSRP_perSSB_dBm"].join(", ")}] dBm` : "—"],
            ["RRC.ConnMean", e2?.["RRC.ConnMean"] ?? "—"],
            ["beam azimuths", e2 ? `[${e2.beam_azimuths.join(", ")}]°` : "—"],
            ["spec", "SS-RSRP TS 38.215/38.133 · RRC.ConnMean TS 28.552"],
            ["carried on", "O1 PM · VES over REST"],
          ]} />
          <KVPanel title="SMO → rApp · R1 · DME" tone="teal" rows={[
            ["RSRP-weighted az", r1 ? `${r1.rsrp_weighted_az}°` : "—"],
            ["cell UE total", r1?.cell_ue_total ?? "—"],
            ["current fan_center", r1?.current ? `${r1.current.fan_center_deg}°` : "—"],
            ["current tilt", r1?.current ? `${r1.current.tilt_deg}°` : "—"],
            ["velocity", r1 ? `${r1.centroid_vel}°/tick` : "—"],
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
                      <span>{p.t}</span><span>#{p.tick} · {p.action}{p.mode ? ` · ${p.mode}` : ""}</span>
                    </div>
                    <div className="font-mono text-slate-800">
                      az {p.fan_center}° · tilt {p.tilt}°
                      {p.source === "model" && <span className="ml-2 text-emerald-700 not-italic">← LLM</span>}
                      {p.source === "model-clamped" && <span className="ml-2 text-amber-700 not-italic">← LLM (clamped)</span>}
                      {p.source === "model-partial" && <span className="ml-2 text-amber-700 not-italic">← LLM (tilt sub.)</span>}
                      {p.source === "no-decision" && <span className="ml-2 text-red-600 not-italic">← no decision · held</span>}
                      {p.source === "hold" && <span className="ml-2 text-slate-500 not-italic">← hold (UE floor)</span>}
                    </div>
                    {p.proposedFan != null && p.proposedFan !== p.fan_center && (
                      <div className="font-mono text-[10px] text-amber-700">LLM asked az {p.proposedFan}° · fenced to {p.fan_center}°</div>
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
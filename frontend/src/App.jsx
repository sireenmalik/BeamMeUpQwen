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
  { key: "chaos",  label: "Detect Chaos", hint: "Chaos / coverage-widening is a future INTENT use case.", color: "red", disabled: true },
];

function ModeButton({ label, on, color, onClick, disabled }) {
  const onCls = color === "red" ? "bg-red-600 text-white border-red-600" : "bg-teal-600 text-white border-teal-600";
  const offCls = "bg-white text-slate-700 border-slate-300 hover:bg-slate-50";
  const disabledCls = "bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed";
  return (
    <button onClick={disabled ? undefined : onClick} disabled={disabled}
      className={`w-40 shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${disabled ? disabledCls : (on ? onCls : offCls)}`}>
      <span className={`inline-block w-2 h-2 rounded-full mr-2 align-middle ${disabled ? "bg-slate-300" : (on ? "bg-white" : "bg-slate-300")}`} />
      {label}
      <span className="ml-1 opacity-80">· {disabled ? "SOON" : (on ? "ON" : "OFF")}</span>
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
  const activeRef = useRef(null);
  activeRef.current = active;

  const refresh = useCallback(async () => { try { setState(await api("/api/state")); } catch {} }, []);
  useEffect(() => { refresh(); const id = setInterval(refresh, 500); return () => clearInterval(id); }, [refresh]);

  // click on the field only does something in linear mode (uses ref, no stale closure)
  const onWalk = useCallback((pt) => { if (activeRef.current === "linear") api("/api/walk", pt); }, []);

  const selectMode = (which) => {
    if (MODES.find(m => m.key === which)?.disabled) return; // disabled modes do nothing
    if (active === which) {
      // turn the active one OFF -> STOP the loop (clean off: no ticks, beam frozen)
      setActive(null);
      api("/api/stop");
    } else {
      // switch to this mode; others turn off automatically (single active value)
      setActive(which);
      if (which === "auto")   api("/api/auto");    // starts loop + wander
      if (which === "linear") { api("/api/idle"); api("/api/run"); } // run; click sets target
      if (which === "chaos")  { api("/api/idle"); api("/api/run"); } // run; press Burst to disperse
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
  const kpm = log?.gNB_to_SMO_KPM;
  const r1 = log?.SMO_to_rApp_R1;
  const proposals = state?.proposals || [];
  const activeHint = MODES.find(m => m.key === active)?.hint || "Pick a mode to start tracking.";

  return (
    <div className="h-screen flex flex-col text-slate-800 bg-white overflow-hidden">
      <header className="flex items-center justify-between px-5 py-2.5 border-b border-slate-200 shrink-0">
        <div>
          <h1 className="text-lg font-bold text-slate-900 leading-tight">Crowd-Following Beam</h1>
          <p className="text-[11px] text-slate-500">LLM rApp · gNB → SMO → rApp loop · digital beam steering</p>
        </div>
        <div className="text-[11px] text-slate-500 text-right">
          <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold mr-2 ${state?.running ? "bg-teal-100 text-teal-700" : "bg-slate-200 text-slate-500"}`}>
            {state?.running ? "● TRACKING" : "○ STOPPED"}
          </span>
          <span className="text-teal-700 font-mono">{model?.provider}/{model?.name}</span> · tick {state?.tick ?? "—"}
        </div>
      </header>

      {/* three fixed-position mode buttons — positions never change, only ON/OFF state */}
      <div className="flex items-center gap-2 px-5 py-2 border-b border-slate-200 shrink-0">
        {MODES.map(m => (
          <ModeButton key={m.key} label={m.label} color={m.color} disabled={m.disabled}
            on={active === m.key} onClick={() => selectMode(m.key)} />
        ))}
        <div className="text-xs text-slate-500 ml-3">{activeHint}</div>
        {active === "chaos" && (
          <button onClick={triggerBurst}
            className="ml-auto px-4 py-1.5 rounded-lg text-sm font-bold bg-red-600 text-white hover:bg-red-700 shadow-sm">
            💥 Trigger Burst
          </button>
        )}
      </div>

      {esc?.pending && (
        <div className="mx-5 mt-2 p-2.5 rounded-lg bg-red-50 border border-red-200 shrink-0 flex items-center gap-3">
          <div className="text-red-700 font-semibold text-sm">⚠ {esc.reason}</div>
          <div className="text-slate-600 text-xs">Reversible: beams widened automatically. Irreversible: escalation needs a human.</div>
          <button onClick={() => api("/api/escalation/clear")} className="ml-auto px-3 py-1 rounded bg-red-600 text-white text-xs font-semibold">Confirm escalation</button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col gap-3 p-4 overflow-hidden">
        <div className="flex-[3] min-h-0 bg-slate-50 rounded-2xl border border-slate-200 p-3 flex items-center justify-center overflow-hidden">
          <Radar state={state} mode={active === "linear" ? "walk" : "idle"} onWalk={onWalk} onSplit={() => {}} />
        </div>

        <div className="flex-[2] min-h-0 grid grid-cols-3 gap-3 overflow-hidden">
          <KVPanel title="gNB → SMO · KPM (counts)" tone="slate" rows={[
            ["beams", kpm ? `[${kpm.beam_counts.join(", ")}]` : "—"],
            ["total UE", kpm?.total_ue ?? "—"],
            ["schema", "e2sm-kpm.v1"],
          ]} />
          <KVPanel title="SMO → rApp · R1 (features)" tone="teal" rows={[
            ["centroid az", r1 ? `${r1.centroid_az}°` : "—"],
            ["centroid range", state?.centroid ? `${state.centroid.range} m` : "—"],
            ["centroid X", state?.centroid ? `${state.centroid.x} m` : "—"],
            ["centroid Y", state?.centroid ? `${state.centroid.y} m` : "—"],
            ["velocity", r1 ? `${r1.centroid_vel}°/tick` : "—"],
            ["spread", r1 ? `${r1.spread}°` : "—"],
            ["spread rising", r1 ? String(r1.spread_rising) : "—"],
          ]} />
          <div className="flex flex-col min-h-0 bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="text-[11px] font-semibold uppercase tracking-wide px-3 py-2 border-b border-slate-200 shrink-0 text-amber-700">Proposals by Non-RT RIC rApp [LLM]</div>
            <div className="flex-1 min-h-0 overflow-auto divide-y divide-slate-100">
              {proposals.length === 0 && <div className="p-3 text-xs text-slate-400">waiting…</div>}
              {proposals.map((p, i) => (
                <div key={p.tick} className={`px-3 py-1.5 text-[11px] ${i === 0 ? "bg-amber-50" : ""}`}>
                  <div className="flex justify-between font-mono text-slate-500">
                    <span>{p.t}</span><span>#{p.tick} · {p.action}</span>
                  </div>
                  <div className="font-mono text-slate-800">az {p.fan_center}° · tilt {p.tilt}°</div>
                  <div className="text-slate-500 italic leading-snug">{p.reason}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <footer className="text-[10px] text-slate-400 px-5 py-1.5 border-t border-slate-200 shrink-0">
        Digital beam steering, not mechanical RET · chaos detection reads the crowd's response, not gunfire · reversible actions auto, irreversible human-gated.
      </footer>
    </div>
  );
}
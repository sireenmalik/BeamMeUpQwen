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
// NEIGHBOUR SITES — the RF planning view
//
// Three sites on a hex lattice at ISD 200 m, 60 degree bearings, three sectors
// each. Nine numbers. That is the layout TR 38.901 UMi describes and the unit an
// operator actually alarms on: a cell is a sector, not a site.
//
// Each number is the noise rise OUR beam causes for the users in that sector, in
// dB. Downlink spill only, our RU into their UEs. See neighbours.js.
//
// The numbers move even when our beam is still, because their users are walking
// through a fixed spill pattern. That is real, not jitter.
//
// One thing this display does NOT show, because measurement says it is not true:
// the harm does not concentrate in the sector facing us. A swing toward a site
// lifts all three of its sectors by roughly the same amount, because how much of
// our energy reaches a handset depends on where it sits relative to OUR tower,
// not on which of THEIR antennas serves it.
// ---------------------------------------------------------------------------

// noise rise -> fill colour. 0 dB clean, 28 dB saturated.
function heatFill(v) {
  const stops = [
    [0,  [248,250,252]], [5,  [220,242,244]], [10, [155,217,222]],
    [16, [245,201,122]], [22, [232,145,107]], [28, [192,73,47]],
  ];
  const x = Math.max(0, Math.min(28, v ?? 0));
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (x >= stops[i][0] && x <= stops[i+1][0]) { a = stops[i]; b = stops[i+1]; break; }
  }
  const t = (x - a[0]) / Math.max(1e-6, b[0] - a[0]);
  const c = a[1].map((v0, i) => Math.round(v0 + t * (b[1][i] - v0)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ---------------------------------------------------------------------------
// THE RF PLANNING MAP
//
// One map, not three separate widgets. Sites sit where they actually are: a hex
// lattice at ISD 200 m on 60 degree bearings, our serving site at the bottom and
// the three it can reach above it. Nine sector numbers.
//
// This is the view an RF engineer already knows how to read. The geography is the
// point: you can see that the beam is leaning toward B before the gate says so.
//
// World coordinates are metres, same frame as neighbours.js: +Y is north (our
// sector boresight), +X is east. SVG y grows downward, so y is flipped on the way
// in and every bearing is (-90 + az) in SVG terms.
// ---------------------------------------------------------------------------
function RfMap({ neighbours, gate, fanCenter, tilt, budget }) {
  // world extents, metres
  const X0 = -300, X1 = 300, Y0 = -150, Y1 = 320;
  const W = 320, H = W * (Y1 - Y0) / (X1 - X0);
  const sx = (x) => (x - X0) / (X1 - X0) * W;
  const sy = (y) => H - (y - Y0) / (Y1 - Y0) * H;      // flip
  const sr = (m) => m / (X1 - X0) * W;                 // scalar metres -> px

  const ISD = 200, HEX_R = sr(ISD / Math.sqrt(3));
  const PETAL_R = sr(62), HALF = 48;

  const hexPts = (cx, cy) => Array.from({ length: 6 }, (_, i) => {
    const a = (-90 + i * 60) * Math.PI / 180;
    return `${cx + HEX_R * Math.cos(a)},${cy + HEX_R * Math.sin(a)}`;
  }).join(" ");

  const wedge = (cx, cy, r, azDeg, half) => {
    const a0 = (-90 + azDeg - half) * Math.PI / 180;
    const a1 = (-90 + azDeg + half) * Math.PI / 180;
    return `M ${cx} ${cy} L ${cx + r*Math.cos(a0)} ${cy + r*Math.sin(a0)} ` +
           `A ${r} ${r} 0 0 1 ${cx + r*Math.cos(a1)} ${cy + r*Math.sin(a1)} Z`;
  };

  const OUR = { x: 0, y: 0 };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* hexes */}
      {[OUR, ...neighbours].map((c, i) => (
        <polygon key={`h${i}`} points={hexPts(sx(c.x), sy(c.y))} fill="none"
                 stroke="#CBD5E1" strokeWidth="0.9" />
      ))}

      {/* neighbour sites: three petals each, heat filled, number in each */}
      {neighbours.map(c => {
        const g = gate?.cells?.find(x => x.id === c.id);
        const cx = sx(c.x), cy = sy(c.y);
        return (
          <g key={c.id}>
            {c.sectors.map(sec => {
              const gs = g?.sectors?.find(x => x.az === sec.az);
              const over = gs?.overBudget;
              const a = (-90 + sec.az) * Math.PI / 180;
              return (
                <g key={sec.az}>
                  <path d={wedge(cx, cy, PETAL_R, sec.az, HALF)}
                        fill={heatFill(sec.noiseRise)}
                        stroke={over ? "#C0492F" : "#94A3B8"}
                        strokeWidth={over ? 2 : 0.7} strokeLinejoin="round" />
                  <text x={cx + 0.52*PETAL_R*Math.cos(a)}
                        y={cy + 0.52*PETAL_R*Math.sin(a) + 3}
                        textAnchor="middle" fontSize="9.5" fontWeight="700"
                        fill={over ? "#C0492F" : "#0E2A47"}>
                    {sec.noiseRise.toFixed(1)}
                  </text>
                </g>
              );
            })}
            <polygon points={`${cx},${cy-4.5} ${cx-4},${cy+3} ${cx+4},${cy+3}`}
                     fill="#0E2A47" stroke="#fff" strokeWidth="0.9" />
            {/* SITE D sits directly above us, so its label goes ABOVE the hex —
                below it is where our own beam is drawn. */}
            <text x={cx} y={c.id === "D" ? cy - HEX_R - 4 : cy + HEX_R + 11}
                  textAnchor="middle" fontSize="9"
                  fontWeight="700" fill="#334155">SITE {c.id}</text>
            {g && (
              <text x={cx} y={c.id === "D" ? cy - HEX_R - 14 : cy + HEX_R + 21}
                    textAnchor="middle" fontSize="8"
                    fontWeight={g.overBudget ? "700" : "400"}
                    fill={g.overBudget ? "#C0492F" : "#94A3B8"}>
                {g.delta >= 0 ? "+" : ""}{g.delta.toFixed(2)} dB{g.overBudget ? " OVER" : ""}
              </text>
            )}
          </g>
        );
      })}

      {/* our site: three sectors, the serving one teal, plus the live beam */}
      {(() => {
        const cx = sx(0), cy = sy(0);
        return (
          <g>
            {[0,120,240].map(az => (
              <path key={az} d={wedge(cx, cy, PETAL_R, az, HALF)}
                    fill={az === 0 ? "#0E7C86" : "#CBD5E1"}
                    opacity={az === 0 ? 0.30 : 0.45}
                    stroke="#94A3B8" strokeWidth="0.7" strokeLinejoin="round" />
            ))}
            <path d={wedge(cx, cy, sr(150), fanCenter ?? 0, 16)}
                  fill="#0E7C86" opacity="0.55" />
            <polygon points={`${cx},${cy-5} ${cx-4.5},${cy+3.5} ${cx+4.5},${cy+3.5}`}
                     fill="#0E2A47" stroke="#fff" strokeWidth="1" />
            <text x={cx} y={cy + HEX_R + 11} textAnchor="middle" fontSize="9"
                  fontWeight="700" fill="#334155">SITE 1 · serving</text>
          </g>
        );
      })()}

      {/* ISD reference */}
      <line x1={sx(0)} y1={sy(0)} x2={sx(173)} y2={sy(100)}
            stroke="#94A3B8" strokeWidth="0.7" strokeDasharray="3 3" />
      <text x={sx(95)} y={sy(58)} fontSize="7.5" fill="#94A3B8"
            transform={`rotate(-30 ${sx(95)} ${sy(58)})`}>ISD 200 m</text>
    </svg>
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

          {/* RF planning map, right edge of the radar panel */}
          {neighbours.length > 0 && (
            <div className="absolute right-2 top-2 bottom-2 w-72 flex flex-col z-10
                            bg-white/90 backdrop-blur-sm rounded-lg border border-slate-200 px-2 py-2">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">
                RF planning view · hex lattice
              </div>
              <RfMap neighbours={neighbours} gate={gate} budget={budget}
                     fanCenter={state?.fanCenter} tilt={state?.tilt} />
              <div className="mt-auto text-[9px] text-slate-400 leading-snug pt-1">
                dB noise rise our beam causes, per sector.<br/>
                budget {budget} dB per move · downlink spill only
              </div>
              {gate?.handover && (
                <div className="rounded bg-amber-500 text-white px-2 py-1 text-[10px] font-bold leading-snug mt-1">
                  CROWD LEAVING TOWARD {gate.handover.toward}<br/>
                  <span className="font-normal opacity-90">handover, not a beam problem</span>
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
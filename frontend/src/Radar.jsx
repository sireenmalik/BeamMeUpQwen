import React, { useRef } from "react";

// ============================================================================
// ONE VIEW.
//
// This used to be a 150 m sector radar with the neighbour cells shown separately
// in a side panel. Two pictures of the same thing, in two different coordinate
// frames, is one picture too many — you could not see that the beam was leaning
// toward a neighbour, only read it off a number somewhere else.
//
// So the canvas now covers the whole hex lattice: our serving sector, the beam,
// the crowd, and the three neighbouring sites at ISD 200 m, all in metres, all in
// one frame. The neighbour numbers move when the beam moves because they are the
// same scene.
//
// COST OF THE CHANGE, stated plainly: the beam and crowd are drawn about half the
// size they were, because the canvas now reaches 330 m instead of 150 m. That is
// the price of showing the neighbours truthfully rather than as an inset.
// ============================================================================

// World is metres. +Y is north, which is our sector boresight. +X is east.
// SVG y grows downward, so y is flipped on the way to the screen.
const WX0 = -300, WX1 = 300, WY0 = -135, WY1 = 355;
const PPM = 1.5;                                   // pixels per metre
const W = (WX1 - WX0) * PPM, H = (WY1 - WY0) * PPM;
const TOWER_H = 25;                                // matches backend geometry
const RANGE_MAX = 150;                             // our own sector's drawn reach
const ISD = 200;
const HEX_R = ISD / Math.sqrt(3);                  // centre to vertex, metres

const wx = (x) => (x - WX0) * PPM;
const wy = (y) => H - (y - WY0) * PPM;
const CX = wx(0), CY = wy(0);                      // our tower on screen

function polarToScreen(azDeg, range) {
  const a = azDeg * Math.PI / 180;
  return { sx: wx(range * Math.sin(a)), sy: wy(range * Math.cos(a)) };
}
function screenToPolar(px, py) {
  const x = px / PPM + WX0, y = (H - py) / PPM + WY0;
  const range = Math.hypot(x, y);
  const az = Math.atan2(x, y) * 180 / Math.PI;
  return { az: Math.max(-54, Math.min(54, az)),
           range: Math.max(12, Math.min(RANGE_MAX, range)) };
}

// noise rise -> fill. 0 dB clean, 28 dB saturated.
function heatFill(v) {
  const stops = [[0,[248,250,252]], [5,[220,242,244]], [10,[155,217,222]],
                 [16,[245,201,122]], [22,[232,145,107]], [28,[192,73,47]]];
  const t0 = Math.max(0, Math.min(28, v ?? 0));
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t0 >= stops[i][0] && t0 <= stops[i+1][0]) { a = stops[i]; b = stops[i+1]; break; }
  }
  const t = (t0 - a[0]) / Math.max(1e-6, b[0] - a[0]);
  const c = a[1].map((v0, i) => Math.round(v0 + t * (b[1][i] - v0)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// A hexagon in world metres, centred on a site.
function hexPoints(cxm, cym) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (90 + i * 60) * Math.PI / 180;        // world bearing, +Y north
    return `${wx(cxm + HEX_R * Math.cos(a))},${wy(cym + HEX_R * Math.sin(a))}`;
  }).join(" ");
}

// A sector petal: a wedge of `half` degrees either side of a compass bearing.
function petalPath(cxm, cym, rM, azDeg, half) {
  const pt = (deg) => {
    const a = (90 - deg) * Math.PI / 180;
    return [wx(cxm + rM * Math.cos(a)), wy(cym + rM * Math.sin(a))];
  };
  const p0 = pt(azDeg - half), p1 = pt(azDeg + half);
  const r = rM * PPM;
  return `M ${wx(cxm)} ${wy(cym)} L ${p0[0]} ${p0[1]} A ${r} ${r} 0 0 1 ${p1[0]} ${p1[1]} Z`;
}

function beamWedge(azCenter, halfWidth, nearR, farR, key, fill, gradId) {
  const p1 = polarToScreen(azCenter - halfWidth, nearR);
  const p2 = polarToScreen(azCenter - halfWidth, farR);
  const p3 = polarToScreen(azCenter + halfWidth, farR);
  const p4 = polarToScreen(azCenter + halfWidth, nearR);
  return <polygon key={key}
    points={`${p1.sx},${p1.sy} ${p2.sx},${p2.sy} ${p3.sx},${p3.sy} ${p4.sx},${p4.sy}`}
    fill={gradId ? `url(#${gradId})` : fill} stroke={fill}
    strokeOpacity="0.35" strokeWidth="1" />;
}

export default function Radar({ state, mode, onWalk, onSplit }) {
  const svgRef = useRef(null);
  const splitFirst = useRef(null);
  const [target, setTarget] = React.useState(null);
  React.useEffect(() => {
    if (mode !== "split") splitFirst.current = null;
    if (mode !== "walk") setTarget(null);
  }, [mode]);

  const tiltToRange = (t) => TOWER_H / Math.tan(Math.max(1, t) * Math.PI / 180);
  const rangeToTilt = (R) => Math.atan(TOWER_H / R) * 180 / Math.PI;
  const action = state?.action || "follow";
  const fan   = state?.fanCenter ?? 0;
  const tilt  = state?.tilt ?? 20;
  const neighbours = state?.neighbours || [];
  const gate = state?.gate || null;
  const budget = gate?.budget ?? 1.0;

  // --- beam footprint drawn from the COMMANDED beam config ---
  // Honesty rule: the picture comes from what the rApp commanded (fan_center and
  // tilt), not from the simulator's private knowledge of the crowd. A real SMO
  // only knows what it configured.
  const EL_BW = action === "widen" ? 14 : 8;
  const AZ_BW = action === "widen" ? 52 : 34;
  const centerRange = tiltToRange(tilt);
  const theta   = rangeToTilt(centerRange);
  const physFar  = TOWER_H / Math.tan(Math.max(2,  theta - EL_BW / 2) * Math.PI / 180);
  const physNear = TOWER_H / Math.tan(Math.min(80, theta + EL_BW / 2) * Math.PI / 180);
  const depth = physFar - physNear;
  const nearR = Math.max(8, centerRange - depth / 2);
  const farR  = Math.min(RANGE_MAX, centerRange + depth / 2);
  const halfW = AZ_BW / 2;
  const beamFill = action === "widen" ? "#B0322B"
                 : (action === "allocate" ? "#3B5566" : "#0E7C86");

  function handleClick(e) {
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const loc = pt.matrixTransform(ctm.inverse());
    const { az, range } = screenToPolar(loc.x, loc.y);
    if (mode === "split") {
      if (!splitFirst.current) { splitFirst.current = { az, range }; }
      else { onSplit(splitFirst.current, { az, range }); splitFirst.current = null; }
    } else {
      setTarget({ az, range });
      onWalk({ az, range });
    }
  }

  const rings = [50, 100, 150].map(r => {
    const p = polarToScreen(0, r), rpx = r * PPM;
    const l = polarToScreen(-55, r), rr = polarToScreen(55, r);
    return <g key={r}>
      <path d={`M ${l.sx} ${l.sy} A ${rpx} ${rpx} 0 0 1 ${rr.sx} ${rr.sy}`}
            fill="none" stroke="#cbd5e1" strokeWidth="1" />
      <text x={p.sx} y={p.sy - 4} fill="#94a3b8" fontSize="9" textAnchor="middle">{r}m</text>
    </g>;
  });
  const edgeL = polarToScreen(-55, RANGE_MAX), edgeR = polarToScreen(55, RANGE_MAX);

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} onClick={handleClick}
         preserveAspectRatio="xMidYMid meet"
         className="max-h-full max-w-full rounded-xl cursor-crosshair"
         style={{ background: "#f8fafc", height: "100%", width: "auto",
                  aspectRatio: `${W} / ${H}` }}>
      <defs>
        <radialGradient id="beamGrad" gradientUnits="userSpaceOnUse"
          cx={polarToScreen(fan, centerRange).sx} cy={polarToScreen(fan, centerRange).sy}
          r={Math.abs(polarToScreen(fan, nearR).sy - polarToScreen(fan, farR).sy) * 0.75}>
          <stop offset="0%"   stopColor={beamFill} stopOpacity={action === "widen" ? 0.55 : 0.7} />
          <stop offset="55%"  stopColor={beamFill} stopOpacity="0.3" />
          <stop offset="100%" stopColor={beamFill} stopOpacity="0.06" />
        </radialGradient>
      </defs>

      {/* ---- hex lattice ---- */}
      <polygon points={hexPoints(0, 0)} fill="none" stroke="#e2e8f0" strokeWidth="1.2" />
      {neighbours.map(c => (
        <polygon key={`hex${c.id}`} points={hexPoints(c.x, c.y)} fill="none"
                 stroke={gate?.cells?.find(g => g.id === c.id)?.overBudget ? "#C0492F" : "#e2e8f0"}
                 strokeWidth={gate?.cells?.find(g => g.id === c.id)?.overBudget ? 2.2 : 1.2} />
      ))}

      {/* ---- neighbour sites: three petals each, heat filled ---- */}
      {neighbours.map(c => {
        const g = gate?.cells?.find(x => x.id === c.id);
        const sx0 = wx(c.x), sy0 = wy(c.y);
        const labelAbove = c.y > 120;   // the site straight ahead      // the site straight ahead: label above it,
                                           // because below it is where our beam is drawn
        return (
          <g key={c.id}>
            {c.sectors.map(sec => {
              const gs = g?.sectors?.find(x => x.az === sec.az);
              const over = gs?.overBudget;
              const a = (90 - sec.az) * Math.PI / 180;
              return (
                <g key={sec.az}>
                  <path d={petalPath(c.x, c.y, 44, sec.az, 48)}
                        fill={heatFill(sec.noiseRise)}
                        stroke={over ? "#C0492F" : "#94A3B8"}
                        strokeWidth={over ? 2.2 : 0.8} strokeLinejoin="round" />
                  <text x={wx(c.x + 23 * Math.cos(a))} y={wy(c.y + 23 * Math.sin(a)) + 4}
                        textAnchor="middle" fontSize="11" fontWeight="700"
                        fill={over ? "#C0492F" : "#0E2A47"}>
                    {sec.noiseRise.toFixed(1)}
                  </text>
                </g>
              );
            })}
            <polygon points={`${sx0},${sy0-6} ${sx0-5},${sy0+4} ${sx0+5},${sy0+4}`}
                     fill="#0E2A47" stroke="#fff" strokeWidth="1" />
            <text x={sx0} y={labelAbove ? sy0 - HEX_R * PPM - 16 : sy0 + HEX_R * PPM + 15}
                  textAnchor="middle" fontSize="11" fontWeight="700" fill="#334155">
              SITE {c.id}
            </text>
            {g && (
              <text x={sx0} y={labelAbove ? sy0 - HEX_R * PPM - 3 : sy0 + HEX_R * PPM + 28}
                    textAnchor="middle" fontSize="10"
                    fontWeight={g.overBudget ? "700" : "400"}
                    fill={g.overBudget ? "#C0492F" : "#94A3B8"}>
                {g.delta >= 0 ? "+" : ""}{g.delta.toFixed(2)} dB{g.overBudget ? "  OVER" : ""}
              </text>
            )}
          </g>
        );
      })}

      {/* ---- our own site: three sectors, the serving one live ---- */}
      {[120, 240].map(az => (
        <path key={az} d={petalPath(0, 0, 44, az, 48)} fill="#e2e8f0" opacity="0.7"
              stroke="#cbd5e1" strokeWidth="0.8" strokeLinejoin="round" />
      ))}

      {/* our sector edges and range rings */}
      <line x1={CX} y1={CY} x2={edgeL.sx} y2={edgeL.sy}
            stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 4" />
      <line x1={CX} y1={CY} x2={edgeR.sx} y2={edgeR.sy}
            stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 4" />
      {rings}

      {/* the beam footprint */}
      {beamWedge(fan, halfW, nearR, farR, "beam", beamFill, "beamGrad")}

      {/* crowd */}
      {(state?.ues || []).map((u, i) => {
        const a = Math.atan2(u.x, u.y) * 180 / Math.PI, rng = Math.hypot(u.x, u.y);
        const { sx, sy } = polarToScreen(a, rng);
        return <circle key={i} cx={sx} cy={sy} r="2.6"
                       fill={action === "widen" ? "#dc2626" : "#0f172a"} opacity="0.95" />;
      })}

      {/* fan-centre pointer */}
      {(() => { const p = polarToScreen(fan, centerRange);
        return <line x1={CX} y1={CY} x2={p.sx} y2={p.sy} stroke="#E08A1E"
                     strokeWidth="1.5" strokeDasharray="6 5" opacity="0.8" />; })()}

      {/* trail */}
      {(state?.trail || []).map((pt, i, arr) => {
        const p = polarToScreen(pt.az, pt.range), age = (i + 1) / arr.length;
        return <circle key={"tr" + i} cx={p.sx} cy={p.sy} r="1.9"
                       fill="#16a34a" opacity={0.12 + age * 0.35} />;
      })}

      {/* centroid */}
      {state?.centroid && (() => {
        const p = polarToScreen(state.centroid.az, state.centroid.range);
        return <g>
          <circle cx={p.sx} cy={p.sy} r="5" fill="#16a34a" opacity="0.25" />
          <circle cx={p.sx} cy={p.sy} r="3" fill="#16a34a" stroke="#fff" strokeWidth="1" />
        </g>;
      })()}

      {/* our tower */}
      <rect x={CX - 6} y={CY - 6} width="12" height="12" fill="#0f172a" rx="2" />
      <text x={CX} y={CY + 20} fill="#334155" fontSize="11" textAnchor="middle" fontWeight="700">
        SITE 1 · serving
      </text>
      <text x={CX} y={CY + 34} fill="#0E7C86" fontSize="10.5" textAnchor="middle" fontFamily="monospace">
        az {fan.toFixed(1)}°  tilt {tilt.toFixed(1)}°
      </text>

      {/* walk target */}
      {mode === "walk" && target && (() => {
        const p = polarToScreen(target.az, target.range);
        return <g>
          <circle cx={p.sx} cy={p.sy} r="8" fill="none" stroke="#E08A1E" strokeWidth="2" />
          <line x1={p.sx-11} y1={p.sy} x2={p.sx+11} y2={p.sy} stroke="#E08A1E" strokeWidth="1.5" />
          <line x1={p.sx} y1={p.sy-11} x2={p.sx} y2={p.sy+11} stroke="#E08A1E" strokeWidth="1.5" />
        </g>;
      })()}

      {/* legend, bottom left */}
      <g>
        <text x="14" y={H - 44} fontSize="9.5" fill="#94a3b8" fontWeight="700">
          NOISE RISE OUR BEAM CAUSES (dB)
        </text>
        {[0, 5, 10, 16, 22, 28].map((v, i) => (
          <rect key={v} x={14 + i * 26} y={H - 38} width="26" height="9" fill={heatFill(v)} />
        ))}
        <text x="14" y={H - 18} fontSize="9" fill="#94a3b8">0</text>
        <text x={14 + 6 * 26} y={H - 18} fontSize="9" fill="#94a3b8" textAnchor="end">28+</text>
        <text x={14 + 6 * 26 + 12} y={H - 29} fontSize="9" fill="#94a3b8">
          budget {budget} dB per move · downlink spill only · ISD {ISD} m
        </text>
      </g>

      {/* handover flag */}
      {gate?.handover && (
        <g>
          <rect x={W/2 - 150} y="12" width="300" height="30" rx="6" fill="#E08A1E" />
          <text x={W/2} y="32" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff">
            CROWD LEAVING TOWARD {gate.handover.toward} · HANDOVER
          </text>
        </g>
      )}
    </svg>
  );
}
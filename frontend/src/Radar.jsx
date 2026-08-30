import React, { useRef } from "react";

// world: azimuth -55..55 deg, range 0..150 m. We render a top-down sector.
// tower at bottom-center. Screen y grows downward, so range maps downward from tower.

const W = 620, H = 560;
const TOWER_H = 25;  // antenna height in meters (matches backend geometry)
const CX = W / 2, CY = H - 40;      // tower screen position
const R_PX = H - 90;                // pixels for max range
const RANGE_MAX = 150;

function polarToScreen(azDeg, range) {
  const a = azDeg * Math.PI / 180;
  const r = (range / RANGE_MAX) * R_PX;
  return { sx: CX + r * Math.sin(a), sy: CY - r * Math.cos(a) };
}
function screenToPolar(sx, sy) {
  const dx = sx - CX, dy = CY - sy;
  const range = Math.hypot(dx, dy) / R_PX * RANGE_MAX;
  const az = Math.atan2(dx, dy) * 180 / Math.PI;
  return { az: Math.max(-54, Math.min(54, az)), range: Math.max(12, Math.min(RANGE_MAX, range)) };
}

function beamWedge(azCenter, halfWidth, nearR, farR, key, fill, op, gradId) {
  const p1 = polarToScreen(azCenter - halfWidth, nearR);
  const p2 = polarToScreen(azCenter - halfWidth, farR);
  const p3 = polarToScreen(azCenter + halfWidth, farR);
  const p4 = polarToScreen(azCenter + halfWidth, nearR);
  return <polygon key={key} points={`${p1.sx},${p1.sy} ${p2.sx},${p2.sy} ${p3.sx},${p3.sy} ${p4.sx},${p4.sy}`}
    fill={gradId ? `url(#${gradId})` : fill} stroke={fill} strokeOpacity="0.35" strokeWidth="1" />;
}

export default function Radar({ state, mode, onWalk, onSplit }) {
  const svgRef = useRef(null);
  const splitFirst = useRef(null);
  const [target, setTarget] = React.useState(null); // {az, range} the clicked walk target
  // clear stale markers when the mode changes
  React.useEffect(() => {
    if (mode !== "split") splitFirst.current = null;
    if (mode !== "walk") setTarget(null);
  }, [mode]);

  const tiltToRange = (t) => 25 / Math.tan(Math.max(1, t) * Math.PI / 180);
  const rangeToTilt = (R) => Math.atan(TOWER_H / R) * 180 / Math.PI;
  const action = state?.action || "follow";
  const fan = state?.fanCenter ?? 0;
  const tilt = state?.tilt ?? 20;
  const beamAz = state?.beamAzimuths || [];
  const crowd = state?.centroid || { az: 0, range: 60 };

  // --- beam footprint drawn from the COMMANDED beam config ---
  // Honesty rule: the picture must come from what the rApp commanded (fan_center + tilt),
  // not from the simulator's private knowledge of the crowd's true spread. A real SMO
  // only knows what it configured. Widening on `action` is a commanded state, so it stays.
  const EL_BW = action === "widen" ? 14 : 8;          // elevation beamwidth, deg
  const AZ_BW = action === "widen" ? 52 : 34;         // fan angular coverage, deg
  const centerRange = tiltToRange(tilt);              // range follows the commanded tilt
  const theta = rangeToTilt(centerRange);
  const physFar = TOWER_H / Math.tan(Math.max(2, theta - EL_BW / 2) * Math.PI / 180);
  const physNear = TOWER_H / Math.tan(Math.min(80, theta + EL_BW / 2) * Math.PI / 180);
  const depth = physFar - physNear;
  const nearR = Math.max(8, centerRange - depth / 2);
  const farR = Math.min(RANGE_MAX, centerRange + depth / 2);
  const halfW = AZ_BW / 2;
  const beamFill = action === "widen" ? "#B0322B" : (action === "allocate" ? "#3B5566" : "#0E7C86");

  function handleClick(e) {
    const svg = svgRef.current;
    // map screen pixel -> SVG viewBox coords using the SVG's own transform matrix.
    // This is correct even when the SVG is scaled/letterboxed by preserveAspectRatio.
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
      setTarget({ az, range });   // show where the crowd is headed
      onWalk({ az, range });
    }
  }

  // range rings
  const rings = [50, 100, 150].map(r => {
    const p = polarToScreen(0, r);
    const rpx = (r / RANGE_MAX) * R_PX;
    return <g key={r}>
      <path d={`M ${polarToScreen(-55,r).sx} ${polarToScreen(-55,r).sy} A ${rpx} ${rpx} 0 0 1 ${polarToScreen(55,r).sx} ${polarToScreen(55,r).sy}`}
        fill="none" stroke="#cbd5e1" strokeWidth="1" />
      <text x={p.sx} y={p.sy - 4} fill="#64748b" fontSize="10" textAnchor="middle">{r}m</text>
    </g>;
  });
  // sector edges
  const edgeL = polarToScreen(-55, RANGE_MAX), edgeR = polarToScreen(55, RANGE_MAX);

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} onClick={handleClick}
         preserveAspectRatio="xMidYMid meet"
         className="max-h-full max-w-full rounded-xl cursor-crosshair" style={{ background: "#f1f5f9", height: "100%", width: "auto", aspectRatio: `${W} / ${H}` }}>
      {/* beam energy gradient: hot (opaque) at the crowd/peak, fading to weak at the edges */}
      <defs>
        <radialGradient id="beamGrad" gradientUnits="userSpaceOnUse"
          cx={polarToScreen(fan, centerRange).sx} cy={polarToScreen(fan, centerRange).sy}
          r={Math.abs(polarToScreen(fan, nearR).sy - polarToScreen(fan, farR).sy) * 0.75}>
          <stop offset="0%" stopColor={beamFill} stopOpacity={action === "widen" ? 0.55 : 0.7} />
          <stop offset="55%" stopColor={beamFill} stopOpacity="0.3" />
          <stop offset="100%" stopColor={beamFill} stopOpacity="0.06" />
        </radialGradient>
      </defs>
      {/* sector edges */}
      <line x1={CX} y1={CY} x2={edgeL.sx} y2={edgeL.sy} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 4" />
      <line x1={CX} y1={CY} x2={edgeR.sx} y2={edgeR.sy} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 4" />
      {rings}

      {/* the beam footprint — coverage patch, energy peaks at center (crowd), fades to edges */}
      {beamWedge(fan, halfW, nearR, farR, "beam", beamFill, 1, "beamGrad")}

      {/* crowd dots */}
      {(state?.ues || []).map((u, i) => {
        const { sx, sy } = polarToScreen(...(() => { const a = Math.atan2(u.x, u.y) * 180 / Math.PI; const rng = Math.hypot(u.x, u.y); return [a, rng]; })());
        return <circle key={i} cx={sx} cy={sy} r="3.1" fill={action === "widen" ? "#dc2626" : "#0f172a"} opacity="0.95" />;
      })}

      {/* fan-center pointer */}
      {(() => { const p = polarToScreen(fan, centerRange); return <line x1={CX} y1={CY} x2={p.sx} y2={p.sy} stroke="#E08A1E" strokeWidth="1.5" strokeDasharray="6 5" opacity="0.8" />; })()}

      {/* centroid trail — breadcrumbs of where the beam has aimed */}
      {(state?.trail || []).map((pt, i, arr) => {
        const p = polarToScreen(pt.az, pt.range);
        const age = (i + 1) / arr.length; // older = fainter
        return <circle key={"tr" + i} cx={p.sx} cy={p.sy} r="2.2" fill="#16a34a" opacity={0.12 + age * 0.35} />;
      })}

      {/* centroid — green dot the beam points at, moves with the crowd */}
      {state?.centroid && (() => {
        const p = polarToScreen(state.centroid.az, state.centroid.range);
        return <g>
          <circle cx={p.sx} cy={p.sy} r="6" fill="#16a34a" opacity="0.25" />
          <circle cx={p.sx} cy={p.sy} r="3.5" fill="#16a34a" stroke="#fff" strokeWidth="1" />
        </g>;
      })()}

      {/* tower */}
      <rect x={CX - 6} y={CY - 6} width="12" height="12" fill="#0f172a" rx="2" />
      <text x={CX} y={CY + 22} fill="#475569" fontSize="11" textAnchor="middle">gNodeB</text>
      <text x={CX} y={CY + 36} fill="#0E7C86" fontSize="10.5" textAnchor="middle" fontFamily="monospace">
        az {fan.toFixed(1)}°  tilt {tilt.toFixed(1)}°
      </text>

      {/* walk target marker — where the crowd is headed */}
      {mode === "walk" && target && (() => {
        const p = polarToScreen(target.az, target.range);
        return <g>
          <circle cx={p.sx} cy={p.sy} r="9" fill="none" stroke="#E08A1E" strokeWidth="2" />
          <line x1={p.sx - 13} y1={p.sy} x2={p.sx + 13} y2={p.sy} stroke="#E08A1E" strokeWidth="1.5" />
          <line x1={p.sx} y1={p.sy - 13} x2={p.sx} y2={p.sy + 13} stroke="#E08A1E" strokeWidth="1.5" />
        </g>;
      })()}

      {/* split hint */}
      {mode === "split" && splitFirst.current &&
        (() => { const p = polarToScreen(splitFirst.current.az, splitFirst.current.range);
          return <circle cx={p.sx} cy={p.sy} r="7" fill="none" stroke="#E08A1E" strokeWidth="2" />; })()}
    </svg>
  );
}
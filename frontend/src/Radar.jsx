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
// The canvas aspect must match the panel, or the SVG is sized by whichever
// dimension runs out first and the other one wastes space. The panel is wide and
// short (roughly 1.7:1), so the world is cropped to the same shape: everything
// then scales up by about 40 percent instead of letterboxing.
//
// The consequence is that the hexes clip at the frame edge. That is fine and it
// is what a real planning tool looks like — you always see a cropped piece of the
// grid, never the whole lattice.
// Cropped tight around the serving sector. The anchor is the show; the
// neighbours are context at the edges. Our 150 m sector now fills about half the
// canvas height instead of a third.
const WX0 = -280, WX1 = 280, WY0 = -55, WY1 = 265;
const PPM = 1.5;                                   // pixels per metre
const W = (WX1 - WX0) * PPM, H = (WY1 - WY0) * PPM;
const TOWER_H = 25;                                // matches backend geometry
const RANGE_MAX = 150;                             // our own sector's drawn reach
const ISD = 200;
// Hex radius is a DRAWING choice, not physics. The geometric value for an ISD of
// 200 m is 115 m, which drew a huge outline with a lot of dead space between it
// and the sector petals, and made adjacent cells look like they were touching.
// Drawn at 72 m the cells read as separate objects. The site POSITIONS are still
// the true lattice at ISD 200 m, which is what the physics uses.
const HEX_R = 72;

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

// noise rise -> fill.
//
// The scale is 0 to 10 dB, not 0 to 28. The 28 came from the earlier version that
// modelled neighbour links as line of sight and produced 15-30 dB everywhere;
// with the corrected NLOS path loss the real range is roughly 0.2 to 9 dB, and on
// a 28 dB scale every cell rendered the same pale blue. A scale has to span the
// data or it carries no information.
//
// 0 dB   untouched
// 1 dB   the per-move budget, the ITU-R interference protection criterion
// 5 dB   heavily lit
// 10 dB+ saturated
const HEAT_MAX = 10;
function heatFill(v) {
  const stops = [[0,[248,250,252]], [1,[220,242,244]], [3,[155,217,222]],
                 [5,[245,201,122]], [7,[232,145,107]], [10,[192,73,47]]];
  const t0 = Math.max(0, Math.min(HEAT_MAX, v ?? 0));
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

// ---------------------------------------------------------------------------
// THE ACTUAL ANTENNA PATTERN.
//
// The old drawing was a hard-edged patch: the beam started at one range, stopped
// at another, and outside it there was nothing. That is a coverage footprint, the
// half-power contour, and it is a reasonable thing to draw. But it made the
// picture contradict the numbers — the patch stopped at ~120 m while the neighbour
// at 200 m was lit up red, and nothing on screen explained how.
//
// A real beam has no wall. It fades. So the field below is the same gain model the
// harm calculation uses, sampled over the sector and drawn as it actually falls
// off, out past the neighbours.
//
// 3GPP TR 38.901 Table 7.3-1:
//   A_H(phi)   = 12 * (phi   / 20)^2   capped at 30 dB
//   A_V(theta) = 12 * (theta / 20)^2   capped at 30 dB
//   A          = G_max - min(A_H + A_V, 30)
// summed over the five beams IN LINEAR POWER, because dB values cannot be added.
//
// This is GAIN, not received power. Path loss is a property of how far the
// receiver is, not of the beam. Including it would collapse the field back into a
// blob near the tower and hide exactly what we are trying to show.
const G_MAX_DBI = 15, HPBW = 20, A_MAX = 30;
function elementGain(azOff, elOff) {
  const aH = Math.min(12 * Math.pow(azOff / HPBW, 2), A_MAX);
  const aV = Math.min(12 * Math.pow(elOff / HPBW, 2), A_MAX);
  return G_MAX_DBI - Math.min(aH + aV, A_MAX);
}
// Total gain of the five-beam fan toward a point, in dB.
function fanGainDb(azs, tiltDeg, azDeg, rangeM) {
  const depression = Math.atan2(TOWER_H, Math.max(1, rangeM)) * 180 / Math.PI;
  const elOff = depression - tiltDeg;
  let lin = 0;
  for (const b of azs) lin += Math.pow(10, elementGain(azDeg - b, elOff) / 10);
  return 10 * Math.log10(lin);
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

      {/* PAINT ORDER MATTERS.
           The beam field is drawn HERE, before the neighbour cells, so the cells
           sit on top of it. Drawn after, the translucent field washed over the
           petals and their colours could not be read — which defeats the point of
           having a heat scale at all. The beam is the background; the cells and
           their numbers are the foreground. */}
      {/* ---- the beam field, drawn from the real pattern ----
           Sampled on a polar grid and shaded by gain relative to the peak. It
           fades rather than stopping, which is why a neighbour at 200 m can be
           lit while the half-power footprint ends at 120 m. The dashed contour is
           that half-power edge, kept because it is the useful "who do I actually
           serve" line — it is now labelled as such instead of pretending to be
           the whole beam. */}
      {(() => {
        const azs = state?.beamAzimuths || [fan - 30, fan - 15, fan, fan + 15, fan + 30];
        const AZ_STEP = 4, R_STEP = 18, R_MIN = 15, R_MAX = 300;
        const peak = fanGainDb(azs, tilt, fan, tiltToRange(tilt));
        const cells = [];
        for (let a = -74; a < 74; a += AZ_STEP) {
          for (let r = R_MIN; r < R_MAX; r += R_STEP) {
            const g = fanGainDb(azs, tilt, a + AZ_STEP / 2, r + R_STEP / 2);
            const rel = g - peak;                       // dB below the peak
            if (rel < -20) continue;                    // below this it is invisible
            // POWER scaling, not amplitude. Amplitude (rel/20) was tried first and
            // the tail stayed so visible that the field flooded the whole canvas
            // and washed out the neighbour cells. Power (rel/10) falls off the way
            // the energy actually does: -5 dB is a third as bright, -10 dB a
            // tenth, -20 dB gone.
            const op = Math.pow(10, rel / 10) * 0.75;
            const p1 = polarToScreen(a, r), p2 = polarToScreen(a, r + R_STEP);
            const p3 = polarToScreen(a + AZ_STEP, r + R_STEP), p4 = polarToScreen(a + AZ_STEP, r);
            cells.push(
              <polygon key={`f${a}_${r}`}
                points={`${p1.sx},${p1.sy} ${p2.sx},${p2.sy} ${p3.sx},${p3.sy} ${p4.sx},${p4.sy}`}
                fill={beamFill} opacity={op} stroke="none" />);
          }
        }
        return <g>{cells}</g>;
      })()}

      {/* half-power footprint, as a contour not a solid */}
      {(() => {
        const p1 = polarToScreen(fan - halfW, nearR), p2 = polarToScreen(fan - halfW, farR);
        const p3 = polarToScreen(fan + halfW, farR),  p4 = polarToScreen(fan + halfW, nearR);
        return <polygon
          points={`${p1.sx},${p1.sy} ${p2.sx},${p2.sy} ${p3.sx},${p3.sy} ${p4.sx},${p4.sy}`}
          fill="none" stroke="#0E7C86" strokeWidth="1.4" strokeDasharray="5 4" opacity="0.85" />;
      })()}

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
                  <path d={petalPath(c.x, c.y, 38, sec.az, 48)}
                        fill={heatFill(sec.noiseRise)}
                        stroke={over ? "#C0492F" : "#94A3B8"}
                        strokeWidth={over ? 2.2 : 0.8} strokeLinejoin="round" />
                  <text x={wx(c.x + 20 * Math.cos(a))} y={wy(c.y + 20 * Math.sin(a)) + 3.5}
                        textAnchor="middle" fontSize="10" fontWeight="700"
                        fill={over ? "#C0492F" : "#0E2A47"}>
                    {sec.noiseRise.toFixed(1)}
                  </text>
                </g>
              );
            })}
            <polygon points={`${sx0},${sy0-6} ${sx0-5},${sy0+4} ${sx0+5},${sy0+4}`}
                     fill="#0E2A47" stroke="#fff" strokeWidth="1" />
            {/* Labels hug the site marker, not the hex edge. The hexes clip at the
                frame now, so a label pinned to the hex would fall off screen. */}
            <text x={sx0} y={labelAbove ? sy0 - 74 : sy0 + 72}
                  textAnchor="middle" fontSize="11" fontWeight="700" fill="#334155">
              SITE {c.id}
            </text>
            {g && (
              <text x={sx0} y={labelAbove ? sy0 - 61 : sy0 + 85}
                    textAnchor="middle" fontSize="11"
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
        <text x="14" y={H - 56} fontSize="9" fill="#94a3b8">
          shaded field = real antenna pattern, fades not stops · dashed = half-power footprint
        </text>
        {[0, 1, 3, 5, 7, 10].map((v, i) => (
          <rect key={v} x={14 + i * 26} y={H - 38} width="26" height="9" fill={heatFill(v)} />
        ))}
        <text x="14" y={H - 18} fontSize="9" fill="#94a3b8">0</text>
        <text x={14 + 2 * 26} y={H - 18} fontSize="9" fill="#94a3b8" textAnchor="middle">1 dB budget</text>
        <text x={14 + 6 * 26} y={H - 18} fontSize="9" fill="#94a3b8" textAnchor="end">10+</text>
        <text x={14 + 6 * 26 + 12} y={H - 29} fontSize="9"
              fill={gate?.observeMode ? "#E08A1E" : "#94a3b8"}
              fontWeight={gate?.observeMode ? "700" : "400"}>
          {gate?.observeMode
            ? `OBSERVE MODE — gate off, every move commits. Deltas still computed.`
            : `budget ${budget} dB per move · downlink spill only · ISD ${ISD} m`}
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
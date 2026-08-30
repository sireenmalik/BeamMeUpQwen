// model.js — pluggable rApp brain. Emits PARAMETERS ONLY (fan_center, tilt, action, reason).
// The formatter tool turns those into JSON. Endpoint chosen by env:
//
//   MODEL_PROVIDER = anthropic | openai | none   (default: none -> deterministic)
//   MODEL_ENDPOINT = base url for the local OpenAI-compatible server (serve.py / Ollama)
//   MODEL_NAME     = model id
//   MODEL_API_KEY  = key (anthropic or openai-compatible)
//
// "none" runs a deterministic forecaster so the demo works with zero credentials.
// The LLM path is the same contract — it just replaces the math with a model call.

const PROVIDER = (process.env.MODEL_PROVIDER || "none").toLowerCase();

// ---- the prompt the LLM sees (few-shot, parameter-out) ----
function buildPrompt(obs) {
  return `You are a Non-RT RIC rApp steering a grid of uplink beams toward the load in a cell.
You see ONLY standard 3GPP telemetry: SS-RSRP per SSB beam (dBm) and the cell UE total.
You never see UE positions. Output the beam target for the NEXT tick.

Return ONLY a compact JSON object with these keys, no prose:
  fan_center  number  azimuth degrees, -49..49
  tilt        number  degrees, 3..45  (smaller tilt = farther coverage)
  action      string  one of: follow, allocate, widen, hold
  reason      string  <=12 words

Context:
  current_fan_center: ${obs.currentFanCenter}
  current_tilt: ${obs.currentTilt}
  beam_azimuths: ${JSON.stringify(obs.beamAzimuths)}
  ssb_rsrp_dBm (per beam, -156 means no served UE): ${JSON.stringify(obs.ssbRsrp)}
  rsrp_power_profile (normalized): ${JSON.stringify(obs.rsrpProfile)}
  rsrp_weighted_azimuth: ${obs.rsrpWeightedAz}
  smoothed_centroid_az: ${obs.centroidAz}
  centroid_vel_deg_per_tick: ${obs.centroidVel}
  spread_now: ${obs.spreadNow}
  spread_rising_fast: ${obs.spreadRising}
  cell_ue_total: ${obs.load}

Rules:
- Normal movement: point fan_center at the RSRP weight, a little AHEAD along its velocity. action=follow.
- If spread_rising_fast is true and the weight is barely moving: radial dispersal. action=widen.
- If the RSRP power is split across both edges of the grid: action=allocate.
- Keep tilt so coverage sits on the crowd's range.`;
}

// ---- deterministic fallback (also the "no model" path) ----
function deterministic(obs) {
  const lead = 2.2; // ticks of lead
  const base = (obs.rsrpWeightedAz != null) ? obs.rsrpWeightedAz : obs.centroidAz;
  let fan = base + obs.centroidVel * lead;
  let action = "follow";
  if (obs.spreadRising && Math.abs(obs.centroidVel) < 0.6) { action = "widen"; fan = base; }
  else if (obs.splitDetected) { action = "allocate"; }
  const tilt = obs.currentTilt;
  return { fan_center: +fan.toFixed(2), tilt, action, reason:
    action === "widen" ? "radial dispersal, widen coverage"
    : action === "allocate" ? "load split, share beams"
    : "lead ahead of crowd" };
}

async function callAnthropic(obs) {
  const body = {
    model: process.env.MODEL_NAME || "claude-sonnet-4-6",
    max_tokens: 200,
    temperature: 0,
    messages: [{ role: "user", content: buildPrompt(obs) }]
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.MODEL_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  const text = (data.content || []).map(c => c.text || "").join("");
  return parseParams(text, obs);
}

async function callOpenAICompatible(obs) {
  // local Qwen 2.5 + LoRA adapter served by serve.py (or Ollama) on an OpenAI-compatible endpoint
  const base = process.env.MODEL_ENDPOINT || "http://localhost:8000/v1";
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.MODEL_API_KEY ? { authorization: `Bearer ${process.env.MODEL_API_KEY}` } : {})
    },
    body: JSON.stringify({
      model: process.env.MODEL_NAME || "qwen2.5:1.5b",
      temperature: 0,
      max_tokens: 200,
      messages: [{ role: "user", content: buildPrompt(obs) }],
      chat_template_kwargs: { enable_thinking: false }
    })
  });
  if (!r.ok) {
    const errText = await r.text();
    console.error("CALL-FAIL:", r.status, errText.slice(0, 200));
    return deterministic(obs);
  }
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || "";
  return parseParams(text, obs);
}

function parseParams(text, obs) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { console.error("PARSE-FAIL: no JSON found | raw:", (text || "").slice(0, 150)); return deterministic(obs); }
    const p = JSON.parse(m[0]);
    return {
      fan_center: Number(p.fan_center),
      tilt: Number(p.tilt),
      action: p.action,
      reason: String(p.reason || "").slice(0, 80)
    };
  } catch (e) {
    console.error("PARSE-FAIL:", e.message, "| raw:", (text || "").slice(0, 150));
    return deterministic(obs);
  }
}

export async function decide(obs) {
  try {
    if (PROVIDER === "anthropic" && process.env.MODEL_API_KEY) return await callAnthropic(obs);
    if (PROVIDER === "openai") return await callOpenAICompatible(obs);
  } catch (e) {
    console.error("DECIDE-FAIL:", e.message);
  }
  return deterministic(obs);
}

export const MODEL_INFO = {
  provider: PROVIDER,
  name: process.env.MODEL_NAME || (PROVIDER === "none" ? "deterministic" : "unset")
};
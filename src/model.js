// model.js — pluggable rApp brain. Emits PARAMETERS ONLY (fan_center, tilt, action, reason).
// The formatter tool turns those into JSON. Endpoint chosen by env:
//
//   MODEL_PROVIDER = anthropic | openai | none   (default: none -> deterministic)
//   MODEL_ENDPOINT = base url for openai-compatible servers (Nemotron via NIM, Qwen, vLLM)
//   MODEL_NAME     = model id
//   MODEL_API_KEY  = key (anthropic or openai-compatible)
//
// "none" runs a deterministic forecaster so the demo works with zero credentials.
// The LLM path is the same contract — it just replaces the math with a model call.

const PROVIDER = (process.env.MODEL_PROVIDER || "none").toLowerCase();

// ---- the prompt the LLM sees (few-shot, parameter-out) ----
function buildPrompt(obs) {
  return `You are a Non-RT RIC rApp steering a fan of uplink beams to follow a moving crowd.
You see ONLY per-beam UE counts over the last few ticks — never positions.
Output the beam target for the NEXT tick, led slightly ahead of where the crowd is heading.

Return ONLY a compact JSON object with these keys, no prose:
  fan_center  number  azimuth degrees, -49..49
  tilt        number  degrees, 3..45  (smaller tilt = farther coverage)
  action      string  one of: follow, allocate, widen, hold
  reason      string  <=12 words

Context:
  current_fan_center: ${obs.currentFanCenter}
  current_tilt: ${obs.currentTilt}
  beam_azimuths: ${JSON.stringify(obs.beamAzimuths)}
  count_history (oldest..newest): ${JSON.stringify(obs.countHistory)}
  smoothed_centroid_az: ${obs.centroidAz}
  centroid_vel_deg_per_tick: ${obs.centroidVel}
  spread_now: ${obs.spreadNow}
  spread_rising_fast: ${obs.spreadRising}
  total_load: ${obs.load}

Rules:
- Normal movement: set fan_center a little AHEAD of the centroid along its velocity. action=follow.
- If spread_rising_fast is true and centroid barely moving: radial dispersal. action=widen, keep fan_center near centroid.
- If load splits across both edges: action=allocate.
- Keep tilt so coverage sits on the crowd's range.`;
}

// ---- deterministic fallback (also the "no model" path) ----
function deterministic(obs) {
  const lead = 2.2; // ticks of lead
  let fan = obs.centroidAz + obs.centroidVel * lead;
  let action = "follow";
  if (obs.spreadRising && Math.abs(obs.centroidVel) < 0.6) { action = "widen"; fan = obs.centroidAz; }
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
  // works for NVIDIA Nemotron (NIM) / Qwen / vLLM / Ollama behind an OpenAI-compatible endpoint
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
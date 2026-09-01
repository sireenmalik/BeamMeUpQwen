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

// ---------------------------------------------------------------------------
// PROMPT SCHEMAS
//
// Each trained adapter expects the exact prompt shape it was trained on. Getting this
// wrong does not throw - the model simply produces a memorised value and the beam looks
// broken in a way that is hard to attribute. That happened repeatedly, so the schema is
// selected explicitly and pinned to the adapter rather than left implicit.
//
//   PROMPT_SCHEMA=v7   fan_center only. Tilt computed in the harness.  (default)
//   PROMPT_SCHEMA=v8   fan_center + tilt from the model.
//
// Set it alongside MODEL_NAME. To roll back to v7 change BOTH:
//     MODEL_NAME=beam-v7
//     PROMPT_SCHEMA=v7
// ---------------------------------------------------------------------------
const PROMPT_SCHEMA = (process.env.PROMPT_SCHEMA || "v7").toLowerCase();

// Format numbers EXACTLY as Python's json.dumps does in the generator, because the
// adapter was trained on that byte sequence. JavaScript's JSON.stringify writes
// "[-42,-33]" while Python writes "[-45, -33]" - different tokens, and the model has
// never seen the former. Python also renders floats as "15.0" where JS renders "15".
// Both differences matter to a 0.5B model.
function fmtInts(a)  { return "[" + a.map(v => String(Math.round(v))).join(", ") + "]"; }
function fmtOneDp(a) { return "[" + a.map(v => v.toFixed(1)).join(", ") + "]"; }

const SCHEMAS = {
  // -------------------------------------------------------------- v7
  // Byte-identical to gen_v7.py. current_fan_center is deliberately absent: the weighted
  // centroid is fully determined by the RSRP profile and the beam azimuths, so supplying
  // the current beam position only gave the model a scalar to copy - and it did. tilt is
  // absent too; it is atan(h/range), with exactly one right answer for a given range.
  v7: {
    system:
      "You are a Non-RT RIC rApp steering a grid of uplink beams toward the load in a cell. " +
      "You are given SS-RSRP per SSB beam in dBm and the azimuth each beam points at. " +
      "Return ONLY one JSON object with keys: fan_center (-49..49), action " +
      "(follow|widen|allocate), reason (short). No prose, no thinking, JSON only.",
    user: (obs) =>
      `ssb_rsrp_dBm=${fmtInts(obs.ssbRsrp)} (beam azimuths ${fmtOneDp(obs.beamAzimuths)} deg)`,
    // the harness computes tilt; whatever the model returns for it is ignored
    usesModelTilt: false,
  },

  // -------------------------------------------------------------- v8
  // Adds tilt. current_tilt stays OUT for the same reason current_fan_center did: given
  // it, the model echoed it back and the beam kept the wrong range while the crowd walked
  // away. Range must be inferable from the profile, so the generator has to vary crowd
  // distance widely or "always say 14" wins.
  v8: {
    system:
      "You are a Non-RT RIC rApp steering a grid of uplink beams toward the load in a cell. " +
      "You are given SS-RSRP per SSB beam in dBm and the azimuth each beam points at. " +
      "Return ONLY one JSON object with keys: fan_center (-49..49), tilt (3..45), action " +
      "(follow|widen|allocate), reason (short). No prose, no thinking, JSON only.",
    user: (obs) =>
      `ssb_rsrp_dBm=${fmtInts(obs.ssbRsrp)} (beam azimuths ${fmtOneDp(obs.beamAzimuths)} deg)`,
    usesModelTilt: true,
  },
};

const SCHEMA = SCHEMAS[PROMPT_SCHEMA] || SCHEMAS.v7;
if (!SCHEMAS[PROMPT_SCHEMA]) {
  console.warn(`PROMPT_SCHEMA="${PROMPT_SCHEMA}" is unknown, falling back to v7`);
}
export const USES_MODEL_TILT = SCHEMA.usesModelTilt;

const SYSTEM_PROMPT = SCHEMA.system;
function buildUser(obs) { return SCHEMA.user(obs); }

// Kept for callers that want one string.
function buildPrompt(obs) {
  return SYSTEM_PROMPT + "\n\n" + buildUser(obs);
}

// ---- deterministic fallback (also the "no model" path) ----
function deterministic(obs) {
  // REACTIVE: aim AT the crowd's centroid now. No lead, no projection.
  // The forecasting mode decides whether to look ahead; the deterministic path must not
  // add its own hidden lead on top, or "reactive" quietly becomes "lead".
  const base = (obs.rsrpWeightedAz != null) ? obs.rsrpWeightedAz : obs.centroidAz;
  let fan = base;
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
    messages: [{ role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: buildUser(obs) }]
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
      max_tokens: 80,
      messages: [{ role: "system", content: SYSTEM_PROMPT },
                 { role: "user", content: buildUser(obs) }],
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

// Salvage the numbers even when the generation is truncated.
// Small models can loop on a text field and blow the token budget, leaving the JSON
// unterminated. The numeric fields arrive FIRST and are complete; throwing the whole
// response away because a trailing string never closed would discard a good decision.
function salvage(text) {
  const num = (k) => {
    const m = text.match(new RegExp('"' + k + '"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)'));
    return m ? Number(m[1]) : NaN;
  };
  const str = (k) => {
    const m = text.match(new RegExp('"' + k + '"\\s*:\\s*"([^"]*)'));
    return m ? m[1] : "";
  };
  return {
    fan_center: num("fan_center"),
    tilt: num("tilt"),
    action: str("action") || "follow",
    reason: str("reason")
  };
}

// Collapse repetition in the model's reason text. Small models under-trained on the
// current input format tend to loop on a word, e.g.
//   "steering right toward the counterclockwise-moving counterclockwise-moving counterc"
// Immediate repeats are collapsed, then any word appearing more than twice is dropped
// after its second occurrence, and a dangling partial word at the end is trimmed.
function dedupe(str) {
  let s = String(str || "").replace(/\b([\w-]+)(\s+\1\b)+/gi, "$1");
  const seen = {};
  s = s.split(/\s+/).filter(w => {
    const k = w.toLowerCase();
    seen[k] = (seen[k] || 0) + 1;
    return seen[k] <= 2;
  }).join(" ");
  // drop a trailing truncated fragment ("counterc")
  const parts = s.split(" ");
  if (parts.length > 2 && parts[parts.length - 1].length < 4) parts.pop();
  return parts.join(" ").trim().slice(0, 70);
}

function parseParams(text, obs) {
  const raw = text || "";
  // 1. clean parse
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const p = JSON.parse(m[0]);
      if (Number.isFinite(Number(p.fan_center))) {
        return {
          fan_center: Number(p.fan_center),
          tilt: Number(p.tilt),
          action: p.action || "follow",
          reason: dedupe(String(p.reason || ""))
        };
      }
    }
  } catch (e) { /* fall through to salvage */ }

  // 2. truncated generation -> pull the numbers out anyway
  const s = salvage(raw);
  if (Number.isFinite(s.fan_center)) {
    console.warn("PARSE-SALVAGED: truncated generation, numbers recovered ->",
                 "fan_center=" + s.fan_center, "tilt=" + s.tilt);
    return { fan_center: s.fan_center, tilt: s.tilt, action: s.action, reason: dedupe(s.reason) };
  }

  // 3. genuinely unusable -> let the loop hold position
  console.error("PARSE-FAIL: no usable numbers | raw:", raw.slice(0, 150));
  return { fan_center: NaN, tilt: NaN, action: "hold", reason: "" };
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
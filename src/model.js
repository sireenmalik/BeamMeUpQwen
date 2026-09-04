// model.js — the rApp brain. Emits PARAMETERS ONLY (fan_center, tilt, action, reason).
// The formatter tool turns those into JSON. Endpoint chosen by env:
//
//   MODEL_PROVIDER = anthropic | openai      (no "none" — see below)
//   MODEL_ENDPOINT = base url for the local OpenAI-compatible server (serve.py / Ollama)
//   MODEL_NAME     = model id
//   MODEL_API_KEY  = key (anthropic or openai-compatible)
//
// ============================================================================
// THERE IS NO DETERMINISTIC FALLBACK. THE MODEL DECIDES OR THE BEAM HOLDS.
//
// A deterministic forecaster used to run whenever the model call failed or no
// provider was configured, and its numbers flowed through as if the model had
// produced them. `dec.source` still read "model" and nothing on screen said the
// tool had answered. That is a silent substitution and it is removed.
//
// If the model cannot be reached or returns nothing usable, decide() returns
// fan_center: NaN and tilt: NaN. loop.js sees that and HOLDS the previous beam
// position. The arithmetic never steers.
//
// The arithmetic still exists — in reference.js — but it is read-only. It records
// what it would have said so the delta can train the next adapter. It cannot
// return a value that reaches the beam.
// ============================================================================

const PROVIDER = (process.env.MODEL_PROVIDER || "openai").toLowerCase();

// ---------------------------------------------------------------------------
// PROMPT SCHEMA
//
// v9 only. Schemas v7 and v8 are removed: they had the harness compute tilt from
// the arithmetic, which is exactly the path we no longer want in the runtime.
//
// The adapter expects the exact prompt shape it was trained on. Getting this wrong
// does not throw — the model simply produces a memorised value and the beam looks
// broken in a way that is hard to attribute. That happened repeatedly.
//
//     MODEL_NAME=beam-v9   PROMPT_SCHEMA=v9
//
// NOTE ON "uplink beams" IN THE SYSTEM PROMPT.
// It is technically wrong — this is the downlink beam, rsrp = P_tx - pathloss +
// beamGain, the gNodeB transmits and the UE receives. The string stays because
// beam-v9 was trained with it, and changing it here alone is a train/inference
// mismatch. Fix this file and gen_v9.py TOGETHER at the next retrain, never one.
// ---------------------------------------------------------------------------
const PROMPT_SCHEMA = (process.env.PROMPT_SCHEMA || "v9").toLowerCase();
if (PROMPT_SCHEMA !== "v9") {
  throw new Error(
    `PROMPT_SCHEMA="${PROMPT_SCHEMA}" is not supported. v7 and v8 were removed ` +
    `because they let the harness compute tilt. Set PROMPT_SCHEMA=v9.`
  );
}

// Format numbers EXACTLY as Python's json.dumps does in the generator, because the
// adapter was trained on that byte sequence. JavaScript's JSON.stringify writes
// "[-42,-33]" while Python writes "[-45, -33]" — different tokens, and the model has
// never seen the former. Python also renders floats as "15.0" where JS renders "15".
// Both differences matter to a 0.5B model.
function fmtInts(a)  { return "[" + a.map(v => String(Math.round(v))).join(", ") + "]"; }
function fmtOneDp(a) { return "[" + a.map(v => v.toFixed(1)).join(", ") + "]"; }

const SYSTEM_PROMPT =
  "You are a Non-RT RIC rApp steering a grid of uplink beams toward the load in a cell. " +
  "You are given SS-RSRP per SSB beam in dBm and the azimuth each beam points at. " +
  "Return ONLY one JSON object with keys: fan_center (-49..49), tilt (3..45), action " +
  "(follow|widen|allocate), reason (short). No prose, no thinking, JSON only.";

function buildUser(obs) {
  return `ssb_rsrp_dBm=${fmtInts(obs.ssbRsrp)} (beam azimuths ${fmtOneDp(obs.beamAzimuths)} deg)`;
}

// The model owns tilt under v9. Kept as a named export because loop.js imports it;
// it is now always true.
export const USES_MODEL_TILT = true;

// The value returned when there is no usable decision. loop.js checks
// Number.isFinite() on these and holds the previous beam position.
//
// MUST be a factory, not a shared constant. loop.js writes the committed values back
// onto the params object it receives (params.fan_center = ...), so a shared object
// would be mutated on the first hold and every subsequent tick would then see finite
// numbers and commit them as if the model had produced them. That is exactly the
// silent substitution this change removes, reintroduced by aliasing.
function noDecision() {
  return { fan_center: NaN, tilt: NaN, action: "hold", reason: "" };
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
  if (!r.ok) {
    console.error("CALL-FAIL:", r.status, (await r.text()).slice(0, 200));
    return noDecision();
  }
  const data = await r.json();
  const text = (data.content || []).map(c => c.text || "").join("");
  return parseParams(text);
}

async function callOpenAICompatible(obs) {
  // local Qwen 2.5 + LoRA adapter served by serve.py (or Ollama) on an
  // OpenAI-compatible endpoint
  const base = process.env.MODEL_ENDPOINT || "http://localhost:8000/v1";
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.MODEL_API_KEY ? { authorization: `Bearer ${process.env.MODEL_API_KEY}` } : {})
    },
    body: JSON.stringify({
      model: process.env.MODEL_NAME || "beam-v9",
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
    return noDecision();                     // hold. do NOT substitute arithmetic.
  }
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || "";
  return parseParams(text);
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

function parseParams(text) {
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
  return noDecision();
}

export async function decide(obs) {
  try {
    if (PROVIDER === "anthropic" && process.env.MODEL_API_KEY) return await callAnthropic(obs);
    if (PROVIDER === "openai") return await callOpenAICompatible(obs);
    console.error(`DECIDE-FAIL: MODEL_PROVIDER="${PROVIDER}" is not a model provider. ` +
                  `There is no deterministic fallback. Set MODEL_PROVIDER=openai.`);
  } catch (e) {
    console.error("DECIDE-FAIL:", e.message);
  }
  return noDecision();                       // hold. never the arithmetic.
}

export const MODEL_INFO = {
  provider: PROVIDER,
  name: process.env.MODEL_NAME || "unset",
  schema: PROMPT_SCHEMA
};

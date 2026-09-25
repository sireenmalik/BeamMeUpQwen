// orchestrator.js — the piece that sits between two worlds that never touch.
//
//   NIM  (HTTPS + key)        Nemotron reasons, returns tool_calls
//   MCP  (HTTP /mcp)          CrowdTrack executes them
//
// Nemotron never reaches the rApp. The rApp never sees Nemotron. This translates.
//
// Runs OUT OF BAND: a NIM round trip takes seconds and the beam loop ticks every 3s.
// Nothing here blocks the loop. Policy changes land when they land.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const NIM_ENDPOINT = process.env.NEMOTRON_ENDPOINT || "https://integrate.api.nvidia.com/v1";
const NIM_MODEL    = process.env.NEMOTRON_MODEL    || "nvidia/nemotron-3-super-120b-a12b";
const NIM_KEY      = process.env.NEMOTRON_API_KEY  || "";
const MCP_URL      = process.env.MCP_URL || `http://127.0.0.1:${process.env.PORT || 3000}/mcp`;

const MAX_ROUNDS = 6;        // tool-call rounds before we stop
const NIM_TIMEOUT_MS = 60000;

const SYSTEM_PROMPT = `You are the orchestration layer for CrowdTrack, an O-RAN Non-RT RIC rApp
that steers a grid of five uplink beams to follow a moving crowd in a 3.5 GHz cell.

You receive an intent, usually as a 3GPP TS 28.312 Intent object with expectation targets.
Your job is to translate that intent into policy changes, using the tools available.

What you control:
  - the neighbour interference ceiling, in dB
  - whether the neighbour gate is enforced
  - the crowd scenario and whether the loop is running

What you do NOT control, and must not attempt:
  - the beam azimuth or tilt. A tuned on-device model proposes those every tick from the
    RSRP profile. Beam pointing is arithmetic with one right answer and it is not your job.
  - committing a beam move. The deterministic gate owns that.

Method:
  1. Call get_network_state first. Never reason from assumption.
  2. Use evaluate_move if you need to understand what a move would cost a neighbour.
     It is read-only.
  3. Apply the smallest set of policy changes that satisfies the intent.
  4. When done, reply in one or two plain sentences saying what you changed and why.

Useful context: the ceiling is measured as mean noise rise across the users of a neighbour
sector, tested against the worst of that site's three sectors. Useful range is 2 to 5 dB;
above roughly 5 the beam physically cannot reach the ceiling. Lower ceiling means the beam
stops reaching outward sooner, the serving signal decays, and standard 3GPP A3 handover
moves the crowd to a neighbour. That is an intended outcome, not a failure.`;

// MCP inputSchema is already JSON Schema, so this is mostly a reshape.
function mcpToolsToNim(tools) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.inputSchema || { type: "object", properties: {} }
    }
  }));
}

function textOf(mcpResult) {
  const parts = (mcpResult?.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text);
  return parts.join("\n") || "(no content)";
}

async function callNim(messages, tools, attempt = 0) {
  const MAX_RETRIES = 4;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), NIM_TIMEOUT_MS);
  try {
    const r = await fetch(`${NIM_ENDPOINT}/chat/completions`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        ...(NIM_KEY ? { authorization: `Bearer ${NIM_KEY}` } : {})
      },
      body: JSON.stringify({ model: NIM_MODEL, messages, tools, temperature: 0 })
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      // NIM returns intermittent 500s. Verified: an identical payload fails then
      // succeeds minutes later. Retry transient server errors with backoff.
      if (r.status >= 500 && attempt < MAX_RETRIES) {
        const wait = 800 * Math.pow(2, attempt);
        console.warn(`NIM ${r.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
        clearTimeout(timer);
        await new Promise((res) => setTimeout(res, wait));
        return callNim(messages, tools, attempt + 1);
      }
      throw new Error(`NIM ${r.status}: ${body}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one intent to completion.
 * Returns { ok, intent, reasoning[], calls[], summary, error? }
 * `calls` is what the UI shows: the intent translated into concrete actions.
 */
export async function runIntent(intentText) {
  const started = Date.now();
  const record = { intent: intentText, reasoning: [], calls: [], summary: "", ok: false };

  if (!NIM_KEY) {
    record.error = "NEMOTRON_API_KEY is not set";
    return record;
  }

  const client = new Client({ name: "crowdtrack-orchestrator", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));

  try {
    await client.connect(transport);

    // Real MCP discovery. The tool list is not hardcoded here.
    const listed = await client.listTools();
    const nimTools = mcpToolsToNim(listed.tools || []);
    record.discovered = nimTools.map((t) => t.function.name);

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: typeof intentText === "string" ? intentText : JSON.stringify(intentText, null, 2) }
    ];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const resp = await callNim(messages, nimTools);
      const msg = resp?.choices?.[0]?.message;
      if (!msg) throw new Error("NIM returned no message");

      if (msg.reasoning_content) record.reasoning.push(msg.reasoning_content.trim());

      const toolCalls = msg.tool_calls || [];
      if (!toolCalls.length) {
        record.summary = (msg.content || "").trim();
        record.ok = true;
        break;
      }

      // Echo back ONLY role/content/tool_calls. Sending reasoning_content back
      // makes NIM return 500 on the next round.
      messages.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: toolCalls
      });

      for (const tc of toolCalls) {
        const name = tc.function?.name;
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* leave empty */ }

        let resultText, failed = false;
        try {
          const res = await client.callTool({ name, arguments: args });
          resultText = textOf(res);
        } catch (e) {
          failed = true;
          resultText = `ERROR: ${e?.message || e}`;
        }

        record.calls.push({
          t: new Date().toTimeString().slice(0, 8),
          tool: name,
          args,
          ok: !failed,
          result: resultText.length > 600 ? resultText.slice(0, 600) + " …" : resultText
        });

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: resultText
        });
      }
    }

    if (!record.ok && !record.summary) {
      record.summary = `Stopped after ${MAX_ROUNDS} rounds without a final answer.`;
    }
  } catch (e) {
    record.error = e?.message || String(e);
    console.error("INTENT-FAIL:", record.error);
  } finally {
    try { await client.close(); } catch { /* already closed */ }
  }

  record.elapsed_ms = Date.now() - started;
  return record;
}

export const ORCHESTRATOR_INFO = {
  nim_endpoint: NIM_ENDPOINT,
  nim_model: NIM_MODEL,
  mcp_url: MCP_URL,
  key_set: Boolean(NIM_KEY)
};

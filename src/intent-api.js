// intent-api.js — the UI-facing side of the intent flow.
//
//   POST /api/intent        { intent: "..." }  -> starts a run, returns immediately
//   GET  /api/intent/log                       -> history for the translation panel
//   GET  /api/intent/info                      -> endpoint, model, MCP url, key present
//
// POST does not block. A NIM round trip takes seconds and the beam loop ticks every 3s;
// the UI polls the log and the loop never waits.

import express from "express";
import { runIntent, ORCHESTRATOR_INFO } from "./orchestrator.js";

const HISTORY_MAX = 20;

export function createIntentRouter() {
  const router = express.Router();
  const history = [];          // newest last
  let seq = 0;
  let inFlight = false;

  router.post("/", async (req, res) => {
    const intent = (req.body?.intent ?? "").toString().trim();
    if (!intent) return res.status(400).json({ ok: false, error: "intent is required" });
    if (inFlight) {
      return res.status(409).json({ ok: false, error: "an intent is already running" });
    }

    const entry = {
      id: ++seq,
      t: new Date().toTimeString().slice(0, 8),
      intent,
      status: "running",
      discovered: [],
      reasoning: [],
      calls: [],
      summary: "",
      error: null,
      elapsed_ms: null
    };
    history.push(entry);
    while (history.length > HISTORY_MAX) history.shift();

    inFlight = true;
    res.json({ ok: true, id: entry.id, status: "running" });

    // fire and forget; the UI polls /api/intent/log
    runIntent(intent)
      .then((r) => {
        entry.status = r.error ? "error" : "done";
        entry.discovered = r.discovered || [];
        entry.reasoning = r.reasoning || [];
        entry.calls = r.calls || [];
        entry.summary = r.summary || "";
        entry.error = r.error || null;
        entry.elapsed_ms = r.elapsed_ms ?? null;
      })
      .catch((e) => {
        entry.status = "error";
        entry.error = e?.message || String(e);
      })
      .finally(() => { inFlight = false; });
  });

  router.get("/log", (_req, res) => {
    res.json({ ok: true, inFlight, entries: history });
  });

  router.get("/info", (_req, res) => {
    res.json({ ok: true, ...ORCHESTRATOR_INFO });
  });

  return router;
}

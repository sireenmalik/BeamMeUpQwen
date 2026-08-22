// server.js — Express API + interval-driven control loop + static frontend.
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { ControlLoop } from "./loop.js";
import { fromPolar } from "./geometry.js";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

const loop = new ControlLoop();

// tick cadence: 1–5 s band. Default 2s (matched to pedestrian pace).
const TICK_MS = Number(process.env.TICK_MS || 2000);
let running = false;   // start PAUSED — no mode selected yet, nothing tracking
async function tickOnce() { if (running) { try { await loop.stepAsync(); } catch (e) { console.error(e); } } }
setInterval(tickOnce, TICK_MS);

// --- API ---
app.get("/api/state", (_req, res) => res.json({ ...loop.state(), running }));

app.post("/api/walk", (req, res) => {
  const { az, range } = req.body; // UI sends polar (from click on radar)
  const { x, y } = fromPolar(az, range);
  loop.crowd.setWalkTarget(x, y);
  running = true;   // clicking a target starts tracking
  res.json({ ok: true, running });
});

app.post("/api/drag", (req, res) => {
  const { az, range } = req.body;
  const { x, y } = fromPolar(az, range);
  loop.crowd.setDrag(x, y);
  res.json({ ok: true });
});

app.post("/api/split", (req, res) => {
  const { az1, range1, az2, range2 } = req.body;
  const a = fromPolar(az1, range1), b = fromPolar(az2, range2);
  loop.crowd.split(a.x, a.y, b.x, b.y);
  res.json({ ok: true });
});

app.post("/api/auto", (_req, res) => { loop.crowd.setAuto(); running = true; res.json({ ok: true, running }); });
app.post("/api/idle", (_req, res) => { loop.crowd.setIdle(); res.json({ ok: true, running }); });
app.post("/api/chaos", (_req, res) => { loop.crowd.triggerChaos(); running = true; res.json({ ok: true, running }); });
app.post("/api/escalation/clear", (_req, res) => { loop.clearEscalation(); res.json({ ok: true }); });
// explicit run control: a mode turns the loop ON; turning the mode off STOPS it
app.post("/api/run", (_req, res) => { running = true; res.json({ running }); });
app.post("/api/stop", (_req, res) => { running = false; res.json({ running }); });

// --- static frontend (built by vite into frontend/dist) ---
const dist = path.join(__dirname, "..", "frontend", "dist");
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`crowd-rapp on :${PORT}  tick=${TICK_MS}ms  provider=${process.env.MODEL_PROVIDER||"none"}`));
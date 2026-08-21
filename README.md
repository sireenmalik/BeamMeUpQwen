# Crowd-Following Beam — LLM rApp demo

A working demo of the gNB / SMO / rApp control loop where an LLM rApp points a fan of
uplink beams at a moving crowd. Digital beam steering, 1–5 s cadence, three use cases.

## The idea
- **gNB** counts UEs per beam (KPM). The model never sees positions — counts only.
- **SMO** carries KPM in, validates, and emits A1/O1 out.
- **rApp = the model.** It forecasts where the crowd is heading and points the beam ahead.
  It outputs **parameters only** (fan_center, tilt, action); a deterministic formatter
  builds the SMO's JSON, so the model can't break the schema.

## Three use cases
1. **Follow** — click the radar; the crowd walks there and the beam leads it.
2. **Allocate** — click two points; the crowd splits and the beams share load.
3. **Detect chaos** — hit "Trigger burst"; the crowd disperses radially, the rApp reads
   the panic signature (centroid still, spread exploding), widens coverage automatically
   (reversible), and flags escalation for a human (irreversible).

## Honest framing
- Digital beam steering, **not** mechanical RET (which is minutes-scale).
- Chaos detection reads the **crowd's response**, not gunfire.
- Reversible actions run automatically; irreversible actions wait for a human.

## Model choice (pluggable)
Set in `.env`:
- `MODEL_PROVIDER=none` — deterministic forecaster, no key. Demo runs out of the box.
- `MODEL_PROVIDER=anthropic` + `MODEL_NAME` + `MODEL_API_KEY`.
- `MODEL_PROVIDER=openai` + `MODEL_ENDPOINT` + `MODEL_NAME` — for Nemotron Nano / Qwen
  behind any OpenAI-compatible server (vLLM, Ollama, hosted).

The task is tiny (short count series in, a few numbers out) so a small model is the right
choice. The reasoning core, prompt, and parameter contract are identical across providers.

## Deploy (fresh DigitalOcean droplet, Ubuntu 22.04/24.04)
```bash
git clone <your-repo> /opt/crowd-rapp
cd /opt/crowd-rapp
chmod +x deploy.sh && ./deploy.sh
# edit .env if you want a real model, then: pm2 restart crowd-rapp
# point nginx at :3000 — see nginx.conf
sudo cp nginx.conf /etc/nginx/sites-available/crowd-rapp
sudo ln -sf /etc/nginx/sites-available/crowd-rapp /etc/nginx/sites-enabled/crowd-rapp
sudo nginx -t && sudo systemctl reload nginx
```

## Local run
```bash
npm install
( cd frontend && npm install && npm run build )
node src/server.js         # http://localhost:3000
```

## Layout
```
src/
  geometry.js    beam math: tilt<->range, fan, count-per-beam, centroid+spread
  crowd.js       simulator: drag / walk / auto / split / radial-dispersal
  filter.js      caged Kalman — smoothing ONLY (no prediction; that's the model's job)
  model.js       pluggable rApp brain — parameters out; deterministic fallback
  formatter.js   deterministic tool: params -> A1/O1 JSON (+ validate/clamp gate)
  loop.js        one tick of gNB/SMO/rApp; builds the signaling log
  server.js      Express API + interval loop + static frontend
frontend/
  src/Radar.jsx  top-down SVG: tower, fan, crowd, interactions
  src/App.jsx    controls, live signaling log, escalation gate
deploy.sh · ecosystem.config.cjs · nginx.conf · .env.example
```

## Scope
All telemetry is synthetic. Architectures are public (O-RAN SMO/Non-RT RIC/rApp, KPM/R1/A1/O1).
Single-shot per decision today; the chaos escalation is the natural place to elevate to a
full agent later. No proprietary material.

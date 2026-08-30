# beammeup-edge

**Same rApp. Different backbone.**

The sister repo [`beammeup`](https://github.com/sireenmalik/beammeup) proves cloud LLM integration: a crowd-following uplink beam rApp driven by NVIDIA Nemotron via the NIM API. Same radar UI, same tick loop, same deterministic formatter, but the model call goes out over the network to a hosted frontier model.

This repo proves the opposite. Same UI, same tick loop, same formatter, but the LLM is **Qwen 2.5 0.5B with a custom LoRA adapter, trained in 30 minutes on a commodity laptop CPU**. Zero token cost. Zero network dependency. 35 MB deployment artifact. Runs on the same laptop it was trained on.

This is the **edge tier** of a tiered serving architecture. Frontier models handle novel cross-domain reasoning in the cloud. Small specialized adapters handle high-frequency deterministic tasks on-device. Beammeup is the cloud tier. Beammeup-edge is the edge tier.

## What is different from `beammeup`

| | beammeup | beammeup-edge |
|---|---|---|
| Model | Nemotron 3.5 Lightning | Qwen 2.5 0.5B + custom LoRA |
| Where it runs | NVIDIA cloud (NIM) | Localhost, laptop only |
| Cost per inference | Metered | Zero |
| Training | Foundation model as-is | LoRA fine-tuned locally, ~30 min CPU |
| Deployment artifact | Droplet + API key | 35 MB adapter file |
| Network dependency | Internet required | None. Runs offline. |

Only **five files** differ between the two repos:

- `serve.py` (new): FastAPI OpenAI-compatible endpoint wrapping Qwen + LoRA
- `beam-lora/` (new): trained LoRA adapter, safetensors + config
- `.env.example`: points at localhost, no key
- `requirements.txt` (new): Python deps for `serve.py`
- `README.md`: this file

Everything else (the entire Node/Express backend, the Vite/React radar UI, the deterministic formatter, the Kalman smoother, the policy engine) was byte-for-byte identical to `beammeup`. That was deliberate: a `diff` between the two repos was the story.

**Current status of that claim.** This repo has since moved ahead of `beammeup` on the
sensing layer: the gNodeB now measures `SS-RSRP per SSB` instead of synthetic per-beam
counts, and `geometry.js`, `loop.js`, `model.js`, `App.jsx` and `Radar.jsx` differ as a
result. The forecasting modes and the crowd-anomaly safety use case also live here first.
Porting the RSRP sensing back to `beammeup` restores the clean five-file diff; until then
the two repos differ in sensing as well as backbone.

## Architecture

Three layer separation, LLM proposes values, deterministic tool builds SMO wire messages, SMO applies. Non-determinism is fenced inside the tool boundary. SMO only ever receives clamped numeric setpoints.

```
SS-RSRP per SSB beam  +  cell UE count      (gNodeB -> SMO, O1, 3GPP TS 28.552)
      ↓
SMO exposes to the rApp                     (R1, Data Management & Exposure)
      ↓
Pre-loop harness (deterministic)
   ├─ UE floor: too few users -> hold last good position
   └─ RSRP-weighted centroid: where the RF demand actually sits
      ↓
LLM (Qwen 2.5 + LoRA adapter, running in serve.py on localhost:8000)
      ↓  values envelope (JSON)
      ↓  { fan_center, tilt, action, reason }
      ↓
Deterministic tool (formatter)
   ├─ parse and schema check
   ├─ clamp fan_center to -49..49, tilt to 3..45
   ├─ Kalman smoother (smoothing only, no decisions)
   ├─ forecasting mode applies the aim (reactive / lead / momentum)
   ├─ drop reason to audit log
   └─ build SMO wire JSON
      ↓
SMO -> gNodeB                               (O1, NETCONF/YANG, 3GPP TS 28.541)
      ↓
Radar UI (Vite/React/Tailwind)
```

**On the sensing.** Earlier versions fed the model per-beam UE counts. That is not a real
measurement: 3GPP defines no per-beam active-UE counter over O1. What a gNodeB actually
reports is `SS-RSRP distribution per SSB` (per beam) and an active/connected UE count
(per cell). The simulator now models RSRP properly, using 3GPP TR 38.901 UMi-LOS path
loss, a cos^2 antenna pattern, log-normal shadow fading, and TS 38.133 quantization.
The steering signal is the RSRP-weighted azimuth. The per-cell UE count is the load gate.

A per-beam UE membership figure is still derived and displayed, but it is labelled as
derived — it is not claimed as a standard counter.

## Install

Two runtimes on the laptop, one for the LLM (Python), one for the rApp (Node).

**Prereqs**: Python 3.11+, Node 18+, ~3 GB free disk.

**Python side**:
```bash
python -m venv .venv
.venv\Scripts\activate                     # Windows PowerShell
# source .venv/bin/activate                 # macOS / Linux

pip install --upgrade pip
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
```

**Node side**:
```bash
cp .env.example .env                       # already points at localhost, no edits needed
npm install
```

## Run

Two terminals.

**Terminal 1 (LLM)**:
```bash
.venv\Scripts\activate
uvicorn serve:app --host 127.0.0.1 --port 8000
```

Wait ~10 seconds for `READY`. First run downloads Qwen 2.5 base (~1 GB) into the HuggingFace cache. Subsequent runs load from cache instantly.

**Verify the endpoint before starting the rApp** (optional but recommended, in a third terminal):
```bash
.venv\Scripts\activate
python test_endpoint.py
```

**Terminal 2 (rApp)**:
```bash
npm start
```

Open the browser: [http://localhost:3000](http://localhost:3000)

### Running without the model

The rApp runs standalone with a deterministic forecaster, no Python side needed:

```bash
MODEL_PROVIDER=none npm start
```

This exercises the full loop — RSRP sensing, the RSRP-weighted centroid, the forecasting
modes, the crowd-anomaly detector, the signaling log and the radar — with the model call
replaced by arithmetic. Useful for verifying a change to the loop in isolation before
bringing the adapter into it.

Note on naming: `MODEL_PROVIDER=openai` means *an OpenAI-compatible endpoint*, which is
what `serve.py` exposes on localhost. It does not mean the OpenAI API. Nothing leaves the
laptop on that setting.

Drag the crowd. Watch the beam follow. Watch the signaling log show `rApp_proposal` per tick with the reason field filled by your locally trained adapter.

## Training the adapter (how `beam-lora/` was made)

The adapter in `beam-lora/` was trained by `train_beam_lora_cpu.py` (also in this repo). To retrain from scratch or on your own trace data:

```bash
.venv\Scripts\activate
python train_beam_lora_cpu.py
```

Takes ~30 minutes on a dual core CPU. Drops synthetic ticks in place if `traces/` is empty, or reads real tick JSONs from `traces/*.json`. Writes the trained adapter back into `beam-lora/`.

## What this demonstrates

For the audiences it is aimed at:

- **Technical**: full pipeline from base model download, chat template construction, LoRA fine-tuning, adapter save, OpenAI-compatible serving, and integration into a real rApp control loop. All Apache 2.0 or MIT licensed, all reproducible on any laptop.
- **Product**: shows the shape of an on-device adapter library for network domain tasks. Same base model in RAM, one lightweight adapter per skill, swap in milliseconds.
- **Executive**: sovereign, on-prem, zero token cost, 35 MB shippable artifact. The unit economics that make agentic network operations a product line rather than a research project.

## What this does not yet demonstrate

Honest gaps between this proof and a production rApp:

- **Accuracy at scale**: 30 synthetic ticks proved the pipeline. Real crowd behavior across sectors, weather, and events not yet validated.
- **Adapter is trained on the old input format**: `beam-lora/` was fine-tuned on per-beam
  *counts*. The loop now feeds the model per-beam *RSRP*. Until the adapter is retrained on
  RSRP examples, it is being asked to read an input distribution it has never seen. This does
  not crash anything — `parseParams` falls back to the deterministic path on a bad generation —
  but steering quality from the adapter should be treated as unvalidated until the retrain.
- **Robustness to novel inputs**: adapter learned the synthetic pattern. Radial dispersal, sensor dropouts, and adversarial patterns will look novel until the training set covers them.
- **End to end safety wiring**: policy engine exists in the formatter. Signed audit log and dry-run gating still to add.
- **TMF Level 4 certification**: this is enabling infrastructure, not the audited product. Alignment with TMF IG1253 and IG1326 still to do.

## Related

- [`beammeup`](https://github.com/sireenmalik/beammeup): the cloud version, uses NVIDIA Nemotron via NIM.
- Both are portfolio pieces for the Nokia and NVIDIA agentic autonomous networks platform work.
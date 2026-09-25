// mcp-server.js — exposes the LIVE control loop as MCP tools over Streamable HTTP.
//
// This is a real MCP endpoint at POST /mcp, not a function call dressed up as one.
// Any MCP host can drive the rApp through it.
//
// THE IMPORTANT DESIGN POINT:
// `evaluate_move` is read-only. `commit_beam` does NOT exist as a tool. The orchestrator
// cannot bypass the neighbour gate because it has no path to the commit — the beam loop
// owns that, and the gate runs inside it every tick. Nemotron moves the POLICY dials;
// the gate still decides what actually commits. Propose, gate, commit stays intact.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import { isGateEnabled, getCeiling } from "./neighbours.js";

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

// Build a fresh McpServer per request (stateless mode). Cheap, and it avoids any
// session bookkeeping we do not need for a single-tenant demo.
function buildServer(ctx) {
  const { loop, getRunning, setRunning } = ctx;

  const server = new McpServer(
    { name: "crowdtrack", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // ---------------------------------------------------------------- read-only

  server.registerTool(
    "get_network_state",
    {
      title: "Get network state",
      description:
        "Current radio and beam state: SS-RSRP per SSB beam, beam azimuths, cell UE count, " +
        "current fan_center and tilt, neighbour noise rise per site, and the active policy " +
        "(ceiling in dB, gate on/off). Call this before reasoning about any change.",
      inputSchema: {}
    },
    async () => {
      const s = loop.state();
      const log = s.log || {};
      const up = log.gNB_to_NearRT_E2 || log.gNB_to_SMO_O1 || {};
      const r1 = log.SMO_to_rApp_R1 || {};
      const nb = s.neighbours || s.decision?.neighbours || null;

      return ok({
        tick: s.tick,
        running: getRunning(),
        radio: {
          ssb_rsrp_dBm: up["SS.RSRP_perSSB_dBm"] ?? null,
          beam_azimuths_deg: up.beam_azimuths ?? s.beamAzimuths ?? null,
          cell_ue_total: up["RRC.ConnMean"] ?? r1.cell_ue_total ?? null,
          rsrp_weighted_az_deg: r1.rsrp_weighted_az ?? null
        },
        beam: {
          fan_center_deg: s.fanCenter,
          tilt_deg: s.tilt,
          last_source: s.decision?.source ?? null
        },
        policy: {
          ceiling_db: getCeiling(),
          gate_enabled: isGateEnabled(),
          crowd_mode: s.mode ?? null,
          forecast_mode: s.forecastMode ?? null
        },
        neighbours: nb,
        handover: s.handover ?? null
      });
    }
  );

  server.registerTool(
    "evaluate_move",
    {
      title: "Evaluate a beam move (read-only)",
      description:
        "What-if only. Runs the deterministic neighbour gate against a proposed fan_center " +
        "and tilt and reports the resulting noise rise per neighbour sector, and whether it " +
        "would be allowed under the current ceiling. This NEVER changes the beam.",
      inputSchema: {
        fan_center_deg: z.number().min(-49).max(49).describe("Proposed beam azimuth in degrees"),
        tilt_deg: z.number().min(3).max(45).describe("Proposed beam tilt in degrees")
      }
    },
    async ({ fan_center_deg, tilt_deg }) => {
      if (typeof loop.evaluateMove !== "function") {
        return ok({
          error: "evaluate_move not wired",
          hint: "loop.evaluateMove(fan, tilt) is not implemented; see note in mcp-server.js"
        });
      }
      const r = loop.evaluateMove(fan_center_deg, tilt_deg);
      return ok({ proposed: { fan_center_deg, tilt_deg }, result: r, read_only: true });
    }
  );

  // ------------------------------------------------------------------- policy

  server.registerTool(
    "set_ceiling",
    {
      title: "Set neighbour interference ceiling",
      description:
        "Set the maximum noise rise, in dB, this cell may cause at the worst sector of any " +
        "neighbour site. Lower protects neighbours and shortens how far the beam will reach. " +
        "Higher serves our own crowd further out at a neighbour's cost. Useful range 2 to 5; " +
        "above about 5 the beam cannot reach the ceiling anyway.",
      inputSchema: { db: z.number().min(0.5).max(12).describe("Ceiling in dB") }
    },
    async ({ db }) => ok({ ceiling_db: loop.setCeiling(db) })
  );

  server.registerTool(
    "set_gate",
    {
      title: "Enable or disable the neighbour gate",
      description:
        "When enabled, proposed beam moves are trimmed or blocked to respect the ceiling. " +
        "When disabled, neighbour harm is still computed and reported but every move commits " +
        "(observe mode). Disabling does not stop A3 handover.",
      inputSchema: { on: z.boolean().describe("true to enforce the gate") }
    },
    async ({ on }) => ok({ gate_enabled: loop.setGate(on) })
  );

  server.registerTool(
    "set_crowd_mode",
    {
      title: "Set the crowd scenario",
      description:
        "auto = crowd drifts on its own. idle = crowd holds position, used with a walk target. " +
        "chaos = triggers radial dispersal for the anomaly detector.",
      inputSchema: { mode: z.enum(["auto", "idle", "chaos"]) }
    },
    async ({ mode }) => {
      if (mode === "auto") loop.crowd.setAuto();
      else if (mode === "idle") loop.crowd.setIdle();
      else loop.crowd.triggerChaos();
      if (mode !== "idle") setRunning(true);
      return ok({ crowd_mode: mode, running: getRunning() });
    }
  );

  server.registerTool(
    "set_anomaly_detection",
    {
      title: "Arm or disarm the dispersal detector",
      description:
        "Arms the read-only chaos detector, which flags radial dispersal from the RSRP " +
        "profile width. Detection only; it never touches the beam.",
      inputSchema: { on: z.boolean() }
    },
    async ({ on }) => ok({ anomaly_armed: loop.setAnomalyArmed(on) })
  );

  server.registerTool(
    "run_loop",
    {
      title: "Start or stop the control loop",
      description: "Start or stop beam loop ticking. Stopping freezes the beam where it is.",
      inputSchema: { on: z.boolean() }
    },
    async ({ on }) => {
      setRunning(on);
      return ok({ running: getRunning() });
    }
  );

  return server;
}

// Express router mounting the MCP endpoint at POST /mcp (stateless).
export function createMcpRouter(ctx) {
  const router = express.Router();

  router.post("/", async (req, res) => {
    let server, transport;
    try {
      server = buildServer(ctx);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        try { transport.close(); server.close(); } catch { /* already gone */ }
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("MCP-ERROR:", e?.message || e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  // GET and DELETE are not used in stateless mode; answer politely rather than 404.
  const notAllowed = (_req, res) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless server, POST only)" },
      id: null
    });
  router.get("/", notAllowed);
  router.delete("/", notAllowed);

  return router;
}

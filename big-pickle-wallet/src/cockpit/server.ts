/**
 * Big Pickle simulation cockpit server.
 *
 * SIMULATION / PAPER TRADING ONLY. This process serves a local dashboard and a
 * local simulation API. It has no endpoint that can place, route or submit an
 * order to anything: there is no live trade endpoint, no CDP credential, no
 * signer and no RPC client anywhere in this module or in the cockpit modules it
 * loads. "Fills" are bookkeeping entries written under state/cockpit/.
 *
 * Transport: node:http only — no framework, no new dependency.
 * Binding: 127.0.0.1 exclusively. The cockpit is never exposed to the LAN.
 *
 *   npm run cockpit      →  http://127.0.0.1:8787
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cockpit, type CockpitOptions } from "./cockpit.js";
import type { SimAccountKind } from "./account.js";

export const COCKPIT_HOST = "127.0.0.1";
export const COCKPIT_PORT = 8787;

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Simulation": "paper-trading",
    "X-Live-Trading": "disabled",
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, text: string, type: string): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Simulation": "paper-trading",
    "X-Live-Trading": "disabled",
  });
  res.end(text);
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new Error("body must be a JSON object"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        reject(err instanceof Error ? err : new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function accountKind(value: unknown): SimAccountKind | "all" | null {
  if (value === "sovereign" || value === "constitution" || value === "all") return value;
  return null;
}

type ControlAction = "kill" | "release" | "freeze" | "resume";
const CONTROL_ACTIONS: readonly string[] = ["kill", "release", "freeze", "resume"];

/** Route one request. Exported so tests can exercise the API without a socket. */
export async function handleRequest(
  cockpit: Cockpit,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${COCKPIT_HOST}`);
  const path = url.pathname;

  if (!isLoopback(req)) {
    sendJson(res, 403, { error: "cockpit accepts loopback connections only", simulation: true });
    return;
  }

  if (req.method === "GET") {
    if (path === "/api/state") {
      sendJson(res, 200, cockpit.state());
      return;
    }
    if (path === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        simulation: true,
        paper: true,
        liveFunds: false,
        liveTradeEndpoint: false,
        host: COCKPIT_HOST,
        tick: cockpit.market.tick,
      });
      return;
    }
    const asset = STATIC_FILES[path];
    if (asset) {
      const filePath = `${PUBLIC_DIR}${asset.file}`;
      if (existsSync(filePath)) {
        sendText(res, 200, readFileSync(filePath, "utf8"), asset.type);
        return;
      }
      sendJson(res, 404, { error: "static asset missing from this build" });
      return;
    }
    sendJson(res, 404, { error: `no route for ${path}`, simulation: true });
    return;
  }

  if (req.method === "POST") {
    if (path === "/api/sim/step") {
      const tick = cockpit.step();
      sendJson(res, 200, { ok: true, simulation: true, tick, note: "local simulation step" });
      return;
    }
    if (path === "/api/sim/reset") {
      const body = await readBody(req);
      const target = accountKind(body["account"]) ?? "all";
      if (target === "all") cockpit.reset();
      else cockpit.account(target).reset();
      sendJson(res, 200, {
        ok: true,
        simulation: true,
        tick: cockpit.market.tick,
        reset: target,
        note: "simulation book reset; no live state involved",
      });
      return;
    }
    if (path === "/api/sim/sovereign/force-resume") {
      const body = await readBody(req);
      // The route is loopback-only and the confirmation string makes this an
      // explicit manual owner action rather than an accidental generic control
      // request. The account method fixes the audit actor to `owner`.
      if (body["confirmation"] !== "OWNER_FORCE_RESUME") {
        sendJson(res, 400, {
          error: "explicit OWNER_FORCE_RESUME confirmation required",
          simulation: true,
        });
        return;
      }
      const reason =
        typeof body["reason"] === "string" && body["reason"].trim().length > 0
          ? body["reason"].trim().slice(0, 200)
          : "manual OWNER_FORCE_RESUME from local cockpit";
      try {
        cockpit.sovereign.forceOwnerResume(reason);
      } catch (error: unknown) {
        sendJson(res, 409, {
          error: error instanceof Error ? error.message : String(error),
          simulation: true,
          account: "sovereign",
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        simulation: true,
        account: "sovereign",
        action: "OWNER_FORCE_RESUME",
        note: "SOVEREIGN cooldown cleared; owner override is active for paper simulation only",
      });
      return;
    }
    if (path === "/api/sim/control") {
      const body = await readBody(req);
      const target = accountKind(body["account"]);
      const action = body["action"];
      if (!target || typeof action !== "string" || !CONTROL_ACTIONS.includes(action)) {
        sendJson(res, 400, {
          error: "expected {account: sovereign|constitution|all, action: kill|release|freeze|resume}",
        });
        return;
      }
      const reason =
        typeof body["reason"] === "string" && body["reason"].trim().length > 0
          ? body["reason"].trim().slice(0, 200)
          : "manual cockpit control (simulation only)";
      const kinds: SimAccountKind[] =
        target === "all" ? ["sovereign", "constitution"] : [target];
      for (const kind of kinds) {
        cockpit.account(kind).controlAction(action as ControlAction, reason);
      }
      sendJson(res, 200, {
        ok: true,
        simulation: true,
        applied: action,
        accounts: kinds,
        note: "local control-plane file state only; no live trading affected",
      });
      return;
    }
    sendJson(res, 404, {
      error: `no route for ${path}`,
      note: "this API exposes no live-trade endpoint by design",
      simulation: true,
    });
    return;
  }

  sendJson(res, 405, { error: `${req.method ?? "unknown"} not allowed` });
}

export interface CockpitServerOptions extends CockpitOptions {
  port?: number;
}

export interface RunningCockpit {
  cockpit: Cockpit;
  server: Server;
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Build the cockpit and serve it on 127.0.0.1. */
export function startCockpit(options: CockpitServerOptions = {}): Promise<RunningCockpit> {
  const { port = COCKPIT_PORT, ...cockpitOptions } = options;
  const cockpit = new Cockpit(cockpitOptions);

  const server = createServer((req, res) => {
    handleRequest(cockpit, req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendJson(res, 500, { error: message, simulation: true });
      else res.end();
    });
  });

  return new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(port, COCKPIT_HOST, () => {
      server.removeListener("error", rejectStart);
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      cockpit.start();
      resolveStart({
        cockpit,
        server,
        port: boundPort,
        url: `http://${COCKPIT_HOST}:${boundPort}/`,
        close: () =>
          new Promise<void>((done) => {
            cockpit.stop();
            server.close(() => done());
          }),
      });
    });
  });
}

function parsePort(argv: string[]): number {
  const index = argv.indexOf("--port");
  if (index >= 0 && argv[index + 1]) {
    const value = Number(argv[index + 1]);
    if (Number.isInteger(value) && value > 0 && value < 65_536) return value;
  }
  const env = Number(process.env["COCKPIT_PORT"] ?? "");
  if (Number.isInteger(env) && env > 0 && env < 65_536) return env;
  return COCKPIT_PORT;
}

async function main(): Promise<void> {
  const running = await startCockpit({ port: parsePort(process.argv.slice(2)) });
  const roots = running.cockpit.roots;
  console.log("==============================================================");
  console.log("  BIG PICKLE SIMULATION COCKPIT — PAPER TRADING ONLY");
  console.log("  no live funds · no exchange · no chain · no CDP credentials");
  console.log("==============================================================");
  console.log(`  Dashboard : ${running.url}`);
  console.log(`  State API : ${running.url}api/state`);
  console.log(`  Bind      : ${COCKPIT_HOST}:${running.port} (loopback only)`);
  console.log(`  Roots     : ${roots.sovereign}`);
  console.log(`              ${roots.constitution}`);
  console.log("  Loop      : deterministic synthetic market, no live price feed");
  console.log("==============================================================");

  const shutdown = (): void => {
    console.log("\nCockpit stopped (simulation only; nothing live was affected).");
    void running.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`cockpit failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

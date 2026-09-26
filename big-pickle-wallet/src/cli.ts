import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "./audit/audit-log.js";
import { ControlPlane, defaultControlPaths } from "./control/control-plane.js";
import { loadPolicy } from "./policy/schema.js";

interface CliOptions {
  root: string;
  policyPath: string;
  portfolioMicros: bigint;
}

function usage(): string {
  return [
    "Usage: bpw <status|policy|freeze|unfreeze|kill|audit|smoke> [options]",
    "",
    "Options:",
    "  --root <path>                Runtime state root (default: ./state)",
    "  --policy <path>              Policy JSON path",
    "  --portfolio-micros <value>   Current portfolio value for status",
    "",
    "Control commands require a reason argument. No trading commands are exposed.",
  ].join("\n");
}

function parseArgs(args: string[]): { command: string | undefined; options: CliOptions; reason: string } {
  const command = args[0];
  const positionals: string[] = [];
  let root = process.env["BPW_RUNTIME_ROOT"] ?? resolve(process.cwd(), "state");
  let policyPath = process.env["BPW_POLICY"] ?? resolve(process.cwd(), "config/policy.aggressive.json");
  let portfolioMicros = 0n;

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--root" || arg === "--policy" || arg === "--portfolio-micros") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--root") root = resolve(value);
      if (arg === "--policy") policyPath = resolve(value);
      if (arg === "--portfolio-micros") {
        if (!/^\d+$/.test(value)) throw new Error("--portfolio-micros must be a non-negative integer");
        portfolioMicros = BigInt(value);
      }
      continue;
    }
    if (arg === "--help" || arg === "-h") continue;
    positionals.push(arg);
  }

  return {
    command,
    options: { root, policyPath, portfolioMicros },
    reason: positionals.join(" ") || "manual operator action",
  };
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

function load(options: CliOptions) {
  const policy = loadPolicy(options.policyPath);
  const control = new ControlPlane(policy, defaultControlPaths(options.root));
  const audit = new AuditLog(resolve(options.root, "audit"));
  return { policy, control, audit };
}

export async function runCli(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const { command, options, reason } = parsed;

  if (!command || command === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return command === "help" || args.includes("--help") || args.includes("-h") ? 0 : 1;
  }

  if (command === "policy") {
    const policy = loadPolicy(options.policyPath);
    console.log(json(policy));
    return 0;
  }

  if (command === "smoke") {
    const { runSmokeTest } = await import("../scripts/smoke-test.js");
    await runSmokeTest();
    return 0;
  }

  const { control, audit } = load(options);
  switch (command) {
    case "status":
      console.log(json(control.snapshot(options.portfolioMicros)));
      return 0;
    case "freeze":
      console.log(json(control.trip("manual operator freeze", reason)));
      return 0;
    case "unfreeze":
      console.log(json(control.resume("owner", reason)));
      return 0;
    case "kill":
      console.log(json(control.engageKillSwitch("owner", reason)));
      return 0;
    case "audit": {
      const verification = audit.verifyAll();
      console.log(json({ verification, tail: audit.tail(20) }));
      return verification.ok ? 0 : 1;
    }
    default:
      throw new Error(`unknown command ${JSON.stringify(command)}\n\n${usage()}`);
  }
}

export async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}

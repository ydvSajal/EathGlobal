/** Env parsed once at boot with zod; fails fast on missing or invalid values (TRD §5). */
import { z } from "zod";

const mode = z.enum(["fake", "real"]);
const num = (def: number) => z.coerce.number().int().positive().default(def);

const Schema = z.object({
  ADAPTERS: mode.default("fake"),
  // per-port overrides; default to ADAPTERS
  FACILITATOR: mode.optional(),
  DECIDER: mode.optional(),
  EPISODES: mode.optional(),
  AUDIT: mode.optional(),
  STEPUP: mode.optional(),

  PORT: num(8787),
  DATABASE_URL: z.string().default("file:./dev.db"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  RECEIPT_SIGNING_KEY_ED25519: z.string().optional(),
  STEP_UP_THRESHOLD_HBAR: num(2),
  ACK_TIMEOUT_MS: num(8000),
  ZG_TIMEOUT_MS: num(4000),

  PUBLIC_BASE_URL: z.string().url().optional(),
  HEDERA_NETWORK: z.enum(["testnet","mainnet"]).default("testnet"),
  HEDERA_OPERATOR_ID: z.string().optional(),
  HEDERA_OPERATOR_KEY: z.string().optional(),
  HEDERA_PAYTO_ACCOUNT_ID: z.string().optional(),
  HEDERA_HCS_TOPIC_ID: z.string().optional(),
  X402_FACILITATOR_URL: z.string().url().optional(),
  ZG_COMPUTE_BASE_URL: z.string().url().optional(),
  ZG_COMPUTE_API_KEY: z.string().optional(),
  ZG_MODEL: z.string().optional(),
  ZG_STORAGE_RPC: z.string().optional(),
  ZG_STORAGE_INDEXER: z.string().optional(),
  ZG_PRIVATE_KEY: z.string().optional(),
  WORLD_OIDC_ISSUER: z.string().optional(),
  WORLD_CLIENT_ID: z.string().optional(),
  WORLD_CLIENT_SECRET: z.string().optional(),
  WORLD_REDIRECT_URI: z.string().optional(),
});

/** Env vars a real adapter needs before the gateway may boot with it. */
const REQUIRED_FOR_REAL = {
  facilitator: ["X402_FACILITATOR_URL", "HEDERA_PAYTO_ACCOUNT_ID"],
  decider: ["ZG_COMPUTE_BASE_URL", "ZG_COMPUTE_API_KEY", "ZG_MODEL"],
  episodes: ["ZG_STORAGE_RPC", "ZG_STORAGE_INDEXER", "ZG_PRIVATE_KEY"],
  audit: ["HEDERA_OPERATOR_ID", "HEDERA_OPERATOR_KEY", "HEDERA_HCS_TOPIC_ID"],
  stepup: ["WORLD_OIDC_ISSUER", "WORLD_CLIENT_ID", "WORLD_CLIENT_SECRET", "WORLD_REDIRECT_URI"],
} as const;

export type PortName = keyof typeof REQUIRED_FOR_REAL;
export type AdapterModes = Record<PortName, "fake" | "real">;

export interface Config {
  env: z.infer<typeof Schema>;
  adapters: AdapterModes;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = Schema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`invalid environment: ${msg}`);
  }
  const env = parsed.data;
  const adapters: AdapterModes = {
    facilitator: env.FACILITATOR ?? env.ADAPTERS,
    decider: env.DECIDER ?? env.ADAPTERS,
    episodes: env.EPISODES ?? env.ADAPTERS,
    audit: env.AUDIT ?? env.ADAPTERS,
    stepup: env.STEPUP ?? env.ADAPTERS,
  };

  const missing: string[] = [];
  for (const port of Object.keys(REQUIRED_FOR_REAL) as PortName[]) {
    if (adapters[port] !== "real") continue;
    for (const key of REQUIRED_FOR_REAL[port]) {
      if (!(env as Record<string, unknown>)[key]) missing.push(`${key} (needed by real ${port})`);
    }
  }
  if (missing.length) throw new ConfigError(`missing environment: ${missing.join(", ")}`);
  return { env, adapters };
}

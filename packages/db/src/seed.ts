/**
 * Demo seed: one device, one agent allowed to rent it. Idempotent (upsert).
 * Device token and HMAC secret come from env so they match the firmware/sim device secrets.h;
 * dev defaults are printed so the sim device can use them.
 */
import { createDb, sha256 } from "./repos";

const db = createDb();

const DEVICE_ID = process.env.SEED_DEVICE_ID ?? "d1";
const DEVICE_TOKEN = process.env.SEED_DEVICE_TOKEN ?? "dev-token-d1";
const DEVICE_HMAC = process.env.SEED_DEVICE_HMAC_SECRET ?? "dev-hmac-d1";
const PAYTO = process.env.HEDERA_PAYTO_ACCOUNT_ID ?? "0.0.0";
const AGENT_ACCOUNT = process.env.AGENT_HEDERA_ACCOUNT_ID ?? "0.0.1001";

async function main() {
  await db.device.upsert({
    where: { id: DEVICE_ID },
    update: { tokenHash: sha256(DEVICE_TOKEN), hmacSecret: DEVICE_HMAC, payTo: PAYTO },
    create: {
      id: DEVICE_ID,
      name: "Demo charger",
      pricePerMinute: "10000000", // 0.1 HBAR per minute (tinybar)
      asset: "HBAR",
      payTo: PAYTO,
      tokenHash: sha256(DEVICE_TOKEN),
      hmacSecret: DEVICE_HMAC,
    },
  });
  await db.agent.upsert({
    where: { id: "a1" },
    update: { hederaAccountId: AGENT_ACCOUNT, allowedDeviceIds: JSON.stringify([DEVICE_ID]) },
    create: {
      id: "a1",
      name: "Demo agent",
      hederaAccountId: AGENT_ACCOUNT,
      dailyCap: "1000000000", // 10 HBAR
      asset: "HBAR",
      allowedDeviceIds: JSON.stringify([DEVICE_ID]),
    },
  });
  console.log(`seeded device ${DEVICE_ID} (token from SEED_DEVICE_TOKEN or dev default) and agent a1 (${AGENT_ACCOUNT})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

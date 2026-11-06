/** Prints a fresh receipt-signing seed and its public key. Run: node packages/shared/scripts/gen-keys.ts */
import { generateSeedBase64, publicKeyFromSeedBase64 } from "../src/receipt.ts";

const seed = generateSeedBase64();
console.log(`RECEIPT_SIGNING_KEY_ED25519=${seed}   # server .env only, never commit`);
console.log(`PUBLIC_KEY_BASE64=${publicKeyFromSeedBase64(seed)}   # pin this in firmware config.h`);

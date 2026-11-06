# Resources

Checked 2026-11-06 unless noted. **(verify)** = not confirmed.

## Event and prizes
- ETHGlobal Mumbai prizes: https://ethglobal.com/events/mumbai/prizes (no deadline listed; reported Sun 8 Nov 09:00 IST, confirm on Discord)
- Hedera workshop "Hedera X Claude Code": Thu 5 Nov 2026, 3:30 PM IST, Workshop Room 2

## Base project
- Paybot: https://github.com/superposition/paybot (cloned to `reference/paybot`, git-ignored)
  - Use: `apps/x402-facilitator/src/example-resource-server.ts` (Hono layout, `x402Middleware`), `facilitator.ts` (`/verify` then `/settle`), `apps/web/src/components/gate/BotAccessGate.tsx`, `components/ui/CountdownTimer.tsx`, `hooks/usePayment.ts`, `packages/contracts/contracts/Escrow.sol` (state machine idea only)
  - Drop: QUSD, EIP-2612/712, wagmi, MetaMask flow, Docker/Hardhat

## Hedera and x402
- x402 monorepo: https://github.com/x402-foundation/x402 (Hedera mechanism at `typescript/packages/mechanisms/hedera`)
- Hedera exact scheme spec: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md
  - `cryptoTransfer` method; separate `/verify` and `/settle`; facilitator pays fees
- hbar402 (client pattern, `buy()`): https://github.com/OkeyAmy/hbar402
  - `createClientHederaSigner`, `ExactHederaScheme` (`@x402/hedera/exact/client`), `wrapFetchWithPaymentFromConfig` (`@x402/fetch`)
- remit (approval binding, no-Solidity Hedera): https://github.com/Lyons800/remit
- Hedera docs: https://docs.hedera.com/solutions/ai/x402 , facilitators: https://docs.hedera.com/solutions/ai/x402/facilitators
- Facilitators: `https://x402.org/facilitator` (check `/supported` lists `hedera:testnet`); Blocky402 `https://api.testnet.blocky402.com`
- Agent Kit (P1): https://github.com/hashgraph/hedera-agent-kit-js
- HCS: https://docs.hedera.com/reference/protobuf/consensus/consensus-service ; Mirror Node: https://docs.hedera.com/reference/rest-api
- Testnet account: https://portal.hedera.com ; USDC: Circle faucet (Hedera Testnet) ; explorer: HashScan

## 0G
- Private Computer / Router: https://pc.0g.ai , models https://pc.0g.ai/models ; Router base URL `https://router-api.0g.ai/v1`
- Compute docs: https://docs.0g.ai/developer-hub/building-on-0g/compute-network/overview
- Storage SDK: https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk (package name verify)
- zerobot (mock robot `startMockRobot`): https://github.com/0gfoundation/zerobot ; its README does not describe the decision loop or episode logging
- Faucet: https://faucet.0g.ai ; builder hub: https://build.0g.ai
- Open: where the request ID comes from on the Router path (verify)

## World ID
- Overview: https://auth.world.org/docs ; step-up: https://auth.world.org/docs/guides/step-up
- App registration: https://auth.world.org/docs/guides/app-registration ; portal: https://auth.world.org/portal
- OIDC: https://auth.world.org/docs/guides/oidc ; discovery: https://auth.world.org/.well-known/openid-configuration
- Playground: https://oauth-playground.toolsforhumanity.dev/

## Firmware
- Ed25519: https://github.com/rweather/arduinolibs (Ed25519 class presence unconfirmed; last noted change 2023)
- WebSocket client: https://github.com/Links2004/arduinoWebSockets ; JSON: ArduinoJson ; build: PlatformIO

## Not relevant to our tracks
Definitive Flash and Chainlink CRE resources shown in the prizes-page screenshots.

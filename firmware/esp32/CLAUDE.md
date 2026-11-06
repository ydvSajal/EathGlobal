# Lane D: firmware (`firmware/esp32`)

You own **only** `firmware/esp32/**`. C++ (Arduino framework, PlatformIO). The device is the **final authority** on actuation: it switches on only after verifying a receipt itself.

Read first: root `CLAUDE.md`, `docs/API.md` §2–3 (WS and receipt), `TRD.md` F7 F8 F12, `docs/STATE.md`. Contract artifact: `packages/shared/test-vectors/receipt.json` (lands with PR3).

## Starter prompt
> You are the **firmware** lane for AgentMeter. Read CLAUDE.md, firmware/esp32/CLAUDE.md, docs/API.md, TRD.md, docs/STATE.md. Do task <Fn> only, inside firmware/esp32. Commit often. Ask the owner about hardware.

## Stack
PlatformIO (`platformio.ini`, board `esp32dev` unless owner says otherwise), `links2004/arduinoWebSockets`, ArduinoJson, Ed25519 from `rweather/arduinolibs` (**verify** the class exists and exposes verify; last repo change noted 2023). Fallback: HMAC-SHA256 with a per-device secret; note the trade-off in `docs/DECISIONS.md`.

## Tasks
- [ ] **F1** PlatformIO project builds. Serial test mode: reads the test vector from a header generated from `receipt.json`, verifies it, prints PASS/FAIL for every positive and negative case (tampered, wrong device, expired, replay).
- [ ] **F2** Ed25519 verify against the pinned public key (compiled in `config.h` or flashed over serial). If the library fights you for more than ~1h, switch to HMAC and ADR it.
- [ ] **F3** Wi-Fi + NTP sync on boot; refuse receipts until synced; ±30s skew window.
- [ ] **F4** WebSocket client to `ws://<gateway>/devices/:id?token=...`: `hello`, `heartbeat` every 5s, auto-reconnect.
- [ ] **F5** On `receipt`: check signature, deviceId, window, nonce ring buffer (N≥32) → relay ON → start local timer for `expiresAt - now` → send `ack` (HMAC with device secret). Any failure sends `nack` with the reason and leaves the relay off.
- [ ] **F6** Local timer turns relay OFF at expiry with no network. On `cancel`, turn off immediately.
- [ ] **F7** Boot state is relay OFF. Watchdog/relay-safe on crash and on reconnect.
- [ ] **F8** Hardware check against the gateway's simulated-device script, then the real gateway (Gate G3).

## Safety and config
- Secrets in git-ignored `secrets.h` (Wi-Fi, device token, HMAC secret). Commit `secrets.example.h`.
- Use a low-voltage load through the relay for demos, never mains.
- Use the phone hotspot at the venue (client isolation). Device connects outbound only.

## Definition of done
Serial test passes all vector cases; relay flips on a valid receipt, rejects a replay, turns off by timer after unplugging the network; heartbeat visible on the gateway.

## Keys needed (ask the owner)
Board model, relay GPIO and logic level (active high/low), Wi-Fi SSID/password for the hotspot, device id and token, gateway host/IP.

# AgentMeter Flasher

Browser tool to flash the ESP32 and watch its serial output. No Arduino IDE or `esptool.py` needed.

```bash
pnpm install
pnpm --filter @agentmeter/flasher start      # http://localhost:5174
```

Open it in **Chrome or Edge** (Web Serial). Plug the ESP32 in over a USB **data** cable.

1. **Connect**: pick the board's serial port. If it fails, hold the `BOOT` button while clicking Connect.
2. **Firmware**: choose a layout and select the files.
   - *PlatformIO build*: `bootloader.bin`, `partitions.bin`, `boot_app0.bin`, `firmware.bin` (offsets update to your chip after connecting: `0x1000` for ESP32, `0x0` for S3/C3/C6/H2).
   - *Single merged image* at `0x0`, or *App only* at `0x10000`.
3. **Flash**. The board hard-resets when done.
4. **Serial monitor** (115200) shows firmware output, lets you reset the board and send a line. Close the monitor and reconnect to flash again.

PlatformIO output lives in `firmware/esp32/.pio/build/<env>/`. `boot_app0.bin` is under `~/.platformio/packages/framework-arduinoespressif32/tools/partitions/`.

Notes
- Everything runs locally; files never leave your machine. The server only serves three whitelisted paths on `127.0.0.1`.
- Uses `esptool-js` 0.7.0, served from `node_modules` (works offline at the venue).
- Flash mode, frequency and size are kept from the image header. MD5 verification is not enabled.
- Not tested on real hardware yet; the page logic and library loading are verified in Chrome.

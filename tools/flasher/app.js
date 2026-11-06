import { ESPLoader, Transport } from "/vendor/esptool.js";

const $ = (id) => document.getElementById(id);
const log = (s) => {
  const el = $("log");
  el.textContent += s;
  el.scrollTop = el.scrollHeight;
};
const line = (s) => log(s + "\n");

if (!("serial" in navigator)) $("unsupported").hidden = false;

let port = null;
let transport = null;
let loader = null;
let chipName = "";
let monitorReader = null;
let monitorWriter = null;
let monitoring = false;

// Bootloader offset differs per chip family (esptool docs).
const bootOffset = () => (/ESP32-(S3|C3|C6|H2|C5|P4)/i.test(chipName) ? 0x0 : 0x1000);
const hex = (n) => "0x" + n.toString(16);

const PRESETS = {
  pio: () => [
    ["bootloader.bin", bootOffset()],
    ["partitions.bin", 0x8000],
    ["boot_app0.bin", 0xe000],
    ["firmware.bin", 0x10000],
  ],
  merged: () => [["merged firmware.bin", 0x0]],
  app: () => [["firmware.bin", 0x10000]],
};

function renderImages() {
  const box = $("images");
  box.textContent = "";
  for (const [name, addr] of PRESETS[$("preset").value]()) {
    const row = document.createElement("div");
    row.className = "img";
    const label = Object.assign(document.createElement("span"), { textContent: name });
    const file = Object.assign(document.createElement("input"), { type: "file", accept: ".bin" });
    const at = Object.assign(document.createElement("input"), { type: "text", value: hex(addr) });
    file.addEventListener("change", updateFlashEnabled);
    row.append(label, file, at);
    box.append(row);
  }
  updateFlashEnabled();
}

const imageRows = () => [...$("images").querySelectorAll(".img")];
function updateFlashEnabled() {
  $("flash").disabled = !loader || imageRows().some((r) => !r.querySelector("input[type=file]").files?.length);
}

const term = {
  clean: () => ($("log").textContent = ""),
  writeLine: (s) => line(s),
  write: (s) => log(s),
};

async function connect() {
  try {
    port = await navigator.serial.requestPort();
    transport = new Transport(port, true);
    loader = new ESPLoader({ transport, baudrate: Number($("baud").value), terminal: term });
    $("chip").textContent = "Connecting…";
    chipName = await loader.main();
    const mac = await loader.chip.readMac(loader).catch(() => "?");
    const flash = (await loader.detectFlashSize().catch(() => undefined)) ?? "unknown";
    $("chip").innerHTML = `<span class="ok">Connected:</span> ${chipName}, MAC ${mac}, flash ${flash}`;
    $("connect").disabled = true;
    $("disconnect").disabled = false;
    $("monitor").disabled = false;
    renderImages();
  } catch (e) {
    $("chip").innerHTML = `<span class="bad">Connect failed:</span> ${e?.message ?? e}. Hold BOOT while connecting, try another cable/port, or close any other app using the port.`;
    await cleanup();
  }
}

async function cleanup() {
  await stopMonitor();
  try {
    await transport?.disconnect();
  } catch {}
  port = transport = loader = null;
  chipName = "";
  $("connect").disabled = false;
  $("disconnect").disabled = true;
  $("flash").disabled = true;
  $("monitor").disabled = true;
  $("reset").disabled = true;
}

async function flash() {
  const rows = imageRows();
  const fileArray = [];
  for (const r of rows) {
    const f = r.querySelector("input[type=file]").files[0];
    const addr = Number(r.querySelector("input[type=text]").value);
    if (!Number.isInteger(addr) || addr < 0) return alert(`Bad address: ${r.querySelector("input[type=text]").value}`);
    fileArray.push({ data: new Uint8Array(await f.arrayBuffer()), address: addr }); // esptool-js 0.7: Uint8Array
  }
  $("flash").disabled = true;
  $("bar").hidden = false;
  $("bar").value = 0;
  $("status").textContent = "Flashing…";
  try {
    await loader.writeFlash({
      fileArray,
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: $("erase").checked,
      compress: true,
      reportProgress: (i, written, total) => {
        $("bar").value = (written / total) * 100;
        $("status").textContent = `File ${i + 1}/${fileArray.length}: ${Math.round((written / total) * 100)}%`;
      },
    });
    await loader.after("hard_reset");
    $("status").innerHTML = `<span class="ok">Done.</span> Board reset. Open the serial monitor to see its output.`;
  } catch (e) {
    $("status").innerHTML = `<span class="bad">Flash failed:</span> ${e?.message ?? e}`;
  } finally {
    $("flash").disabled = false;
  }
}

async function openMonitor() {
  // Release esptool's hold on the port, then reopen it as a plain serial console.
  const p = port;
  try {
    await transport.disconnect();
  } catch {}
  loader = null;
  transport = null;
  await p.open({ baudRate: 115200 });
  monitoring = true;
  $("monitor").disabled = true;
  $("stopMonitor").disabled = false;
  $("reset").disabled = false;
  $("send").disabled = false;
  $("flash").disabled = true;
  $("chip").innerHTML += ` <span class="mut">(monitor open: reconnect to flash again)</span>`;
  monitorWriter = p.writable.getWriter();
  const dec = new TextDecoder();
  (async () => {
    while (monitoring && p.readable) {
      monitorReader = p.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await monitorReader.read();
          if (done) break;
          log(dec.decode(value));
        }
      } catch {
        /* port closed or unplugged */
      } finally {
        monitorReader.releaseLock();
        monitorReader = null;
      }
      if (!monitoring) break;
    }
  })();
}

async function stopMonitor() {
  if (!monitoring) return;
  monitoring = false;
  try {
    await monitorReader?.cancel();
  } catch {}
  try {
    monitorWriter?.releaseLock();
  } catch {}
  monitorWriter = null;
  try {
    await port?.close();
  } catch {}
  port = null;
  $("stopMonitor").disabled = true;
  $("send").disabled = true;
  $("reset").disabled = true;
  $("connect").disabled = false;
  $("disconnect").disabled = true;
  $("chip").textContent = "Monitor closed. Connect again to flash.";
}

async function resetBoard() {
  // Same DTR/RTS pulse the dev boards' auto-reset circuit uses.
  await port.setSignals({ dataTerminalReady: false, requestToSend: true });
  await new Promise((r) => setTimeout(r, 120));
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
}

$("preset").addEventListener("change", renderImages);
$("connect").addEventListener("click", connect);
$("disconnect").addEventListener("click", async () => {
  await cleanup();
  $("chip").textContent = "Disconnected.";
});
$("flash").addEventListener("click", flash);
$("monitor").addEventListener("click", openMonitor);
$("stopMonitor").addEventListener("click", stopMonitor);
$("reset").addEventListener("click", resetBoard);
$("send").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" || !monitorWriter) return;
  await monitorWriter.write(new TextEncoder().encode($("send").value + "\n"));
  $("send").value = "";
});
navigator.serial?.addEventListener("disconnect", () => {
  line("[USB device unplugged]");
  void cleanup();
});

renderImages();

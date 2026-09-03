// Wire-level probe harness: treats the compiled Go relay as the system under
// test and drives it over real WebSockets. No browser. This is the hard
// functional evidence layer — a scenario passing here proves the whole path
// client emit → server dispatch → relay → broadcast actually exists.
//
// Usage (from repo root; `npm install` in tools/probe once):
//   node tools/probe/harness.js --scenario tools/probe/scenarios/reactions.js
// Builds ./cmd/janjacast to a temp binary, boots it on :8102 with anon joins
// allowed, runs the scenario, prints a transcript, exits 0/1.

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");

const BASE = "http://127.0.0.1:8102";
const WS_URL = "ws://127.0.0.1:8102/ws";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const req = http.get(BASE + "/api/health", (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await sleep(150);
  }
  return false;
}

// 13-byte media header: kind u8, flags u8, temporalId u8, seq u16be, ts u64be.
function buildMediaChunk({ kind = 1, keyframe = false, temporalId = 0, seq = 0, timestampUs = 0n, payload = Buffer.alloc(16) }) {
  const buf = Buffer.alloc(13 + payload.length);
  buf.writeUInt8(kind, 0);
  buf.writeUInt8(keyframe ? 1 : 0, 1);
  buf.writeUInt8(temporalId, 2);
  buf.writeUInt16BE(seq & 0xffff, 3);
  buf.writeUInt32BE(Number((timestampUs >> 32n) & 0xffffffffn), 5);
  buf.writeUInt32BE(Number(timestampUs & 0xffffffffn), 9);
  payload.copy(buf, 13);
  return buf;
}

class Harness {
  constructor() {
    this.proc = null;
    this.bin = null;
    this.log = [];
  }

  note(event, extra = {}) {
    const row = { t: new Date().toISOString(), event, ...extra };
    this.log.push(row);
    console.log(row.t, event, JSON.stringify(extra));
  }

  async buildServer() {
    this.bin = path.join(os.tmpdir(), `janjacast-probe-${process.pid}${process.platform === "win32" ? ".exe" : ""}`);
    this.note("go_build", { out: this.bin });
    await new Promise((resolve, reject) => {
      const repoRoot = path.resolve(__dirname, "..", "..");
      const p = spawn("go", ["build", "-o", this.bin, "./cmd/janjacast"], { stdio: "inherit", cwd: repoRoot });
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("go build failed: " + code))));
    });
  }

  async startServer() {
    this.note("server_start");
    this.proc = spawn(this.bin, [], {
      env: {
        ...process.env,
        JANJACAST_ADDR: ":8102",
        JANJACAST_ALLOW_ANON: "1",
        // base64 of 32 zero bytes — a throwaway secret good enough for :8102
        JANJACAST_TOKEN_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (d) => this.note("server_out", { line: d.toString().trim().slice(0, 300) }));
    this.proc.stderr.on("data", (d) => this.note("server_err", { line: d.toString().trim().slice(0, 300) }));
    if (!(await waitForHealth())) throw new Error("/api/health never came up on :8102");
    this.note("server_healthy");
  }

  async stopServer() {
    if (!this.proc) return;
    this.note("server_stop");
    const p = this.proc;
    this.proc = null;
    p.kill();
    await new Promise((r) => { p.on("exit", r); setTimeout(r, 1500); });
  }

  /** Join n anonymous clients into `room`. Each handle has:
   *  sendCtrl(type, data), sendMedia(buf), onCtrl(type, timeout) -> msg,
   *  ctrl[] / bin[] receive logs, close(). Resolves after each `welcome`. */
  async spawnClients(n, room) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const id = `probe_${i}_${Math.random().toString(36).slice(2, 8)}`;
      const ws = new WebSocket(WS_URL);
      const ctrl = [];    // full receive transcript (never consumed)
      const pending = []; // unconsumed controls; onCtrl pops from here
      const bin = [];
      const waiters = [];

      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws open timeout")), 5000);
        ws.on("open", () => { clearTimeout(t); resolve(); });
        ws.on("error", reject);
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) { bin.push(Buffer.from(data)); return; }
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        ctrl.push(msg);
        let claimed = false;
        for (let j = 0; j < waiters.length; j++) {
          if (waiters[j].type === msg.type) { waiters.splice(j, 1)[0].resolve(msg); claimed = true; break; }
        }
        if (!claimed) pending.push(msg);
      });

      // Each control message is delivered to exactly ONE onCtrl call:
      // consuming from `pending` (or claiming the next live frame) means two
      // sequential onCtrl('x') calls always see two DIFFERENT messages.
      const onCtrl = (type, timeoutMs = 2500) => {
        const idx = pending.findIndex((m) => m.type === type);
        if (idx >= 0) return Promise.resolve(pending.splice(idx, 1)[0]);
        return new Promise((resolve, reject) => {
          const w = { type, resolve };
          waiters.push(w);
          setTimeout(() => {
            const idx = waiters.indexOf(w);
            if (idx >= 0) { waiters.splice(idx, 1); reject(new Error(`timeout waiting '${type}' on ${id}`)); }
          }, timeoutMs);
        });
      };
      /** Consume and discard every pending message of `type` (plus any that
       *  arrive within graceMs). Use before asserting on the NEXT broadcast
       *  of a type the client may have accumulated. */
      const drain = async (type, graceMs = 150) => {
        await new Promise((r) => setTimeout(r, graceMs));
        for (let j = pending.length - 1; j >= 0; j--) {
          if (pending[j].type === type) pending.splice(j, 1);
        }
      };
      const sendCtrl = (type, data) => ws.send(JSON.stringify({ type, data }));
      const sendMedia = (buf) => ws.send(buf);

      sendCtrl("join", { room, userId: id, username: id });
      await onCtrl("welcome");
      this.note("client_joined", { id, room });
      out.push({ id, ws, ctrl, bin, onCtrl, drain, sendCtrl, sendMedia, close: () => ws.close() });
    }
    return out;
  }

  async closeClients(clients) {
    for (const c of clients) { try { c.close(); } catch {} }
    await sleep(100);
  }

  transcript() { return JSON.stringify(this.log, null, 1); }
}

async function main() {
  const idx = process.argv.indexOf("--scenario");
  if (idx < 0 || !process.argv[idx + 1]) {
    console.error("usage: node tools/probe/harness.js --scenario <file.js>");
    process.exit(2);
  }
  const scenario = require(path.resolve(process.argv[idx + 1]));
  const h = new Harness();
  let ok = false;
  try {
    await h.buildServer();
    await h.startServer();
    ok = await scenario.run(h);
  } catch (e) {
    h.note("scenario_error", { err: String((e && e.stack) || e) });
  } finally {
    await h.stopServer();
  }
  console.log("--- TRANSCRIPT ---");
  console.log(h.transcript());
  console.log(ok ? "PROBE RESULT: PASS" : "PROBE RESULT: FAIL");
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = { Harness, buildMediaChunk };

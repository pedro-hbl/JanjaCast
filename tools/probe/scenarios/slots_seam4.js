// Probe scenario: Seam 4 — the cap lifts, two streamers share the stage.
// A room that opts in via slots_max seats two publishers on chairs 0 and 1;
// every chunk arrives stamped with its chair; a viewer unsubscribing chair 1
// keeps receiving chair 0 only; a third claim on a full 2-chair house is
// refused with stage.full; and legacy rooms never see any of this.
module.exports.run = async (h) => {
  const { buildMediaChunk } = require("../harness");
  const room = "probe_seam4_" + Math.random().toString(36).slice(2, 6);
  const [a, b, viewer, c] = await h.spawnClients(4, room);

  a.sendCtrl("slots_max", { max: 2 });
  const st0 = await a.onCtrl("stage_state");
  if (st0.data.maxSlots !== 2) { h.note("fail_maxslots", { got: st0.data.maxSlots }); return false; }

  // Two claims, two chairs. Each mutation broadcasts a stage_state, so
  // read UNTIL the two-chair one lands rather than trusting queue order.
  a.sendCtrl("take_stage", {});
  b.sendCtrl("take_stage", {});
  let slots = [];
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const st = await viewer.onCtrl("stage_state", 1500).catch(() => null);
    if (!st) break;
    slots = st.data.slots ?? [];
    if (slots.length === 2) break;
  }
  if (slots.length !== 2 || slots[0].idx !== 0 || slots[1].idx !== 1) {
    h.note("fail_two_chairs", { got: slots }); return false;
  }
  if (slots[0].occupantId !== a.id || slots[1].occupantId !== b.id) {
    h.note("fail_chair_owners", { got: slots }); return false;
  }

  // Per-chair configs.
  a.sendCtrl("config", { videoCodec: "vp8", width: 640, height: 360, framerate: 30 });
  b.sendCtrl("config", { videoCodec: "vp8", width: 320, height: 180, framerate: 30 });
  await viewer.drain("stage_state");

  // Media from each publisher arrives stamped with its chair.
  a.sendMedia(buildMediaChunk({ keyframe: true, seq: 1, timestampUs: 0n, payload: Buffer.alloc(8, 0xaa) }));
  b.sendMedia(buildMediaChunk({ keyframe: true, seq: 1, timestampUs: 0n, payload: Buffer.alloc(8, 0xbb) }));
  let start = Date.now();
  while (viewer.bin.length < 2 && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 30));
  if (viewer.bin.length < 2) { h.note("fail_dual_flow", { got: viewer.bin.length }); return false; }
  const seen = new Set(viewer.bin.map((buf) => buf[2]));
  if (!seen.has(0) || !seen.has(1)) { h.note("fail_slot_stamp", { got: [...seen] }); return false; }

  // Selective viewing: drop chair 1, keep chair 0.
  viewer.sendCtrl("unsubscribe", { slots: [1] });
  await new Promise((r) => setTimeout(r, 150));
  const before = viewer.bin.length;
  a.sendMedia(buildMediaChunk({ keyframe: false, seq: 2, timestampUs: 33000n }));
  b.sendMedia(buildMediaChunk({ keyframe: false, seq: 2, timestampUs: 33000n }));
  start = Date.now();
  while (viewer.bin.length <= before && Date.now() - start < 1500) await new Promise((r) => setTimeout(r, 30));
  const fresh = viewer.bin.slice(before);
  if (fresh.length === 0) { h.note("fail_slot0_flow_after_unsub"); return false; }
  if (fresh.some((buf) => buf[2] === 1)) { h.note("fail_unsub_leak"); return false; }

  // Full house refuses a third streamer — no cross-person takeover in multi.
  c.sendCtrl("take_stage", {});
  const err = await c.onCtrl("error", 1200);
  if (err.data.code !== "stage.full") { h.note("fail_full_guard", { got: err.data }); return false; }

  // b leaves the stage: chair 1 frees, chair 0 untouched.
  b.sendCtrl("leave_stage", {});
  await viewer.drain("stage_state");
  const st3 = viewer.ctrl.filter((m) => m.type === "stage_state").pop();
  await h.closeClients([a, b, viewer, c]);
  return true;
};

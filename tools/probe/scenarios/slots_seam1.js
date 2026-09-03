// Probe scenario: Seam 1 contract (multistream migration, S1c).
// The multi-slot view must ride ADDITIVELY beside the legacy fields, byte-
// compatible: welcome carries headerVersion:2 + maxSlots:1; while someone
// holds the stage, stage_state.slots is exactly one entry whose occupant
// mirrors publisherId/publisherName; a free stage has no slots entries; and
// media fan-out still flows keyframe-first from the (slot 0) GOP cache.
module.exports.run = async (h) => {
  // Lazy: the harness requires this file before its own exports exist.
  const { buildMediaChunk } = require("../harness");
  const room = "probe_seam1_" + Math.random().toString(36).slice(2, 6);
  const [pub] = await h.spawnClients(1, room);

  // Welcome asserts the wire era.
  const w = pub.ctrl.find((m) => m.type === "welcome");
  if (!w || w.data.headerVersion !== 2 || w.data.maxSlots !== 1) {
    h.note("fail_welcome_version", { got: w && w.data });
    return false;
  }
  if ((w.data.slots ?? []).length !== 0) {
    h.note("fail_free_stage_slots", { got: w.data.slots });
    return false;
  }

  // Occupied stage: slots[] mirrors the legacy singleton exactly.
  pub.sendCtrl("take_stage", {});
  const st = await pub.onCtrl("stage_state");
  const slots = st.data.slots ?? [];
  if (slots.length !== 1 || slots[0].idx !== 0) {
    h.note("fail_one_chair", { got: slots });
    return false;
  }
  if (
    slots[0].occupantId !== st.data.publisherId ||
    slots[0].occupantName !== st.data.publisherName
  ) {
    h.note("fail_mirror", { slot: slots[0], legacy: st.data });
    return false;
  }

  // Late joiner: keyframe-first from the slot-0 GOP cache, same as ever.
  pub.sendCtrl("config", { videoCodec: "vp8", width: 640, height: 360, framerate: 30 });
  pub.sendMedia(buildMediaChunk({ keyframe: true, seq: 1, timestampUs: 0n }));
  pub.sendMedia(buildMediaChunk({ keyframe: false, seq: 2, timestampUs: 33000n }));
  const [late] = await h.spawnClients(1, room);
  const start = Date.now();
  while (late.bin.length < 2 && Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (late.bin.length < 2) { h.note("fail_gop_replay", { got: late.bin.length }); return false; }
  if ((late.bin[0][1] & 1) !== 1) { h.note("fail_keyframe_first"); return false; }
  // A late joiner's welcome also carries the occupied chair.
  const lw = late.ctrl.find((m) => m.type === "welcome");
  if (!lw || (lw.data.slots ?? []).length !== 1) {
    h.note("fail_late_welcome_slots", { got: lw && lw.data.slots });
    return false;
  }

  await h.closeClients([pub, late]);
  return true;
};

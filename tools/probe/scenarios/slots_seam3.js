// Probe scenario: Seam 3 — per-slot subscriptions.
// Default is ALL chairs (legacy behavior untouched). Unsubscribing slot 0
// stops that chunk flow at the relay; re-subscribing replays the slot's GOP
// keyframe-first so the tile paints instantly.
module.exports.run = async (h) => {
  const { buildMediaChunk } = require("../harness");
  const room = "probe_seam3_" + Math.random().toString(36).slice(2, 6);
  const [pub, v] = await h.spawnClients(2, room);
  pub.sendCtrl("take_stage", {});
  await pub.onCtrl("stage_state");
  pub.sendCtrl("config", { videoCodec: "vp8", width: 640, height: 360, framerate: 30 });

  // Default-all: media flows.
  pub.sendMedia(buildMediaChunk({ keyframe: true, seq: 1, timestampUs: 0n }));
  let start = Date.now();
  while (v.bin.length < 1 && Date.now() - start < 1500) await new Promise((r) => setTimeout(r, 30));
  if (v.bin.length < 1) { h.note("fail_default_flow"); return false; }

  // Unsubscribe slot 0: the relay stops sending this viewer that chair.
  v.sendCtrl("unsubscribe", { slots: [0] });
  await new Promise((r) => setTimeout(r, 150));
  const before = v.bin.length;
  pub.sendMedia(buildMediaChunk({ keyframe: false, seq: 2, timestampUs: 33000n }));
  pub.sendMedia(buildMediaChunk({ keyframe: false, seq: 3, timestampUs: 66000n }));
  await new Promise((r) => setTimeout(r, 300));
  if (v.bin.length !== before) { h.note("fail_unsub_still_flowing", { got: v.bin.length - before }); return false; }

  // Resubscribe: GOP replay lands keyframe-first, then live resumes.
  v.sendCtrl("subscribe", { slots: [0] });
  start = Date.now();
  while (v.bin.length <= before && Date.now() - start < 1500) await new Promise((r) => setTimeout(r, 30));
  if (v.bin.length <= before) { h.note("fail_resub_no_replay"); return false; }
  if ((v.bin[before][1] & 1) !== 1) { h.note("fail_replay_not_keyframe_first"); return false; }
  const afterReplay = v.bin.length;
  pub.sendMedia(buildMediaChunk({ keyframe: false, seq: 4, timestampUs: 99000n }));
  start = Date.now();
  while (v.bin.length <= afterReplay && Date.now() - start < 1500) await new Promise((r) => setTimeout(r, 30));
  if (v.bin.length <= afterReplay) { h.note("fail_live_after_resub"); return false; }

  await h.closeClients([pub, v]);
  return true;
};

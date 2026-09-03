// Probe scenario for ISSUE-2-telinha: RED first.
// Goal: prove wire path for a publisher sending media and a second viewer-only
// socket receiving binary fan-out. We assert the binary payload count grows and
// that the first delivered chunk is a keyframe (from GOP cache), using the
// existing test harness helpers.

/* eslint-disable no-console */

module.exports.run = async function (h) {
  // Harness builds/starts server itself; use spawnClients per existing scenarios.
  const room = "room_" + Math.random().toString(36).slice(2, 8);
  const [pub, view] = await h.spawnClients(2, room);

  // Media only fans out from the actual publisher with a declared config.
  pub.sendCtrl("take_stage", {});
  await pub.onCtrl("stage_state");
  pub.sendCtrl("config", { videoCodec: "vp8", width: 640, height: 360, framerate: 30 });
  await view.drain("stage_state");

  // Use harness-collected binaries (view.bin)
  const received = view.bin;

  // Send a GOP: keyframe first then a few delta frames.
  const { buildMediaChunk } = require("../harness");
  const key = buildMediaChunk({ keyframe: true, seq: 1, timestampUs: 0n, payload: Buffer.alloc(32, 1) });
  await pub.sendMedia(key);
  for (let i = 1; i <= 5; i++) {
    const delta = buildMediaChunk({ keyframe: false, seq: 1 + i, timestampUs: BigInt(i * 33_000), payload: Buffer.alloc(16, 2) });
    await pub.sendMedia(delta);
  }

  // Wait briefly to allow fan-out.
  const start = Date.now();
  while (received.length < 3 && Date.now() - start < 1500) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (received.length < 3) { h.note('assert_fail_no_media', { have: received.length }); return false; }

  // Assertions: we are RED first — these helpers exist in other scenarios; if
  // the protocol mapping changes, adjust after RED. The first buffer should be
  // a keyframe (GOP cache + first live keyframe). We assume the first byte is a
  // flags bitmask where bit7 signals keyframe — align with harness conventions.
  const first = received[0];
  if (!first || first.length < 2) { h.note('assert_fail_first_missing', {}); return false; }
  // Harness media header: byte 1 is flags (1 == keyframe)
  if (first.readUInt8(1) !== 1) { h.note('assert_fail_not_keyframe', { flag: first.readUInt8(1) }); return false; }
  return true; // GREEN when wire path exists
};

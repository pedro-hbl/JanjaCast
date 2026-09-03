// Probe scenario: rodizio auto-pass — the clock hands the stage on by itself.
// Harness boots the server with JANJACAST_TURN_LEN_MS=1200, so a rodizio
// slot expires fast. Contract: in rodizio mode, when the publisher's slot
// runs out and someone is in line, the relay passes exactly the way a manual
// stage_pass would — warmup unicast, public stage_turn, stage freed.
module.exports.run = async (h) => {
  const room = "probe_rodauto_" + Math.random().toString(36).slice(2, 6);
  const [pub, v1, v2] = await h.spawnClients(3, room);

  pub.sendCtrl("stage_mode", { mode: "rodizio" });
  await pub.onCtrl("stage_queue");
  pub.sendCtrl("take_stage", {});
  await pub.onCtrl("stage_state");
  v1.sendCtrl("stage_request", {});
  await v2.onCtrl("stage_queue");

  // No pass, no extend: the slot (1.2s) expires on its own.
  const warm = await v1.onCtrl("stage_warmup", 4000);
  if (!warm.data || warm.data.userId !== v1.id) { h.note("assert_fail_warmup", { got: warm.data }); return false; }
  const turn = await v2.onCtrl("stage_turn", 2000);
  if (turn.data.userId !== v1.id) { h.note("assert_fail_turn", { got: turn.data }); return false; }

  // The stage actually freed: drop the stale takes first, then the next
  // state v2 hears is the publisher-less one from the auto-pass.
  await v2.drain("stage_state");
  const st = await v2.onCtrl("stage_state", 2000).catch(() => null);
  if (st && st.data && st.data.publisherId) { h.note("assert_fail_not_freed", { got: st.data }); return false; }

  await h.closeClients([pub, v1, v2]);
  return true;
};

// Probe scenario for ISSUE-2-jukebox: RED first
// Verifies relay behavior for viewer-submitted audio requests (jukebox)

module.exports.run = async (h) => {
  const room = "probe_jukebox_" + Math.random().toString(36).slice(2, 6);
  const [host, viewer1, viewer2] = await h.spawnClients(3, room);
  try {
    // 1) viewer submits a request -> enqueued and queue_state broadcast
    await host.drain("jukebox_queue_state");
    await viewer1.drain("jukebox_queue_state");
    await viewer2.drain("jukebox_queue_state");

    viewer1.sendCtrl("jukebox_request", { id: "req1", asset: "/stingers/airhorn.mp3" });

    const q1 = await host.onCtrl("jukebox_queue_state");
    const item = q1.data && Array.isArray(q1.data.queue) && q1.data.queue.find((q) => q.id === "req1");
    if (!item || item.asset !== "/stingers/airhorn.mp3" || !item.requester) { h.note("assert_fail_enqueue"); return false; }

    // 2) non-host cannot approve
    viewer1.sendCtrl("jukebox_approve", { id: "req1" });
    const err1 = await viewer1.onCtrl("error");
    if (err1.data && err1.data.code !== "not_host") { h.note("assert_fail_not_host", { got: err1.data }); return false; }

    // Still in queue (no removal)
    host.sendCtrl("jukebox_get_queue", {});
    const q2 = await host.onCtrl("jukebox_queue_state");
    if (!q2.data.queue.find((q) => q.id === "req1")) { h.note("assert_fail_queue_missing"); return false; }

    // 3) host approves -> play broadcast to ALL with asset URL
    host.sendCtrl("jukebox_approve", { id: "req1" });
    const playH = await host.onCtrl("jukebox_play");
    const playV1 = await viewer1.onCtrl("jukebox_play");
    const playV2 = await viewer2.onCtrl("jukebox_play");
    const plays = [playH, playV1, playV2];
    if (!plays.every((m) => m.data && m.data.id === "req1" && m.data.asset === "/stingers/airhorn.mp3")) { h.note("assert_fail_play_fanout"); return false; }

    // queue should remove the item after approve (broadcast state)
    const q3 = await host.onCtrl("jukebox_queue_state");
    if (q3.data.queue.find((q) => q.id === "req1")) { h.note("assert_fail_not_removed"); return false; }

    // 4) per-user cooldown: same viewer cannot submit again within window
    viewer1.sendCtrl("jukebox_request", { id: "req2", asset: "/stingers/airhorn.mp3" });
    const cd = await viewer1.onCtrl("error");
    if (!cd.data || cd.data.code !== "jukebox_cooldown") { h.note("assert_fail_cooldown", { got: cd.data }); return false; }

    // Different viewer can submit
    viewer2.sendCtrl("jukebox_request", { id: "req3", asset: "/stingers/airhorn.mp3" });
    const q4 = await host.onCtrl("jukebox_queue_state");
    if (!q4.data.queue.find((q) => q.id === "req3")) { h.note("assert_fail_second_enqueue"); return false; }

    return true;
  } finally {
    await h.closeClients([host, viewer1, viewer2]);
  }
};

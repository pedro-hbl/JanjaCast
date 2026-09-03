// Probe scenario: fila (queue) with pre-warmed publisher handoff.
// The contract: when the relay calls someone to the stage (stage_turn), the
// person being called ALSO receives a unicast stage_warmup — and only them —
// so their client can warm the companion flow before they even click. The
// public stage_turn keeps its existing semantics for everyone.

exports.run = async (h) => {
  const room = "probe_fila_" + Math.random().toString(36).slice(2, 6);
  const [host, a, b] = await h.spawnClients(3, room);

  // Host actually holds the stage — passing it is publisher-only.
  host.sendCtrl("take_stage", {});
  await host.onCtrl("stage_state");
  await a.drain("stage_state"); await b.drain("stage_state");

  // a then b get in line.
  a.sendCtrl("stage_request", {});
  await host.onCtrl("stage_queue"); await a.drain("stage_queue"); await b.drain("stage_queue");
  b.sendCtrl("stage_request", {});
  await host.onCtrl("stage_queue"); await a.drain("stage_queue"); await b.drain("stage_queue");

  // Host passes: a (head of the line) is called. Warmup must reach a...
  host.sendCtrl("stage_pass", {});
  const warmA = await a.onCtrl("stage_warmup", 1500).catch(() => null);
  if (!warmA || warmA.data.userId !== a.id) {
    h.note("no_warmup_a", { got: warmA && warmA.data });
    await h.closeClients([host, a, b]);
    return false;
  }
  // ...and ONLY a — a warmup at the host or at b is a leak.
  const leak = await Promise.race([
    host.onCtrl("stage_warmup", 250).then(() => true).catch(() => false),
    b.onCtrl("stage_warmup", 250).then(() => true).catch(() => false),
  ]);
  if (leak) { h.note("warmup_leak"); await h.closeClients([host, a, b]); return false; }

  // The public turn still reaches everyone, naming the same person.
  const tHost = await host.onCtrl("stage_turn");
  const tB = await b.onCtrl("stage_turn");
  if (tHost.data.userId !== a.id || tB.data.userId !== a.id) {
    h.note("turn_names_wrong_user", { host: tHost.data, b: tB.data });
    await h.closeClients([host, a, b]);
    return false;
  }

  // The pass itself broadcast a publisher-less stage_state (the host left) —
  // drain it everywhere so the next read is the post-claim state.
  await host.drain("stage_state"); await a.drain("stage_state"); await b.drain("stage_state");

  // a claims the stage; stage_state flips to them (continuity: a real
  // publisher exists again, no dead gap in the state machine).
  a.sendCtrl("take_stage", {});
  const st = await b.onCtrl("stage_state", 1500);
  if (!st.data || st.data.publisherId !== a.id) {
    h.note("stage_not_handed_over", { got: st.data });
    await h.closeClients([host, a, b]);
    return false;
  }

  // Second cycle: a passes, b (next in line) gets the warmup. The room's
  // 2s pass cooldown is real product behavior — wait it out.
  await new Promise((r) => setTimeout(r, 2100));
  a.sendCtrl("stage_pass", {});
  const warmB = await b.onCtrl("stage_warmup", 1500).catch(() => null);
  if (!warmB || warmB.data.userId !== b.id) {
    h.note("no_warmup_b", { got: warmB && warmB.data });
    await h.closeClients([host, a, b]);
    return false;
  }

  await h.closeClients([host, a, b]);
  return true;
};

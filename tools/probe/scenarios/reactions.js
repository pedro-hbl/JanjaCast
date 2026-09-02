// Scenario: three viewers tap fire; the room hears an aggregated burst.
// The relay evaluates bursts ON TAP ARRIVAL with 250ms pacing (there is no
// ticker), so a flush tap after the pacing window is part of the protocol:
// taps 2-3 land inside the paced window and are summed into the burst that
// the flush tap triggers.
module.exports.run = async (h) => {
  const room = "probe_reactions_" + Math.random().toString(36).slice(2, 6);
  const clients = await h.spawnClients(3, room);
  try {
    for (const c of clients) c.sendCtrl("reaction", { emoji: "fire" });
    h.note("taps_sent", { n: 3 });

    // First burst fires on the first tap (pacing clock starts at zero).
    const first = await clients[0].onCtrl("reaction_burst");
    h.note("first_burst", { data: first.data });

    // After the 250ms pace and the 200ms per-client cooldown, one flush tap
    // must produce a burst whose window contains all four fires.
    await new Promise((r) => setTimeout(r, 320));
    clients[0].ctrl.length = 0; // only accept a NEW burst below
    clients[0].sendCtrl("reaction", { emoji: "fire" });
    const burst = await clients[0].onCtrl("reaction_burst");
    h.note("flush_burst", { data: burst.data });

    const fire = burst.data && burst.data.counts && burst.data.counts.fire;
    if (fire !== 4) { h.note("assert_fail", { want: 4, got: fire }); return false; }
    if (burst.data.density !== 4) { h.note("assert_fail_density", { got: burst.data.density }); return false; }

    // Every client must have heard it, not just the sender.
    for (const c of clients.slice(1)) {
      if (!c.ctrl.some((m) => m.type === "reaction_burst")) {
        h.note("assert_fail_fanout", { client: c.id });
        return false;
      }
    }
    return true;
  } finally {
    await h.closeClients(clients);
  }
};

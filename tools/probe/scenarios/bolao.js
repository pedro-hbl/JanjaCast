// Probe scenario for Bolao (Sim/Nao prediction) feature
// RED run: asserts expected wire-level behavior before implementation exists
exports.run = async (h) => {
  const room = "probe_bolao_" + Math.random().toString(36).slice(2, 6);
  const [host] = await h.spawnClients(1, room);

  // 1) Host starts a bolao
  host.sendCtrl('bolao_start', { id: 'q1', prompt: 'Vai cair?' });

  // Expect a state broadcast to everyone with counts zero and open=true
  const s0 = await host.onCtrl('bolao_state');
  // Some rooms may immediately receive late join echoes; accept zero or partial then wait one more if needed
  if (!s0 || !s0.data || s0.data.id !== 'q1') { h.note('assert_fail_start_state', { got: s0 }); return false; }
  if (!(s0.data.open === true && s0.data.yes === 0 && s0.data.no === 0)) {
    const maybe = await host.onCtrl('bolao_state');
    const dd = maybe && maybe.data || {};
    if (!(dd.open === true && dd.yes === 0 && dd.no === 0)) { h.note('assert_fail_start_state2', { got: dd }); return false; }
  }

  // 2) Two clients vote
  const [a, b] = await h.spawnClients(2, room);
  // Drain any initial state echoes for late joiners to avoid consuming our assertions
  a.ctrl.length = 0; b.ctrl.length = 0; host.ctrl.length = 0;

  // Send votes slightly staggered to avoid fan-out coalescing races
  a.sendCtrl('bolao_vote', { id: 'q1', vote: 'yes' });
  await new Promise(r=>setTimeout(r,50));
  b.sendCtrl('bolao_vote', { id: 'q1', vote: 'no' });

  // Expect two updates; accept either order and fold them
  const first = await host.onCtrl('bolao_state');
  // If first already has both votes, accept; else wait one more update
  let u1 = first, u2 = null;
  if (!first?.data || (first.data.yes + first.data.no) < 2) {
    u2 = await host.onCtrl('bolao_state');
  }
  const dsum = (() => {
    const a1 = u1 && u1.data || {}; const a2 = (u2 && u2.data) || {};
    return { id: a2.id || a1.id, open: a2.open ?? a1.open, yes: Math.max(a1.yes||0,a2.yes||0), no: Math.max(a1.no||0,a2.no||0) };
  })();
  if (!(dsum.id === 'q1' && dsum.yes === 1 && dsum.no === 1 && dsum.open === true)) { h.note('assert_fail_vote_state', { got: dsum }); return false; }

  // 3) Resolve by host (allow interleaving state): if we haven't seen both votes yet, wait another update before resolving
  if ((dsum.yes + dsum.no) < 2) {
    const extra = await host.onCtrl('bolao_state');
    void extra;
  }
  host.sendCtrl('bolao_resolve', { id: 'q1', result: 'yes' });

  // Final state: open=false, result provided
  const s2 = await host.onCtrl('bolao_state');
  const d2 = s2 && s2.data || {};
  if (!(d2.id === 'q1' && d2.result === 'yes' && d2.open === false && d2.yes === 1 && d2.no === 1)) { h.note('assert_fail_resolved', { got: d2 }); return false; }
  await h.closeClients([host, a, b]);
  return true;
};

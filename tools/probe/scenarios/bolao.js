// Probe scenario for Bolao (Sim/Nao prediction) feature
// RED run: asserts expected wire-level behavior before implementation exists
exports.run = async (h) => {
  const room = "probe_bolao_" + Math.random().toString(36).slice(2, 6);
  const [host] = await h.spawnClients(1, room);

  // 1) Host starts a bolao
  host.sendCtrl('bolao_start', { id: 'q1', prompt: 'Vai cair?' });

  // Expect a state broadcast to everyone with counts zero and open=true
  const s0 = await host.onCtrl('bolao_state');
  if (!s0 || !s0.data || s0.data.id !== 'q1' || !s0.data.open || s0.data.yes !== 0 || s0.data.no !== 0) { h.note('assert_fail_start_state', { got: s0 }); return false; }

  // 2) Two clients vote
  const [a, b] = await h.spawnClients(2, room);

  a.sendCtrl('bolao_vote', { id: 'q1', vote: 'yes' });
  b.sendCtrl('bolao_vote', { id: 'q1', vote: 'no' });

  // Each vote should update state fan-out non-blocking; we just observe one
  const s1 = await host.onCtrl('bolao_state');
  const d1 = s1 && s1.data || {};
  if (!(d1.id === 'q1' && d1.yes === 1 && d1.no === 1 && d1.open === true)) { h.note('assert_fail_vote_state', { got: d1 }); return false; }

  // 3) Resolve by host
  host.sendCtrl('bolao_resolve', { id: 'q1', result: 'yes' });

  // Final state: open=false, result provided
  const s2 = await host.onCtrl('bolao_state');
  const d2 = s2 && s2.data || {};
  if (!(d2.id === 'q1' && d2.result === 'yes' && d2.open === false && d2.yes === 1 && d2.no === 1)) { h.note('assert_fail_resolved', { got: d2 }); return false; }
  await h.closeClients([host, a, b]);
  return true;
};

// Probe scenario for Chama (lightweight call prompt) feature
// RED run: expected behavior prior to implementation
exports.run = async (h) => {
  const room = "probe_chama_" + Math.random().toString(36).slice(2, 6);
  const [host, viewer] = await h.spawnClients(2, room);
  host.ctrl.length = 0; viewer.ctrl.length = 0;

  // Host triggers a chama prompt (call to action)
  host.sendCtrl('chama_start', { id: 'c1', text: 'Bora entrar na call?' });

  // Both should receive chama_state with active=true
  const s0 = await host.onCtrl('chama_state');
  const s0v = await viewer.onCtrl('chama_state');
  if (!s0?.data?.active || !s0v?.data?.active) { h.note('assert_fail_chama_active'); return false; }

  // Viewer acks/dismisses the prompt locally; server records an ack count
  viewer.sendCtrl('chama_ack', { id: 'c1' });
  const s1 = await host.onCtrl('chama_state');
  if (!(s1?.data?.active === true && s1.data.acks === 1)) { h.note('assert_fail_chama_acks', { got: s1 && s1.data }); return false; }
  // The ack broadcast reaches the viewer too — consume it so the next read
  // at the viewer is the END state, not this one (onCtrl is one-shot FIFO).
  const s1v = await viewer.onCtrl('chama_state');
  if (s1v?.data?.acks !== 1) { h.note('assert_fail_chama_ack_fanout', { got: s1v && s1v.data }); return false; }

  // Host ends the chama
  host.sendCtrl('chama_end', { id: 'c1' });
  const s2 = await viewer.onCtrl('chama_state');
  if (!(s2?.data?.active === false && s2.data.acks === 1)) { h.note('assert_fail_chama_end', { got: s2 && s2.data }); return false; }
  await h.closeClients([host, viewer]);
  return true;
};

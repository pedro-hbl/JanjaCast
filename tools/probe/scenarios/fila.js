// Probe scenario: fila (queue) with pre-warmed publisher handoff
// RED: asserts real protocol names and new stage_warmup behavior.

exports.run = async (h) => {
  const room = "probe_fila_" + Math.random().toString(36).slice(2, 6);
  const [host, a, b] = await h.spawnClients(3, room);

  // a and b request stage (drain echoes so subsequent asserts are fresh)
  a.sendCtrl('stage_request', {});
  await host.onCtrl('stage_queue'); await a.drain('stage_queue'); await b.drain('stage_queue');
  b.sendCtrl('stage_request', {});
  await host.onCtrl('stage_queue'); await a.drain('stage_queue'); await b.drain('stage_queue');

  // host passes; warmup must be unicast to a
  host.sendCtrl('stage_pass', {});
  // Expect warmup to a (now unicast); then turn. Allow either order but require warmup observed within window.
  let warmOrTurn = await Promise.race([
    a.onCtrl('stage_warmup', 1200).then((m)=>({k:'warm',m})).catch(()=>null),
    a.onCtrl('stage_turn', 1200).then((m)=>({k:'turn',m})).catch(()=>null),
  ]);
  if (warmOrTurn && warmOrTurn.k === 'turn') {
    // If we saw turn first, still expect a warmup shortly after (server also unicasts)
    warmOrTurn = await a.onCtrl('stage_warmup', 1200).then((m)=>({k:'warm',m})).catch(()=>null) || warmOrTurn;
  }
  const warmA = warmOrTurn && warmOrTurn.k === 'warm' ? warmOrTurn.m : null;
  if (!warmA) { h.note('no_warmup_a'); await h.closeClients([host,a,b]); return false; }

  // Others must NOT see warmup
  await host.drain('stage_turn'); await b.drain('stage_turn');
  const leakHost = await Promise.race([
    host.onCtrl('stage_warmup', 200).then(()=>true).catch(()=>false),
    b.onCtrl('stage_warmup', 200).then(()=>true).catch(()=>false),
  ]);
  if (leakHost) { h.note('warmup_leak'); await h.closeClients([host,a,b]); return false; }

  // Then a public stage_turn naming the same user
  const tHost = warmOrTurn && warmOrTurn.k === 'turn' ? warmOrTurn.m : await host.onCtrl('stage_turn');
  const tB = await b.onCtrl('stage_turn'); void tB;

  // Wrong user cannot take_stage
  b.sendCtrl('take_stage', {});
  const rej = await b.onCtrl('error').catch(()=>null) || await b.onCtrl('stage_state').catch(()=>null);
  if (!rej) { h.note('no_reject_wrong_taker'); await h.closeClients([host,a,b]); return false; }

  // Right user claims
  a.sendCtrl('take_stage', {});
  await a.onCtrl('stage_state');

  // Pass again; warmup then turn to b
  host.sendCtrl('stage_pass', {});
  await b.onCtrl('stage_warmup');
  await host.onCtrl('stage_turn');

  await h.closeClients([host, a, b]);
  return true;
};

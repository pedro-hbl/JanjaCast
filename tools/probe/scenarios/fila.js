// Probe scenario: fila (queue) with pre-warmed publisher handoff
// RED: asserts real protocol names and new stage_warmup behavior.

module.exports.run = async ({ ws, expect, sleep, uuid }) => {
  // Connect three clients: host and two viewers wanting stage
  const host = await ws();
  const a = await ws();
  const b = await ws();

  const hostId = uuid();
  const aId = uuid();
  const bId = uuid();

  host.send(JSON.stringify({ type: 'hello', role: 'host', id: hostId }));
  a.send(JSON.stringify({ type: 'hello', role: 'viewer', id: aId }));
  b.send(JSON.stringify({ type: 'hello', role: 'viewer', id: bId }));

  // Requests using real name stage_request
  a.send(JSON.stringify({ type: 'stage_request' }));
  await expect(host, (m) => m.type === 'stage_queue' && Array.isArray(m.queue) && m.queue[0]?.id === aId);
  b.send(JSON.stringify({ type: 'stage_request' }));
  await expect(host, (m) => m.type === 'stage_queue' && m.queue.length === 2 && m.queue[1]?.id === bId);

  // Advance rotation
  host.send(JSON.stringify({ type: 'stage_pass' }));

  // Only next-in-line receives private warmup
  await expect(a, (m) => m.type === 'stage_warmup' && m.next?.id === aId);
  await sleep(30);
  let leaked = false;
  const pred = (m) => { if (m.type === 'stage_warmup') { leaked = true; } return false; };
  await Promise.all([
    expect(b, pred, { timeout: 30 }).catch(() => null),
    expect(host, pred, { timeout: 30 }).catch(() => null),
  ]);
  if (leaked) throw new Error('stage_warmup leaked');

  // Public turn naming the same user
  await expect(host, (m) => m.type === 'stage_turn' && m.data?.id === aId);
  await expect(b, (m) => m.type === 'stage_turn' && m.data?.id === aId);

  // Continuity guard: wrong user cannot take_stage
  b.send(JSON.stringify({ type: 'take_stage' }));
  await expect(b, (m) => m.type === 'stage_state' && m.error);

  // Right user claims
  a.send(JSON.stringify({ type: 'take_stage' }));
  await expect(a, (m) => m.type === 'stage_state' && m.active?.id === aId);

  // Pass again; warmup for B, then turn to B
  host.send(JSON.stringify({ type: 'stage_pass' }));
  await expect(b, (m) => m.type === 'stage_warmup' && m.next?.id === bId);
  await expect(host, (m) => m.type === 'stage_turn' && m.data?.id === bId);

  // Cleanup
  host.close();
  a.close();
  b.close();
};

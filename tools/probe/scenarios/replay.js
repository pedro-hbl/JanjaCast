// Probe scenario: 90s replay with room-events sidecar
// RED run first: this asserts the new replay flow and must fail
// for the right reason until the feature is implemented.

const assert = require('assert');

exports.run = async function (h) {
  const room = "probe_replay_" + Math.random().toString(36).slice(2, 6);
  const [pub] = await h.spawnClients(1, room);

  // Media only enters the rolling buffer from the actual publisher, and the
  // buffer is keyframe-bounded — the first chunk must be a keyframe.
  pub.sendCtrl('take_stage', {});
  await pub.onCtrl('stage_state');
  pub.sendCtrl('config', { videoCodec: 'vp8', width: 640, height: 360, framerate: 30 });
  
  // Build a few synthetic chunks (~3s worth) using harness helpers
  const bmc = require('../harness').buildMediaChunk;
  const chunks = [
    bmc({ seq: 1, timestampUs: 0n, keyframe: true }),
    bmc({ seq: 2, timestampUs: 1000000n }),
    bmc({ seq: 3, timestampUs: 2000000n }),
  ];

  for (const c of chunks) {
    await pub.sendMedia(c);
  }

  // While media flows, log some room events with timestamps
  const t0 = Date.now();
  // Emit via control channel; server should persist as room-events sidecar
  pub.sendCtrl('probe_room_event', { type: 'join', user: 'alice', at: t0 + 300 });
  pub.sendCtrl('probe_room_event', { type: 'join', user: 'bob', at: t0 + 900 });
  pub.sendCtrl('probe_room_event', { type: 'reaction_burst', emoji: 'fire', count: 7, at: t0 + 1500 });
  pub.sendCtrl('probe_room_event', { type: 'placar', value: { a: 1, b: 0 }, at: t0 + 1800 });

  // Ask server for a 90s replay token (variant on existing clip endpoint)
  // Ask server for a 90s replay token by control message; expect a reply
  pub.sendCtrl('replay_request', { seconds: 90 });
  const rr = await pub.onCtrl('replay_ready');
  const tok = rr && rr.data && rr.data.token;
  assert(tok, 'replay token issued');

  // Fetch raw JCLP stream for the clip
  const clipRes = await new Promise((resolve) => {
    const req = require('http').get(`http://127.0.0.1:8102/clip/${tok}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
  });
  assert.equal(clipRes.status, 200, 'clip GET 200');
  assert(clipRes.headers['content-type'] && clipRes.headers['content-type'].includes('application/octet-stream'), 'clip is raw stream');
  assert(clipRes.body && clipRes.body.length > 0, 'clip has payload');

  // NEW: events sidecar must be available at /clip/{token}/events.json
  const evRes = await new Promise((resolve) => {
    const req = require('http').get(`http://127.0.0.1:8102/clip/${tok}/events.json`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve({ status: 0, headers: {}, text: '' }));
  });
  assert.equal(evRes.status, 200, 'events sidecar 200');
  assert(evRes.headers['content-type'] && evRes.headers['content-type'].includes('application/json'), 'events is JSON');

  const events = JSON.parse(evRes.text || '[]');
  assert(Array.isArray(events), 'events is array');

  // Expect at least the emitted types, with timestamps within clip window
  const types = events.map(e => e.type);
  assert(types.includes('join'), 'join present');
  assert(types.includes('reaction_burst'), 'reaction burst present');
  assert(types.includes('placar'), 'placar present');
  return true;
};

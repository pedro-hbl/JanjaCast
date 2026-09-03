// Probe scenario: assist pointers fan-out (viewer -> publisher only)
// RED phase: asserts before implementation exists — must fail on specific expectations.
// This uses the real probe harness to boot the server and drive WebSocket clients.

const { expect } = require('chai');

exports.run = async (h) => {
  // Connect publisher and two viewers to the same room
  const room = 'probe_assist_' + Math.random().toString(36).slice(2, 6);
  const [pub, v1, v2] = await h.spawnClients(3, room);
  pub.ctrl.length = 0; v1.ctrl.length = 0; v2.ctrl.length = 0;
  // Harness identifies users via initial join only; encode usernames in local vars

  // Take stage and minimal config by publisher (make them the current source)
  pub.sendCtrl('take_stage', {});
  // No opt-in gate per issue; config step kept for symmetry
  pub.sendCtrl('config', {});

  // 1) viewer taps assist_point, server should unicast assist_show to publisher only
  const point = { x: 0.25, y: 0.75 };
  v1.sendCtrl('assist_point', point);

  const evt = await pub.onCtrl('assist_show');
  expect(evt).to.have.property('type', 'assist_show');
  expect(evt).to.have.property('data');
  expect(evt.data).to.include({ x: point.x, y: point.y });
  expect(evt.data).to.have.property('userId').that.is.a('string');
  // Harness uses random probe ids for username; just assert it matches v1 id
  expect(evt.data).to.have.property('username', v1.id);
  expect(evt.data).to.have.property('ttlMs').that.is.a('number');

  // Ensure viewers DO NOT receive assist_show (publisher-only unicast)
  const no1 = await v1.onCtrl('assist_show', 200).catch(() => null);
  const no2 = await v2.onCtrl('assist_show', 200).catch(() => null);
  expect(no1).to.equal(null);
  expect(no2).to.equal(null);

  // 2) per-viewer cooldown: a rapid second tap should be rejected with an error
  v1.sendCtrl('assist_point', { x: 0.3, y: 0.1 });
  const err1 = await v1.onCtrl('error');
  expect(err1).to.have.property('data');
  expect(err1.data).to.have.property('code').that.matches(/assist\.cooldown/);

  // 3) out-of-range coordinates must be rejected
  v2.sendCtrl('assist_point', { x: -0.1, y: 1.1 });
  const err2 = await v2.onCtrl('error');
  expect(err2).to.have.property('data');
  expect(err2.data).to.have.property('code').that.matches(/assist\.bounds/);

  // Also ensure no stray assist_show went to publisher for invalid point
  const noPub = await pub.onCtrl('assist_show', 200).catch(() => null);
  expect(noPub).to.equal(null);

  await h.closeClients([pub, v1, v2]);
  return true; // GREEN once implementation lands
};

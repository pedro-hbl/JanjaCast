// Probe scenario: ISSUE-1 attention signal (RED)
// Harness style matches tools/probe/harness.js API.
const { expect } = require('chai');

exports.run = async (h) => {
  const room = 'probe_atencao_' + Math.random().toString(36).slice(2, 6);
  const [pub, v1, v2] = await h.spawnClients(3, room);

  // The signal exists FOR a publisher: without a stage there is no one to
  // tell, so the aggregate stays silent. Take it first.
  pub.sendCtrl('take_stage', {});
  await pub.onCtrl('stage_state');

  // The hidden one reports FIRST: the aggregate's first emission is then
  // deterministically 2/3 (throttle window opens on it; the two visible
  // reports that follow land inside the window and change nothing).
  v2.sendCtrl('attention_report', { visible: false });
  const s0 = await pub.onCtrl('attention_state');
  expect(s0.data).to.include({ watching: 2, total: 3 });
  pub.sendCtrl('attention_report', { visible: true });
  v1.sendCtrl('attention_report', { visible: true });

  // Viewers should not receive attention_state
  const no1 = await v1.onCtrl('attention_state', 300).catch(() => null);
  const no2 = await v2.onCtrl('attention_state', 300).catch(() => null);
  expect(no1).to.equal(null);
  expect(no2).to.equal(null);

  // Throttle: further reports within 5s do not emit again
  v2.sendCtrl('attention_report', { visible: true }); // 3/3
  v1.sendCtrl('attention_report', { visible: false }); // 2/3
  // Within 1s, no new attention_state should arrive
  const throttleNo = await pub.onCtrl('attention_state', 1000).catch(() => null);
  expect(throttleNo).to.equal(null);

  // After 5s, next change emits
  await new Promise(r => setTimeout(r, 4500));
  v1.sendCtrl('attention_report', { visible: true }); // 3/3
  const s2 = await pub.onCtrl('attention_state');
  expect(s2.data).to.include({ watching: 3, total: 3 });

  await h.closeClients([pub, v1, v2]);
  return true;
};

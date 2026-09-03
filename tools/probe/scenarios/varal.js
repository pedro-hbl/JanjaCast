// Probe scenario: the varal (session memory board).
// Contract: any member pins a quote magnet or frame polaroid; the whole room
// gets varal_state with the pin; a rapid second pin from the same person is
// rejected by cooldown; removal is author-or-publisher only; a late joiner
// receives the board in the welcome flow.
module.exports.run = async (h) => {
  const room = "probe_varal_" + Math.random().toString(36).slice(2, 6);
  const [pub, a] = await h.spawnClients(2, room);

  // Publisher on stage (frame pins reference the live publisher).
  pub.sendCtrl("take_stage", {});
  await pub.onCtrl("stage_state");
  // Both got an empty board in their welcome — drain it and later echoes.
  await pub.drain("varal_state"); await a.drain("varal_state");

  // 1) Viewer pins a quote; everyone hears the new board.
  a.sendCtrl("varal_pin", { kind: "quote", quote: { text: "essa foi historica" } });
  const s1 = await pub.onCtrl("varal_state");
  const pin = s1.data && s1.data.pins && s1.data.pins[0];
  if (!pin || pin.kind !== "quote" || pin.quote.text !== "essa foi historica" || pin.authorId !== a.id) {
    h.note("assert_fail_pin", { got: s1.data }); return false;
  }
  const s1a = await a.onCtrl("varal_state");
  if (!s1a.data.pins || s1a.data.pins.length !== 1) { h.note("assert_fail_pin_fanout"); return false; }

  // 2) Rapid second pin from the same person: cooldown error, no new state.
  a.sendCtrl("varal_pin", { kind: "quote", quote: { text: "spam" } });
  const err = await a.onCtrl("error", 900).catch(() => null);
  if (!err || !String(err.data && err.data.code).includes("varal")) {
    h.note("assert_fail_cooldown", { got: err && err.data }); return false;
  }

  // 3) A non-author (not publisher either) cannot remove — join a third.
  const [b] = await h.spawnClients(1, room);
  const wb = await b.onCtrl("varal_state"); // welcome backlog
  if (!wb.data.pins || wb.data.pins.length !== 1) { h.note("assert_fail_backlog", { got: wb.data }); return false; }
  b.sendCtrl("varal_remove", { id: pin.id });
  const rerr = await b.onCtrl("error", 900).catch(() => null);
  if (!rerr) { h.note("assert_fail_remove_guard"); return false; }

  // 4) The author removes; board empties for everyone.
  await pub.drain("varal_state"); await b.drain("varal_state");
  a.sendCtrl("varal_remove", { id: pin.id });
  const s2 = await b.onCtrl("varal_state");
  if (!s2.data || (s2.data.pins || []).length !== 0) { h.note("assert_fail_remove", { got: s2.data }); return false; }

  await h.closeClients([pub, a, b]);
  return true;
};

// Probe scenario: corrente da tela — publisher-nominated handoff.
// Contract: the publisher nominates a specific person; the target alone gets
// a quiet stage_warmup; everyone sees corrente_started with a real deadline;
// a "calma" majority cancels; without a veto the countdown ends in a normal
// stage_turn naming the target.
module.exports.run = async (h) => {
  const room = "probe_corrente_" + Math.random().toString(36).slice(2, 6);
  const [pub, a, b, c] = await h.spawnClients(4, room);

  pub.sendCtrl("take_stage", {});
  await pub.onCtrl("stage_state");

  // 1) Non-publisher cannot nominate.
  a.sendCtrl("corrente_nominate", { target: b.id });
  const nerr = await a.onCtrl("error", 900).catch(() => null);
  if (!nerr || !String(nerr.data.code).includes("corrente")) { h.note("assert_fail_guard", { got: nerr && nerr.data }); return false; }

  // 2) Publisher nominates a; started fans out; warmup unicast to a only.
  pub.sendCtrl("corrente_nominate", { target: a.id });
  const st = await b.onCtrl("corrente_started");
  if (st.data.target !== a.id || !st.data.endsAtMs) { h.note("assert_fail_started", { got: st.data }); return false; }
  const warm = await a.onCtrl("stage_warmup", 1200).catch(() => null);
  if (!warm) { h.note("assert_fail_warmup"); return false; }
  const leak = await Promise.race([
    b.onCtrl("stage_warmup", 250).then(() => true).catch(() => false),
    c.onCtrl("stage_warmup", 250).then(() => true).catch(() => false),
  ]);
  if (leak) { h.note("assert_fail_warmup_leak"); return false; }

  // 3) "Calma" majority (2 of 3 non-publisher voters) cancels.
  a.sendCtrl("corrente_vote", { choice: "calma" });
  await b.onCtrl("corrente_tally");
  b.sendCtrl("corrente_vote", { choice: "calma" });
  const cancel = await c.onCtrl("corrente_canceled", 1500);
  if (cancel.data.reason !== "veto") { h.note("assert_fail_veto", { got: cancel.data }); return false; }

  // 4) A fresh unvetoed nomination auto-calls the target at the deadline.
  await a.drain("stage_warmup"); await c.drain("corrente_started"); await b.drain("corrente_started");
  pub.sendCtrl("corrente_nominate", { target: c.id });
  await b.onCtrl("corrente_started");
  const turn = await b.onCtrl("stage_turn", 9000);
  if (turn.data.userId !== c.id) { h.note("assert_fail_autoturn", { got: turn.data }); return false; }

  await h.closeClients([pub, a, b, c]);
  return true;
};

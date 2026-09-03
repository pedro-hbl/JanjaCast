// Probe scenario: aposta paralela — dynamic 1v1 side-bets, written on the
// spot. Contract: aposta_challenge {target, text} (free text, sanitized,
// <=80) -> aposta_state fan-out {id, phase:"offered", text, challenger*,
// target*}; the target accepts/declines; while "on", ONLY the current
// publisher judges (aposta_judge {id, winner}) -> phase "resolved" with the
// winner named and the session win-count bumped in the same state.
module.exports.run = async (h) => {
  const room = "probe_aposta_" + Math.random().toString(36).slice(2, 6);
  const [pub, alice, bob, witness] = await h.spawnClients(4, room);

  pub.sendCtrl("take_stage", {});
  await pub.onCtrl("stage_state");

  // 1) Alice challenges Bob with on-the-spot text; the whole room sees it.
  alice.sendCtrl("aposta_challenge", { target: bob.id, text: "<b>aposto que ele morre</b> em 30s" });
  const st1 = await witness.onCtrl("aposta_state");
  const d1 = st1.data;
  if (d1.phase !== "offered" || d1.challengerId !== alice.id || d1.targetId !== bob.id) {
    h.note("fail_offer", { got: d1 }); return false;
  }
  if (d1.text !== "aposto que ele morre em 30s") { h.note("fail_sanitize", { got: d1.text }); return false; }

  // 2) Nobody but the target may answer the offer.
  witness.sendCtrl("aposta_accept", { id: d1.id });
  const gerr = await witness.onCtrl("error", 900);
  if (!String(gerr.data.code).includes("aposta")) { h.note("fail_answer_guard", { got: gerr.data }); return false; }

  // 3) Bob accepts: the bet is on, room-wide.
  await witness.drain("aposta_state");
  bob.sendCtrl("aposta_accept", { id: d1.id });
  const st2 = await witness.onCtrl("aposta_state");
  if (st2.data.phase !== "on") { h.note("fail_on", { got: st2.data }); return false; }

  // 4) Only the publisher judges.
  witness.sendCtrl("aposta_judge", { id: d1.id, winner: "challenger" });
  const jerr = await witness.onCtrl("error", 900);
  if (!String(jerr.data.code).includes("aposta")) { h.note("fail_judge_guard", { got: jerr.data }); return false; }

  await witness.drain("aposta_state");
  pub.sendCtrl("aposta_judge", { id: d1.id, winner: "challenger" });
  const st3 = await witness.onCtrl("aposta_state");
  if (st3.data.phase !== "resolved" || st3.data.winnerId !== alice.id) { h.note("fail_resolve", { got: st3.data }); return false; }
  if (!st3.data.wins || st3.data.wins[alice.id] !== 1) { h.note("fail_scoreboard", { got: st3.data.wins }); return false; }

  // 5) Declining kills a fresh offer for everyone.
  await witness.drain("aposta_state");
  bob.sendCtrl("aposta_challenge", { target: alice.id, text: "revanche agora" });
  const st4 = await witness.onCtrl("aposta_state");
  alice.sendCtrl("aposta_decline", { id: st4.data.id });
  const st5 = await witness.onCtrl("aposta_state");
  if (st5.data.phase !== "declined") { h.note("fail_decline", { got: st5.data }); return false; }

  await h.closeClients([pub, alice, bob, witness]);
  return true;
};

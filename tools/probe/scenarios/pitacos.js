// Probe scenario: mural de pitacos — ephemeral sticky notes on the bezel.
// Contract: pitaco_post {text<=60, side left|right} -> relay sanitizes
// (tags stripped), assigns one of 4 slots per side, broadcasts pitaco_show
// {id, text, side, slot, authorName, ttlMs~10s} to ALL; 8s per-user
// cooldown; a post with both sides full is refused pitaco.full; expired
// slots free themselves.
module.exports.run = async (h) => {
  const room = "probe_pitacos_" + Math.random().toString(36).slice(2, 6);
  const [a, b] = await h.spawnClients(2, room);

  // 1) post -> fan-out with slot assignment
  a.sendCtrl("pitaco_post", { text: "usa a pocao!", side: "left" });
  const sA = await a.onCtrl("pitaco_show");
  const sB = await b.onCtrl("pitaco_show");
  const d = sA.data;
  if (!d || d.id !== sB.data.id) { h.note("fail_id"); return false; }
  if (d.text !== "usa a pocao!" || d.side !== "left") { h.note("fail_echo", { got: d }); return false; }
  if (!(d.slot >= 0 && d.slot <= 3)) { h.note("fail_slot", { got: d.slot }); return false; }
  if (!(d.ttlMs >= 9000 && d.ttlMs <= 12000)) { h.note("fail_ttl", { got: d.ttlMs }); return false; }
  if (!d.authorName) { h.note("fail_author"); return false; }

  // 2) 8s per-user cooldown
  a.sendCtrl("pitaco_post", { text: "de novo", side: "left" });
  const cool = await a.onCtrl("error", 900);
  if (cool.data.code !== "pitaco.cooldown") { h.note("fail_cooldown", { got: cool.data }); return false; }

  // 3) capacity: fill all 8 slots (7 more posters), then the 9th refuses.
  const extras = await h.spawnClients(7, room);
  for (let i = 0; i < 7; i++) {
    extras[i].sendCtrl("pitaco_post", { text: "p" + i, side: i % 2 ? "right" : "left" });
    await b.onCtrl("pitaco_show", 1500);
  }
  const [ninth] = await h.spawnClients(1, room);
  ninth.sendCtrl("pitaco_post", { text: "transborda", side: "left" });
  // Either side may be the fuller one; the relay refuses when BOTH are full.
  const full = await ninth.onCtrl("error", 900);
  if (full.data.code !== "pitaco.full") { h.note("fail_full", { got: full.data }); return false; }

  // 4) sanitization strips tags entirely
  await new Promise((r) => setTimeout(r, 10500)); // slots and cooldowns expire
  await a.drain("pitaco_show"); // the 7 fan-outs from step 3 sit unconsumed here
  a.sendCtrl("pitaco_post", { text: "<b>ok</b>", side: "right" });
  const san = await a.onCtrl("pitaco_show", 1500);
  if (san.data.text !== "ok") { h.note("fail_sanitize", { got: san.data.text }); return false; }

  await h.closeClients([a, b, ninth, ...extras]);
  return true;
};

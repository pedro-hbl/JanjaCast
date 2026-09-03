// Probe scenario for ISSUE-1-legenda: collaborative live captions
// Failing-first: asserts caption wire path and relay enforcement.

module.exports.run = async (h) => {
  const room = "probe-legenda";
  h.note("spawn", { room });
  const [pub, a, b] = await h.spawnClients(3, room);

  // Step 1: basic submit -> broadcast fanout with author
  // Captions start disabled; enable as publisher first
  // Ensure publisher first, then enable captions so relay accepts toggle
  await pub.sendCtrl("take_stage", {});
  await pub.onCtrl("stage_state", 1200);
  await pub.sendCtrl("caption_toggle", { enabled: true });
  // Any participant should see the state
  await a.onCtrl("caption_state", 1500);
  await b.onCtrl("caption_state", 1500);
  h.note("step1.submit", { text: "teste legenda" });
  await a.sendCtrl("caption_submit", { text: "teste legenda" });
  const msg1 = await b.onCtrl("caption_broadcast", 800);
  if (!msg1 || !msg1.data || msg1.data.text !== "teste legenda" || !msg1.data.author || !msg1.data.user_id) {
    h.note("assert.fail.step1", { got: msg1 });
    return false;
  }

  // Step 2: per-user 4s cooldown -> rate_limit error and no broadcast
  h.note("step2.cooldown.send1");
  await a.sendCtrl("caption_submit", { text: "um" });
  h.note("step2.cooldown.send2-fast");
  await a.sendCtrl("caption_submit", { text: "dois" });
  const err = await a.onCtrl("error", 700).catch(() => null);
  if (!err || !err.data || err.data.code !== "caption.rateLimit") {
    h.note("assert.fail.step2.error", { got: err });
    return false;
  }
  // Ensure B did not receive a broadcast for the rate-limited submit
  const noFanout = await b.onCtrl("caption_broadcast", 500).then(() => true).catch(() => false);
  if (noFanout) {
    h.note("assert.fail.step2.fanout");
    return false;
  }

  // Step 3: publisher disables, state broadcast, then error on submit
  h.note("step3.toggle.off by publisher");
  await pub.sendCtrl("caption_toggle", { enabled: false });
  const stateOff = await a.onCtrl("caption_state", 800);
  if (!stateOff || !stateOff.data || stateOff.data.enabled !== false) {
    h.note("assert.fail.step3.state", { got: stateOff });
    return false;
  }
  await b.sendCtrl("caption_submit", { text: "nao deve passar" });
  const errDis = await b.onCtrl("error", 700).catch(() => null);
  if (!errDis || !errDis.data || errDis.data.code !== "caption.off") {
    h.note("assert.fail.step3.disabled", { got: errDis });
    return false;
  }

  // Re-enable and ensure submit works again
  await pub.sendCtrl("caption_toggle", { enabled: true });
  const stateOn = await a.onCtrl("caption_state", 800);
  if (!stateOn || !stateOn.data || stateOn.data.enabled !== true) {
    h.note("assert.fail.step3.stateOn", { got: stateOn });
    return false;
  }
  // Stale broadcasts from earlier steps may sit unconsumed at a/b — drain
  // so the next read really is the "voltou" broadcast.
  await a.drain("caption_broadcast");
  await b.drain("caption_broadcast");
  await b.sendCtrl("caption_submit", { text: "voltou" });
  const back = await a.onCtrl("caption_broadcast", 1000);
  if (!back || !back.data || back.data.text !== "voltou") {
    h.note("assert.fail.step3.resume", { got: back });
    return false;
  }

  // Step 5: sanitization + 120-char truncation
  const long = "<script>alert('xss')</script>" + "A".repeat(200);
  await b.drain("caption_broadcast"); // b heard its own "voltou" fan-out
  await new Promise((r) => setTimeout(r, 4100)); // clear a's 4s cooldown
  await a.sendCtrl("caption_submit", { text: long });
  const san = await b.onCtrl("caption_broadcast", 1000);
  // Truncation applies to the RAW text (120 chars) before HTML-escaping, so
  // measure the visible length with entities collapsed, not the wire bytes.
  const visible = san && san.data ? san.data.text.replace(/&[a-z]+;|&#\d+;/gi, "x") : "";
  if (!san || !san.data || visible.length !== 120 || /<script>/i.test(san.data.text)) {
    h.note("assert.fail.step5.sanitize", { got: san && san.data && san.data.text && san.data.text.slice(0,140) });
    return false;
  }

  // Step 8: clear on publisher stop
  await pub.sendCtrl("leave_stage", {});
  const clr = await a.onCtrl("caption_clear", 1000);
  if (!clr) {
    h.note("assert.fail.step8.clear");
    return false;
  }

  // If we got here, expectations met (will be RED before impl)
  return true;
};

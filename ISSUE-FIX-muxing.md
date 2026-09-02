# Fix: clips must download as files that actually play

**Status:** the current server-side "remux" (relay.go ~1346) is a placeholder —
an `ftyp` signature followed by raw concatenated payloads. No player opens it.
Ship a real container. The server-side fake muxer must be DELETED, not kept.

## Approach: mux in the browser, not in Go

The npm packages `mp4-muxer` and `webm-muxer` (both MIT, by Vanilagy) are
designed for exactly this: they accept WebCodecs **encoded** chunk bytes plus
timestamps — no decode/re-encode. Vite bundles them into our JS, so Discord's
CSP is satisfied (no CDN). This removes all container logic from Go.

## Steps

1. **Server: serve the raw buffer, honestly.** Replace the fake remux with a
   plain raw serving path: `GET /clip/{token}` returns the rolling-buffer
   chunks in a simple length-prefixed binary framing:
   `[4B magic "JCLP"][JSON header: {videoCodec, width, height, framerate,
   audioCodec?, sampleRate?, channels?} length-prefixed uint32][then per chunk:
   uint8 kind, uint8 flags(keyframe), uint32 payload len, uint64 timestampUs,
   payload]`. Keep the token store, TTL, cooldown, and throttling exactly as
   they are. Delete the placeholder muxer and its tests; add a test that the
   served stream round-trips chunk-for-chunk.
2. **Client: vendor the muxers.** `cd web && npm install mp4-muxer webm-muxer`.
3. **Client: build the file.** New `web/src/clipmux.ts`: fetch the raw stream,
   parse the framing, pick the muxer by codec (avc* → mp4-muxer; vp8/av01 →
   webm-muxer; audio opus → webm, mp4-muxer supports Opus in MP4 — if the
   pairing is awkward, video-only is acceptable for MP4+opus, note it in a
   comment), feed chunks with their real timestamps, finalize to a Blob, and
   trigger the download (`a[download]` with object URL, revoked after).
4. **Wire the UI.** The existing clip.ready state's action calls clipmux
   instead of linking the raw URL. Keep working/ready/expired states and the
   i18n keys already present.
5. **Verify.** Gates per AGENTS.md, plus: relay test for the framing
   round-trip; in the REPORT state which muxer path each codec takes.

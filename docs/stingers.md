# Stingers

A **stinger** is a short meme image plus a sound that every participant in a
room plays at the same moment. JanjaCast fires one when a stream starts, one
when it stops, and one whenever somebody presses a button in the Stingers
panel.

This document covers the storage decision (why local disk, what an S3 backend
would have to do), the on-disk format, the HTTP API, and the manual-trigger
control.

---

## 1. Storage: the decision

### The constraint that decides it — the Activity CSP

JanjaCast's client is a Discord Activity. It runs in an iframe on
`<app-id>.discordsays.com` under a Content-Security-Policy Discord controls,
and **every network request it makes must go to its own origin**, where
Discord's proxy forwards `/.proxy/<path>` to the developer's mapped server.
There is no allow-list a developer can extend: a `<img src="https://bucket.
r2.cloudflarestorage.com/...">` or an `Audio(...)` pointed at a presigned S3
URL is blocked before it leaves the frame, and the failure is silent — the
image simply never decodes.

That single fact removes the main reason anyone reaches for object storage in
the first place. A stinger asset **cannot** be served to the client from
anywhere except the JanjaCast origin. An S3 backend does not become "the CDN";
it becomes a slower disk that the relay must read from and re-serve itself.

### The three candidates

| | (a) Local directory | (b) S3-compatible object storage | (c) Browser-local |
| --- | --- | --- | --- |
| Client can fetch directly | yes (same origin) | **no** — CSP blocks it; server must proxy | yes |
| Ops burden for a self-hoster | a bind mount | credentials, bucket, region, lifecycle, an account somewhere | none |
| Upload path | multipart POST → `os.CreateTemp` + rename | multipart POST → server → SDK → bucket | none (never leaves the browser) |
| Persistence across restarts | yes (the volume) | yes | per-browser, per-profile |
| **Everyone sees the same stinger** | yes | yes | **no** |
| Extra dependency | none | an S3 SDK (~10 MB of module graph) | none |
| Latency on a pick | `ReadDir` on ≤100 entries (µs) | a network round trip, or a cache to keep coherent | n/a |

**(c) browser-local is disqualified on correctness, not convenience.** The
whole point of a stinger is that the room shares a moment: the relay picks one
pair and broadcasts the *same* URLs to everybody so eight people laugh at the
same picture at the same time. If assets lived in each viewer's IndexedDB,
either every viewer would see a different image, or the sharer would have to
push bytes to everyone over the relay — re-inventing file transfer inside a
media relay whose queues are tuned to shed data under pressure. It also loses
the assets when someone clears site data, and gives a new joiner nothing.

**(b) S3 is a real option that buys nothing here.** With the client unable to
reach the bucket, the server sits in the path anyway, so S3 costs a proxy hop
and a cache-coherence problem in exchange for durability the self-hoster
mostly already has (the same volume that holds their compose file). It earns
its keep in exactly one deployment shape — several relay replicas behind a
load balancer that must agree on the asset set — which JanjaCast is not: a
room is a single process's in-memory `Room`, so the deployment is inherently
one node.

**(a) local directory wins.** It is what already ships
(`JANJACAST_STINGER_DIR`), it is one bind mount in `docker-compose.yml`, the
files are inspectable and replaceable with a file manager, a pick is a
`ReadDir` of a directory that will hold tens of entries, and serving is
`http.ServeContent` with an OS page cache underneath.

### The implementation shape: an interface, one backend

`internal/stinger` defines a `Store` interface and ships a single
implementation, `DiskStore`. The interface exists so the S3 variant is an
afternoon rather than a refactor — every caller in `internal/server` is
written against the interface, and nothing above it knows about `os`.

```go
type Store interface {
    List() ([]Asset, error)
    Open(name string) (io.ReadSeekCloser, Asset, error)
    Create(name string, r io.Reader, limit int64) (Asset, error)
    Delete(name string) error
    SetFlags(name string, f FlagPatch) (Asset, error)
    Pick(moment Moment) *protocol.StingerData
}
```

**What an S3 backend would have to do** (designed-for, not built):

- `List` → `ListObjectsV2` under a key prefix, plus the settings object.
  Cache it with a short TTL and invalidate on every mutation; `Pick` is called
  under `Room.mu` and must never block on the network, so the cache is not
  optional — it is a correctness requirement of the lock discipline (see § 5).
- `Open` → `GetObject`, and `handleStinger` streams it through with the same
  `Cache-Control`. Presigned URLs are not usable: the CSP blocks them.
- `Create` → `PutObject` (or a multipart upload for the 8 MiB ceiling, which
  is under the 5 GiB single-part limit, so a plain `PutObject` suffices).
- `SetFlags` → read-modify-write of the settings object. S3 has no rename, so
  the atomic temp+rename trick does not apply; use a conditional write
  (`If-Match` on the ETag) and retry, which gives the same
  last-writer-doesn't-clobber property.
- Credentials from the environment (`AWS_ACCESS_KEY_ID`, …, plus
  `JANJACAST_STINGER_S3_ENDPOINT` for R2/MinIO and
  `JANJACAST_STINGER_S3_BUCKET`), selected by a new config field.

Nothing in `internal/server` or the client changes: assets are still addressed
by name under `/stingers/<name>` and still served by the relay.

---

## 2. On disk

```
$JANJACAST_STINGER_DIR/
  airhorn.mp3
  cat-typing.gif
  wow.webp
  .janjacast-stingers.json     ← settings; dot-prefixed, never served
```

Asset files are flat in the directory — no subdirectories, no manifest of
"which files exist". The directory *is* the manifest: a `ReadDir` filtered by
extension, exactly as before. Drop a file in by hand and it works; delete one
by hand and it disappears. The settings file only ever *decorates* what the
directory already contains.

### The settings file

```json
{
  "version": 1,
  "assets": {
    "airhorn.mp3":    { "enabled": true,  "playOnStart": true,  "playOnStop": false },
    "cat-typing.gif": { "enabled": false, "playOnStart": true,  "playOnStop": true }
  }
}
```

Rules that keep it honest:

- **Absent file = today's behaviour.** No settings file, or no entry for an
  asset, means `enabled: true, playOnStart: true, playOnStop: true` — every
  asset is in both pools, which is exactly what a directory-only deployment
  did before this feature existed. Backward compatibility is not a code path;
  it is the default value.
- **Written atomically.** `os.CreateTemp` in the same directory, write, `Sync`,
  `Close`, `os.Rename` over the target. A crash mid-write leaves either the old
  file or the new one, never a truncated one. (Same-directory temp matters:
  `rename(2)` is only atomic within a filesystem.)
- **Entries for vanished files are pruned** on the next write, so hand-deleting
  an asset does not leave the file growing forever.
- **A corrupt or unreadable settings file is not fatal.** It is logged and
  treated as absent: the room keeps playing stingers with default flags rather
  than the feature silently dying.
- It is never served. `handleStinger` only serves names whose extension is a
  known image/audio type, and the settings file is both dot-prefixed and
  `.json`.

### Limits

| Limit | Value | Why |
| --- | --- | --- |
| Bytes per file | 8 MiB | A stinger is a reaction image and a two-second horn. 8 MiB is generous for both and small enough that an upload cannot become a memory or bandwidth event. |
| Assets in the directory | 100 | Bounds `ReadDir` under `Room.mu` and keeps the panel a browsable grid rather than a database. |
| Uploads per IP | 20 / minute | Same `rateLimiter` the auth endpoints use. |

---

## 3. HTTP API

All four endpoints live under `/api/stingers`, are registered only when
`JANJACAST_STINGER_DIR` is set, and all of them require the **same credential
the WebSocket join requires**.

### Authentication

Mutating a shared asset set is a room-level action, so it is gated exactly the
way joining a room is:

- `Authorization: Bearer <token>` where `<token>` is **either** a JanjaCast
  share token (verified locally by HMAC — tried first, it costs nothing) **or**
  a Discord OAuth access token (verified against `GET /oauth2/@me`, with the
  same audience check and result cache the join path uses).
- On a server started with `JANJACAST_ALLOW_ANON=1` the check is skipped
  entirely, mirroring `handleShareToken`. That is the local-development mode
  and it is already the mode in which anonymous clients can take the stage.
- Failure is `401`, never a redirect and never a partial success.

`GET` is authenticated too. The list is not secret in any interesting sense,
but an unauthenticated list would hand an anonymous scanner the exact set of
names that `/stingers/<name>` will serve, and there is no reason to.

### Endpoints

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/stingers` | — | `{"assets":[Asset,…],"max":100,"maxBytes":8388608}` |
| `POST` | `/api/stingers` | `multipart/form-data`, field `file` (repeatable) | `{"assets":[Asset,…],"errors":[{"name":…,"error":…},…]}` |
| `PATCH` | `/api/stingers/{name}` | `{"enabled"?:bool,"playOnStart"?:bool,"playOnStop"?:bool}` | the updated `Asset` |
| `DELETE` | `/api/stingers/{name}` | — | `204` |

An `Asset`:

```json
{
  "name": "airhorn.mp3",
  "type": "audio",
  "contentType": "audio/mpeg",
  "size": 48213,
  "url": "/stingers/airhorn.mp3",
  "enabled": true,
  "playOnStart": true,
  "playOnStop": false
}
```

`url` is a path, not an absolute URL, and the client runs it through
`apiPath()` so it picks up the `/.proxy` prefix inside Discord.

`PATCH` takes pointer-typed fields so "not mentioned" and "set to false" are
distinguishable — the panel's three toggles each send one key.

### Upload validation

An upload is accepted only when **all** of these hold:

1. The directory holds fewer than 100 assets (counted per file, so a batch
   that would cross the line is partially accepted and the rest reported in
   `errors`).
2. The part is at most 8 MiB. Enforced with `io.LimitReader(part, 8 MiB+1)`
   over a streamed `MultipartReader` — the request is never buffered whole,
   so a 2 GiB body costs 8 MiB of reading and then a `413`.
3. The **extension** is a known stinger type (`.png .jpg .jpeg .gif .webp` /
   `.mp3 .ogg .wav`).
4. `http.DetectContentType` on the first 512 bytes **agrees with the
   extension's category**. A `.png` whose bytes sniff as audio is rejected; so
   is a `.png` that sniffs as `text/html` — which is the case that matters,
   because an HTML file served from the relay's own origin under a
   `<img src>`-shaped URL is the classic stored-XSS shape. Category agreement
   (image-vs-audio), not exact-type equality, because `.wav` sniffs as
   `audio/wave` and `.ogg` sniffs as `application/ogg`.
5. The filename sanitizes to something non-empty. The **client-supplied name is
   never used as a path**: it is reduced to its base name, lowercased in its
   extension, stripped to `[A-Za-z0-9._ -]`, collapsed, capped at 64
   characters, and suffixed with `-2`, `-3`, … on collision. A name that
   sanitizes to nothing gets a generated one.

Files land via `os.CreateTemp` in the same directory and are renamed into
place only after the sniff passes and the whole body is read, so a rejected or
truncated upload never leaves a visible half-file.

### Traversal safety

Every name-taking endpoint (`GET /stingers/{name}`, `PATCH`, `DELETE`) runs
the same gate that already protected serving: a name containing `/`, `\`, or
equal to `.` / `..` is rejected outright, and the name must appear in a fresh
directory listing before anything opens or unlinks it. Go's `net/http` has
already percent-decoded the path segment by then, so `..%2F` and `../` are the
same string at this point and both fail the separator check.

---

## 4. Choosing what plays when

`Pick(moment)` draws the image and the audio **independently** from two pools:

```
images = { a | a.type == image ∧ a.enabled ∧ a.playOnStart }   (moment = start)
audios = { a | a.type == audio ∧ a.enabled ∧ a.playOnStop  }   (moment = stop)
```

An empty pool contributes nothing: an all-image directory yields a silent
stinger, an all-audio one yields a sound with no picture, and if both pools
are empty `Pick` returns `nil` and no stinger message is broadcast at all.
Turning `enabled` off for every asset is therefore a complete off switch that
needs no separate flag.

---

## 5. The manual trigger

`stinger_play` is a client → server control:

```json
{ "type": "stinger_play", "data": { "image": "wow.webp", "audio": "airhorn.mp3" } }
```

Either field may be omitted (a picture with no sound, or the reverse). The
server resolves both names against the store **before** touching the relay,
then calls `Room.PlayStinger`, which broadcasts the ordinary `stinger` control
with `kind: "manual"` — so the client's existing overlay plays it with no new
client-side machinery. A dice button in the panel sends nothing and lets the
server pick (`{"random": true}`).

**Cooldown.** Three seconds per client, enforced exactly like the keyframe
budget: a `lastStingerAsk time.Time` on `Client`, guarded by `Room.mu`, read
and written inside `PlayStinger`. Zero-value means "never asked", and
`now.Sub(zero)` is enormous, so the first request always passes without a
special case. A request inside the window is dropped silently — there is no
error control, because the only thing a client could do with one is retry.

**Lock discipline** (the part that must not regress):

- `Hub.Stinger` stays a **pure pick**. It is still called under `Room.mu` from
  `stingerStartLocked` / the delayed-stop timer, and it still does nothing but
  read the store and choose. Filtering by flags happens inside the store's
  `Pick`; it reads the directory and the settings file and touches no relay
  state.
- `PlayStinger` is a public entry point shaped like `RequestKeyframeFrom`: it
  takes `Room.mu`, checks membership (a departed client must not be able to
  fire into a room), checks the budget, broadcasts, and returns. It never
  takes `Hub.mu`, so the `Hub.mu → Room.mu` order is untouched.
- Every send inside is `enqueueControl`, which is non-blocking and never
  closes a channel — holding `Room.mu` across the fan-out stays cheap.
- Name resolution (`Store.List`) happens in `internal/server`, outside every
  relay lock. It is a `ReadDir` of a ≤100-entry directory; the WebSocket read
  loop is serial per connection, so a single client cannot parallelize it.

---

## 6. The panel

A drawer over the sidebar (never over the video — § "The stage is sacred" in
`design.md`), opened from a footer button, containing:

- a **drop zone** that takes drag-and-drop and a file input,
- an **image grid** with thumbnails and an **audio list** with a local preview
  button (preview is `new Audio()` in the operator's own tab; it does not
  touch the room),
- per asset: **Start** / **Stop** / **On** toggles, a **play-to-room** button,
  and a delete with an inline confirm,
- a **dice** button that asks the server for a random pair.

Everything is built from existing crayon components — `.crayon-btn`, the
`.seg` toggle idiom, `.share-card`'s paper, `.error-text` — plus one new
section of `theme.css` scoped under `.stinger-panel`.

---

## 7. Environment

| Variable | Meaning |
| --- | --- |
| `JANJACAST_STINGER_DIR` | Directory of stinger assets. Unset = the whole feature is off: no `/stingers/` route, no `/api/stingers` routes, no `Hub.Stinger`, and the panel button is hidden. |

The directory is created if missing so a fresh bind mount works on first
boot, and the panel is the supported way to fill it.

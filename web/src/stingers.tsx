// The Stingers panel: upload, curate and fire the meme images and sounds the
// room plays when a stream starts or stops.
//
// It is a drawer over the SIDEBAR side, never over the video (docs/design.md
// § "The stage is sacred"). Every mutating request carries the same
// credential the WebSocket join carries, and every asset URL goes through
// apiPath() so it picks up Discord's /.proxy prefix.

import {
  createSignal,
  createMemo,
  onCleanup,
  onMount,
  For,
  Show,
  type Component,
} from "solid-js";
import { apiPath } from "./discord";
import type { StingerAsset, StingerListData } from "./protocol";
import { BoomDoodle, DiceDoodle } from "./doodles";

export interface StingerPanelProps {
  /** Discord access token (or share token). Absent on anonymous dev servers,
   *  where the server skips the check entirely. */
  token?: string;
  onClose: () => void;
  /** Fire a stinger at the whole room. Omit both names for a random pick. */
  onPlay: (opts: { image?: string; audio?: string; random?: boolean }) => void;
}

const KB = 1024;
const fmtSize = (n: number) =>
  n >= KB * KB ? `${(n / (KB * KB)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / KB))} KB`;

export const StingerPanel: Component<StingerPanelProps> = (props) => {
  const [assets, setAssets] = createSignal<StingerAsset[]>([]);
  const [limits, setLimits] = createSignal({ max: 100, maxBytes: 8 << 20 });
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [dragging, setDragging] = createSignal(false);
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [previewing, setPreviewing] = createSignal<string | null>(null);

  let fileInput!: HTMLInputElement;
  let preview: HTMLAudioElement | null = null;

  const auth = (): HeadersInit =>
    props.token ? { Authorization: `Bearer ${props.token}` } : {};

  const images = createMemo(() => assets().filter((a) => a.type === "image"));
  const audios = createMemo(() => assets().filter((a) => a.type === "audio"));

  /** Re-read the folder. `keepError` is for the callers that have just put a
   *  message on screen (a rejected upload, a failed toggle): a successful
   *  list must not wipe the very explanation the user needs to read. */
  const refresh = async (keepError = false) => {
    try {
      const resp = await fetch(apiPath("/api/stingers"), { headers: auth() });
      if (!resp.ok) throw new Error(`couldn't read the folder (${resp.status})`);
      const data = (await resp.json()) as StingerListData;
      setAssets(data.assets ?? []);
      setLimits({ max: data.max, maxBytes: data.maxBytes });
      if (!keepError) setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  onMount(() => void refresh());

  // Escape closes the drawer. Registered here rather than in App so the
  // handler dies with the panel.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      props.onClose();
    }
  };
  document.addEventListener("keydown", onKey);

  const stopPreview = () => {
    preview?.pause();
    preview = null;
    setPreviewing(null);
  };
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    stopPreview();
  });

  /** Local audition — plays in this tab only, never at the room. */
  const togglePreview = (a: StingerAsset) => {
    if (previewing() === a.name) {
      stopPreview();
      return;
    }
    stopPreview();
    const audio = new Audio(apiPath(a.url));
    audio.volume = 0.8;
    audio.onended = () => setPreviewing((n) => (n === a.name ? null : n));
    preview = audio;
    setPreviewing(a.name);
    audio.play().catch(() => stopPreview());
  };

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (list.length === 0) return;
    const tooBig = list.filter((f) => f.size > limits().maxBytes);
    const send = list.filter((f) => f.size <= limits().maxBytes);
    setBusy(true);
    // Refused here rather than at the server so an 8 MiB ceiling costs one
    // glance instead of an 8 MiB upload.
    setError(
      tooBig.length > 0
        ? `⛔ ${tooBig.map((f) => f.name).join(", ")} — bigger than ${fmtSize(limits().maxBytes)}.`
        : null,
    );
    try {
      if (send.length > 0) {
        const form = new FormData();
        for (const f of send) form.append("file", f, f.name);
        const resp = await fetch(apiPath("/api/stingers"), {
          method: "POST",
          headers: auth(), // no Content-Type: the browser sets the boundary
          body: form,
        });
        const data = (await resp.json().catch(() => null)) as {
          errors?: { name: string; error: string }[];
        } | null;
        const rejected = data?.errors ?? [];
        if (!resp.ok && rejected.length === 0) {
          throw new Error(`upload refused (${resp.status})`);
        }
        if (rejected.length > 0) {
          const mine = error();
          setError(
            [mine, `⛔ ${rejected.map((r) => `${r.name}: ${r.error}`).join(" · ")}`]
              .filter(Boolean)
              .join(" "),
          );
        }
      }
      await refresh(error() != null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const patch = async (a: StingerAsset, body: Record<string, boolean>) => {
    // Optimistic: the toggle answers the click, and a failure re-reads the
    // truth from the server rather than leaving a lie on screen.
    setAssets((list) =>
      list.map((x) => (x.name === a.name ? { ...x, ...body } : x)),
    );
    try {
      const resp = await fetch(
        apiPath(`/api/stingers/${encodeURIComponent(a.name)}`),
        {
          method: "PATCH",
          headers: { ...auth(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!resp.ok) throw new Error(`couldn't save that (${resp.status})`);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh(true); // the truth from the server, but keep the reason
    }
  };

  const remove = async (a: StingerAsset) => {
    setConfirming(null);
    if (previewing() === a.name) stopPreview();
    try {
      const resp = await fetch(
        apiPath(`/api/stingers/${encodeURIComponent(a.name)}`),
        { method: "DELETE", headers: auth() },
      );
      if (!resp.ok && resp.status !== 404) {
        throw new Error(`couldn't delete that (${resp.status})`);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await refresh(error() != null);
  };

  /** The three independent switches every asset carries. Not a segmented
   *  control: these are three toggles, not a choice between three options. */
  const Flags: Component<{ a: StingerAsset }> = (f) => (
    <div class="stinger-flags">
      <button
        type="button"
        class="stinger-chip"
        aria-pressed={f.a.playOnStart}
        title="Play when a stream starts"
        onClick={() => void patch(f.a, { playOnStart: !f.a.playOnStart })}
      >
        start
      </button>
      <button
        type="button"
        class="stinger-chip"
        aria-pressed={f.a.playOnStop}
        title="Play when a stream stops"
        onClick={() => void patch(f.a, { playOnStop: !f.a.playOnStop })}
      >
        stop
      </button>
      <button
        type="button"
        class="stinger-chip stinger-chip--on"
        aria-pressed={f.a.enabled}
        title="Use this one at all"
        onClick={() => void patch(f.a, { enabled: !f.a.enabled })}
      >
        on
      </button>
    </div>
  );

  /** Play-to-room and delete, with the delete confirm taking over the row. */
  const RowActions: Component<{ a: StingerAsset }> = (f) => (
    <Show
      when={confirming() === f.a.name}
      fallback={
        <div class="stinger-row-actions">
          <button
            type="button"
            class="stinger-act"
            title="Play this at the whole room"
            onClick={() =>
              props.onPlay(
                f.a.type === "image" ? { image: f.a.name } : { audio: f.a.name },
              )
            }
          >
            📣<span class="stinger-act-label">room</span>
          </button>
          <button
            type="button"
            class="stinger-act stinger-act--danger"
            title={`Delete ${f.a.name}`}
            onClick={() => setConfirming(f.a.name)}
          >
            ✕<span class="stinger-act-label">delete</span>
          </button>
        </div>
      }
    >
      <div class="stinger-row-actions stinger-confirm">
        <span class="stinger-confirm-msg">Delete it?</span>
        <button
          type="button"
          class="stinger-act stinger-act--danger"
          onClick={() => void remove(f.a)}
        >
          yes
        </button>
        <button
          type="button"
          class="stinger-act"
          onClick={() => setConfirming(null)}
        >
          no
        </button>
      </div>
    </Show>
  );

  return (
    <aside class="stinger-drawer" role="dialog" aria-label="Stingers">
      <header class="stinger-head">
        <BoomDoodle class="stinger-head-icon" />
        <h4 class="stinger-title">
          <span class="u-scribble u-scribble--pink">Stingers</span>
        </h4>
        <button
          type="button"
          class="stinger-close"
          aria-label="Close stingers"
          onClick={props.onClose}
        >
          ✕
        </button>
      </header>

      <div class="stinger-body">
        <div
          class={dragging() ? "stinger-drop stinger-drop--over" : "stinger-drop"}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer?.files) void upload(e.dataTransfer.files);
          }}
        >
          <p class="stinger-drop-msg">
            {dragging() ? "Let go!" : "Drop pictures and sounds here"}
          </p>
          <button
            type="button"
            class="crayon-btn crayon-btn--chalk stinger-choose"
            disabled={busy()}
            onClick={() => fileInput.click()}
          >
            {busy() ? "Uploading…" : "Choose files"}
          </button>
          <input
            ref={fileInput}
            class="stinger-file"
            type="file"
            multiple
            accept="image/png,image/jpeg,image/gif,image/webp,audio/mpeg,audio/ogg,audio/wav,.png,.jpg,.jpeg,.gif,.webp,.mp3,.ogg,.wav"
            onChange={(e) => {
              const files = e.currentTarget.files;
              if (files) void upload(files);
              e.currentTarget.value = ""; // same file twice must re-fire
            }}
          />
          <p class="stinger-hint">
            png jpg gif webp · mp3 ogg wav · up to {fmtSize(limits().maxBytes)} each
            {assets().length > 0 ? ` · ${assets().length}/${limits().max} used` : ""}
          </p>
        </div>

        <button
          type="button"
          class="crayon-btn stinger-dice"
          disabled={assets().length === 0}
          onClick={() => props.onPlay({ random: true })}
        >
          <DiceDoodle class="stinger-dice-icon" />
          Surprise the room
        </button>

        <Show when={error()}>
          <p class="error-text stinger-error">{error()}</p>
        </Show>

        <Show
          when={!loading()}
          fallback={<p class="stinger-empty">Opening the crayon box…</p>}
        >
          <Show when={assets().length === 0}>
            <p class="stinger-empty">
              Nothing in here yet. Drop a meme and an airhorn in and the whole
              room gets them.
            </p>
          </Show>

          <Show when={images().length > 0}>
            <h5 class="stinger-group">Pictures ({images().length})</h5>
            <div class="stinger-grid">
              <For each={images()}>
                {(a) => (
                  <figure
                    class={
                      a.enabled ? "stinger-tile" : "stinger-tile stinger-tile--off"
                    }
                  >
                    <img
                      class="stinger-thumb"
                      src={apiPath(a.url)}
                      alt=""
                      loading="lazy"
                    />
                    <figcaption class="stinger-name" title={a.name}>
                      {a.name}
                    </figcaption>
                    <span class="stinger-size">{fmtSize(a.size)}</span>
                    <Flags a={a} />
                    <RowActions a={a} />
                  </figure>
                )}
              </For>
            </div>
          </Show>

          <Show when={audios().length > 0}>
            <h5 class="stinger-group">Sounds ({audios().length})</h5>
            <ul class="stinger-list">
              <For each={audios()}>
                {(a) => (
                  <li
                    class={
                      a.enabled ? "stinger-row" : "stinger-row stinger-row--off"
                    }
                  >
                    <button
                      type="button"
                      class="stinger-preview"
                      aria-pressed={previewing() === a.name}
                      title={
                        previewing() === a.name
                          ? "Stop the preview"
                          : "Listen here only (nobody else hears it)"
                      }
                      onClick={() => togglePreview(a)}
                    >
                      {previewing() === a.name ? "■" : "▶"}
                    </button>
                    <span class="stinger-name" title={a.name}>
                      {a.name}
                    </span>
                    <span class="stinger-size">{fmtSize(a.size)}</span>
                    <Flags a={a} />
                    <RowActions a={a} />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </aside>
  );
};

export default StingerPanel;

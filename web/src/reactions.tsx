import { createEffect, createMemo, createSignal } from "solid-js";
import { ReactionEmojis, type ReactionEmoji, type ReactionBurstData } from "./protocol";
import { t } from "./i18n";
import type { Session } from "./session";

// Edge-pinned reaction bar, hype meter and float-sprite layer. Everything
// lives INSIDE .stage so absolute positions are stage-relative, and nothing
// ever spawns over the center safe-zone — sprites hug the side gutters.

export function ReactionBar(props: { session: () => Session | null }) {
  const [density, setDensity] = createSignal(0);
  let floatLayer: HTMLDivElement | undefined;

  // The session arrives after mount (identity setup is async), so the
  // listener is wired reactively — a bare read at component creation would
  // leave the bar deaf forever.
  createEffect(() => {
    const s = props.session();
    if (!s) return;
    s.onReactionBurst = (d) => {
      setDensity(d.density ?? 0);
      if (floatLayer) spawnSprites(floatLayer, d as ReactionBurstData);
    };
  });

  const send = (e: ReactionEmoji) => props.session()?.sendReaction(e);

  const hype = createMemo(() => {
    const d = density();
    if (d >= 15) return t("reactions.hype.storm");
    if (d >= 6) return t("reactions.hype.warm");
    return t("reactions.hype.calm");
  });

  return (
    <>
      <div class="reaction-float" ref={floatLayer} aria-hidden="true" />
      <div class="reaction-ui">
        <div class="reaction-bar" role="group" aria-label={t("reactions.bar.label")}>
          {ReactionEmojis.map((e) => (
            <button
              type="button"
              class="reaction-btn"
              aria-label={t(`reactions.aria.${e}` as never)}
              onClick={() => send(e)}
            >
              <span class={`rx rx-${e}`} aria-hidden="true">{emojiChar(e)}</span>
            </button>
          ))}
        </div>
        <HypeMeter
          value={density()}
          label={hype()}
          publisher={Boolean(props.session()?.isPublisher())}
        />
      </div>
    </>
  );
}

function HypeMeter(props: { value: number; label: string; publisher: boolean }) {
  return (
    <div class={`hype ${props.publisher ? "hype--pub" : ""}`}>
      <div class="hype-gauge" style={{ "--val": String(Math.min(props.value, 20)) }} />
      <span class="hype-label">{props.label}</span>
    </div>
  );
}

// Simple crayon emoji glyphs; doodles.tsx could house custom SVG later.
function emojiChar(e: ReactionEmoji): string {
  switch (e) {
    case "fire": return "🔥";
    case "laugh": return "😂";
    case "heart": return "❤️";
    case "skull": return "💀";
    case "clap": return "👏";
    case "shock": return "😱";
  }
}

/** Spawn rising sprites in the two side gutters of the stage (never the
 *  center band). Positions are percentages of the layer itself, so this
 *  needs no viewport math and survives fullscreen/theater. */
function spawnSprites(layer: HTMLDivElement, d: ReactionBurstData) {
  const cap = 12;
  for (const [e, n] of Object.entries(d.counts)) {
    for (let i = 0; i < Math.min(n, cap); i++) {
      const el = document.createElement("div");
      el.className = `rx-float rx-${e}`;
      el.textContent = emojiChar(e as ReactionEmoji);
      const side = Math.random() < 0.5 ? "left" : "right";
      el.style.setProperty(side, `${2 + Math.random() * 6}%`);
      el.style.top = `${65 + Math.random() * 20}%`;
      el.style.animationDelay = `${Math.random() * 0.2}s`;
      el.addEventListener("animationend", () => el.remove());
      layer.appendChild(el);
    }
  }
}

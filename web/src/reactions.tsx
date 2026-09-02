import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { ReactionEmojis, type ReactionEmoji, type ReactionBurstData } from "./protocol";
import { t } from "./i18n";
import { Session } from "./session";

// Edge-pinned reaction bar and float sprites layer. No center overlay.

export function ReactionBar() {
  const s = (window as any)._jcSession as Session | undefined; // fallback binding set in App
  const [density, setDensity] = createSignal(0);
  const [lastBurst, setLastBurst] = createSignal<ReactionBurstData | null>(null);

  // Wire WS control listener.
  if (s) {
    s.onReactionBurst = (d) => { setLastBurst(d as any); setDensity((d as any).density ?? 0); spawnSprites(d as any); };
  }

  const send = (e: ReactionEmoji) => {
    // private send hook: same shape Session uses internally
    (s as any)?.sendControl?.("reaction", { emoji: e });
  };

  const hype = createMemo(() => {
    const d = density();
    if (d >= 15) return t("reactions.hype.storm");
    if (d >= 6) return t("reactions.hype.warm");
    return t("reactions.hype.calm");
  });

  return (
    <div class="reaction-ui">
      <div class="reaction-bar" role="group" aria-label={t("reactions.bar.label")}> 
        {ReactionEmojis.map((e) => (
          <button type="button" class="seg-btn reaction-btn" aria-label={t(`reactions.aria.${e}` as any)} onClick={() => send(e)}>
            <span class={`rx rx-${e}`} aria-hidden="true">{emojiChar(e)}</span>
          </button>
        ))}
      </div>
      <HypeMeter value={density()} label={hype()} publisher={Boolean(s?.isPublisher())} />
      <div class="reaction-float" aria-hidden="true" />
    </div>
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

// Spawn float sprites along edges; capped per burst.
function spawnSprites(d: ReactionBurstData) {
  const layer = document.querySelector(".reaction-float");
  if (!layer) return;
  const rect = (document.querySelector(".stage-scene, .stage-canvas") as HTMLElement) || document.body;
  const safe = rect.getBoundingClientRect();
  const cap = 12;
  const entries = Object.entries(d.counts);
  for (const [e, n] of entries) {
    const count = Math.min(n, cap);
    for (let i = 0; i < count; i++) {
      const el = document.createElement("div");
      el.className = `rx-float rx-${e}`;
      el.textContent = emojiChar(e as ReactionEmoji);
      // Edge: left or right; avoid center band horizontally.
      const side = Math.random() < 0.5 ? "left" : "right";
      const y = safe.bottom - 20 + Math.random() * 10;
      el.style.setProperty(side, "8px");
      el.style.setProperty("top", `${y}px`);
      el.style.animationDelay = `${Math.random() * 0.2}s`;
      el.addEventListener("animationend", () => el.remove());
      layer.appendChild(el);
    }
  }
}

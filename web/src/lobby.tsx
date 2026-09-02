import { Show, type Component } from "solid-js";
import { t } from "./i18n";
import { SceneTv } from "./doodles";
import { Session } from "./session";

const Lobby: Component<{ session: Session | null; canCapture?: boolean; onShare?: () => void }> = (props) => {
  const count = () => props.session?.participants().participants.length ?? 0;
  const alone = () => count() <= 1;
  return (
    <div class="lobby">
      <div class="scene">
        <SceneTv class="scene-tv scene-tv--off" />
      </div>
      <div class="lobby-copy">
        <h2 class="lobby-title">{t("lobby.title")}</h2>
        <p class="lobby-sub">{t("lobby.subtitle")}</p>
        <p class="lobby-count">
          <Show when={!alone()} fallback={<span>{t("lobby.alone")}</span>}>
            <span>{t("lobby.here", { count: count() })}</span>
          </Show>
        </p>
        <Show when={props.canCapture !== false}>
          <button type="button" class="primary" onClick={() => props.onShare?.()}>
            {t("lobby.cta")}
          </button>
        </Show>
      </div>
    </div>
  );
};

export default Lobby;

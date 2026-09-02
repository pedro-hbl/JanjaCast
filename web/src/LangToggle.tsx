// The manual language override: EN | PT.
//
// It is a two-option choice, so it is the segmented control and nothing else
// (docs/design.md § 5.2) — the state lives in `aria-pressed`, the pressed
// fill is the chrome blue, and there is no `.is-active` class for the visual
// and accessible states to drift apart on.
//
// It appears twice: pinned to the right of the Activity header, and in the
// top-left corner of the /share sheet (opposite the sun). Both are the same
// component with a placement class.

import { For, type Component } from "solid-js";
import { LOCALES, locale, setLocale, t, type Locale, type MessageKey } from "./i18n";

/** Two labels per locale: the two letters on the crayon, and the language's
 *  own name for the tooltip and the accessible name. */
const shortKey: Record<Locale, MessageKey> = {
  en: "lang.en",
  "pt-BR": "lang.pt",
};
const fullKey: Record<Locale, MessageKey> = {
  en: "lang.en.full",
  "pt-BR": "lang.pt.full",
};

export const LangToggle: Component<{ class?: string }> = (props) => (
  <div
    class={props.class ? `seg lang-seg ${props.class}` : "seg lang-seg"}
    role="group"
    aria-label={t("lang.label")}
  >
    <For each={LOCALES}>
      {(l) => (
        <button
          type="button"
          class="seg-btn"
          aria-pressed={locale() === l}
          /* the two visible letters are an abbreviation; the accessible name
             is the language's own name, so a screen reader says "English"
             rather than spelling "E N" */
          aria-label={t(fullKey[l])}
          title={t(fullKey[l])}
          onClick={() => setLocale(l)}
        >
          {t(shortKey[l])}
        </button>
      )}
    </For>
  </div>
);

export default LangToggle;

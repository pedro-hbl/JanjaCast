// JanjaCast localization — en-US + pt-BR.
//
// No dependencies beyond Solid: the Activity's CSP forbids fetching anything,
// and an i18n library would be several times the size of the dictionary it
// carries. Both locales ship in the bundle (~6 KB) and switch instantly.
//
// The terminology decisions — which pt-BR word, and why that one rather than
// the literal translation — are in docs/i18n.md. The short version: this is a
// Discord Activity for Brazilian voice-call regulars, so the vocabulary
// follows Discord's own pt-BR client ("compartilhar tela", "transmissão",
// "canal de voz", "tela cheia", "AO VIVO") while the *register* follows how
// those people actually talk ("call", "tá ao vivo", "bora").
//
// Adding a locale: add the tag to `Locale`, add a plural rule, add one more
// dictionary. TypeScript will then refuse to build until every key is
// translated — that is the point of typing the maps off `en`.

import { createSignal } from "solid-js";

export type Locale = "en" | "pt-BR";

/** Order matters: it is the order of the EN | PT segmented toggle. */
export const LOCALES: readonly Locale[] = ["en", "pt-BR"];

const STORAGE_KEY = "jc-lang";

/** A message that changes shape with a count. `zero` is optional and wins
 *  over the plural rule when it is present and count is 0. */
interface PluralMessage {
  zero?: string;
  one: string;
  other: string;
}

type Message = string | PluralMessage;

/**
 * Plural categories, per locale. English and Brazilian Portuguese genuinely
 * differ here: CLDR's `pt` puts i = 0..1 in the `one` bucket, so Portuguese
 * says "0 pessoa" where English says "0 people". Anything that interpolates
 * a count therefore cannot reuse the English branch.
 */
const pluralRule: Record<Locale, (n: number) => "one" | "other"> = {
  en: (n) => (n === 1 ? "one" : "other"),
  "pt-BR": (n) => (n >= 0 && n < 2 ? "one" : "other"),
};

/* ------------------------------------------------------------------ */
/* en-US — the source strings. Every other dictionary is typed off it. */
/* ------------------------------------------------------------------ */

const en = {
  // --- the locale toggle itself ------------------------------------
  "lang.label": "Language",
  "lang.en": "EN",
  "lang.pt": "PT",
  "lang.en.full": "English",
  "lang.pt.full": "Português (Brasil)",

  // --- transport state (tooltip + screen reader, never shouted) ----
  "conn.open": "open",
  "conn.connecting": "connecting",
  "conn.reconnecting": "reconnecting",
  "conn.closed": "closed",
  "conn.unauthorized": "unauthorized",
  "conn.superseded": "superseded",
  "conn.starting": "starting",
  "conn.sr": "Connection {status}",

  // --- Activity header --------------------------------------------
  "header.onAir": "On air",

  // --- the stage ---------------------------------------------------
  "stage.waiting": "Waiting for the picture…",
  "stage.liveHere": "🎥 You are live at {fps} fps.",
  "stage.liveTab": "🎥 You are live at {fps} fps from your browser tab.",
  "stage.zoomTitle": "Scroll to zoom · drag to pan",
  "stage.fsTitle": "Fullscreen · F (T for theater mode)",
  "stage.shareScreen": "Share screen",
  "stage.companionOpen": "Start sharing in the new tab.",
  "stage.companionOpening": "Opening the sharing tab…",
  "stage.companionLate": "Tab didn't open? Open again.",
  "stage.companionFailed": "The tab didn't open.",
  "stage.openAgain": "Open again",

  // --- privacy blank (the panic button) ----------------------------
  // Sharer-side labels are full verbs — this is a control somebody presses
  // in a hurry, and docs/i18n.md § 3 keeps buttons out of "tá" territory.
  // The card the room sees is the one place the app speaks *to* the
  // viewers, so it gets the spoken phrase.
  "blank.button.on": "Blank now",
  "blank.button.off": "Back on",
  "blank.card.title": "Back in a sec",
  "blank.hotkey.hint": "Hotkey: Ctrl+Shift+B",
  "blank.badge.blanked": "Hidden",

  // --- cinema mode (lights out) ------------------------------------
  "cinema.toggle": "Lights off",
  "cinema.toggleTitle":
    "Dim everything around the picture; the controls fade after 3 s of stillness. Move the mouse, or press H, to bring them back.",

  // --- roster ------------------------------------------------------
  // Deliberately count-agnostic in both languages, so the scribble
  // underline never changes length when somebody joins (design.md § 5.5).
  "roster.inRoom": "in the room",
  "roster.sharing": "sharing",
  "roster.you": "you",

  // --- footer ------------------------------------------------------
  "footer.takeStage": "Take the stage",
  "footer.stopSharing": "Stop sharing",
  "footer.framerate": "Framerate",
  "footer.volume": "🎧 Volume",
  "footer.volumeTitle":
    "On speakers, your mic feeds the stream back into the call — headphones avoid it.",
  "footer.stingerVolumeTitle": "How loud the vinhetas play for you (yours alone)",
  "footer.stingers": "🎺 Stingers",
  "footer.stingersTitle": "Add, curate and fire the room's stingers",

  // --- cinema pause + shared doodles ---------------------------------
  "cinema.pause": "Pause for everyone",
  "cinema.resume": "Resume",
  "cinema.interval": "INTERMISSION 🍿",
  "cinema.canvasTitle": "Group scribbles",
  "cinema.undo": "Undo",
  "cinema.colorRed": "red",
  "cinema.colorBlue": "blue",
  "cinema.colorYellow": "yellow",
  "cinema.colorGrass": "green",
  "cinema.colorPink": "pink",
  "cinema.colorPurple": "purple",

  // --- the stage queue ("pedir a vez") -----------------------------
  // The line is the feature; rodízio is the clock layered on top of it.
  // Informal where the app narrates ("it's yours!"), full verbs on every
  // control — docs/i18n.md § 3.
  "queue.title": "Up next",
  "queue.request": "Ask for a turn",
  "queue.withdraw": "Leave the line",
  "queue.pass": "Pass it on",
  "queue.empty": "Nobody in line yet.",
  "queue.position": "{name} — #{n} in line",
  "queue.chipTitle": "{name} is waiting",
  "queue.modeLabel": "Turns",
  "queue.modeLivre": "Free",
  "queue.modeRodizio": "Rodízio",
  "queue.modeTitle":
    "Free: hand the stage on whenever. Rodízio: 20 minutes each, and the app asks who is next.",

  // The call itself — the moment the whole room hears the cue.
  "telinha.badge": "telinha â a few seconds behind",
  "telinha.waiting": "Tuning the little screenâ¦",
  "telinha.noToken": "This link is missing its ticket â open the telinha from the Activity.",
  "telinha.mute": "Mute",
  "telinha.unmute": "Sound on",
  "telinha.open": "Telinha",
  "turn.warmup": "🔥 Warming up — you're next!",
  "turn.yours": "It's yours!",
  // Careful not to promise the stage is empty: a turn survives somebody else
  // grabbing the stage mid-call, and taking it from them is exactly what the
  // turn authorises. So the line says what to DO, not what the stage is.
  "turn.yoursBody": "Go on — take the stage before the {s}s run out.",
  "turn.take": "Take the stage",
  "turn.pill": "Yours for {s}s",
  "turn.someone": "🎤 {name} is up next.",
  "turn.wheel": "🎡 The wheel picked {name}!",
  "turn.missed": "⏱ Nobody took it — moving on.",

  // Rodízio clock, in the companion tab.
  "rodizio.left": "{m}m {s}s left",
  "rodizio.oneMinute": "⏰ One minute left on stage.",
  "rodizio.upTitle": "Your turn's up!",
  "rodizio.upBody":
    "That flew by, huh? Pass it on, or grab five more minutes.",
  "rodizio.extend": "+5 min",

  // --- errors ------------------------------------------------------
  "err.tookStage": "✋ {name} took the stage.",
  "err.superseded":
    "Opened elsewhere — this view is disconnected. Close and reopen the Activity here to take over.",
  "err.shareToken": "Share token refused ({status}).",
  // Server refusals. The key is `err.` + the code in ErrorData.Code.
  "err.stage.noNext": "⛔ Nobody to hand it to — get someone in line first.",
  "err.stage.extended": "⛔ You already took your +5.",
  "err.stage.cooldown": "⛔ Hold on a second before passing again.",
  "err.cinema.notPublisher": "⛔ Only the person sharing can pause.",
  "err.cinema.rateLimited": "⛔ Easy! You're drawing too fast.",
  "err.cinema.badStroke": "⛔ That stroke didn't go through — try a shorter one.",
  "err.assist.cooldown": "⛔ Hold on — wait a moment before pointing again.",
  "err.assist.bounds": "⛔ That point is off-screen.",

  // --- takeover modal ----------------------------------------------
  "modal.kick": "✋ Kick {name} off the stage?",
  "modal.yes": "Yeah, my turn",
  "modal.no": "Never mind",

  // --- /share page -------------------------------------------------
  "share.sub": "screen sharing",
  "share.room": "Room",
  "share.connection": "connection",
  "share.expired":
    "⛔ Session expired — go back to Discord and click Share screen again.",
  "share.notConnected":
    "⚠ Not connected — nobody can see your screen right now. Reconnecting…",
  "share.replaced":
    "This share was replaced by a newer sharing tab — you can close this one.",
  "share.start": "Start sharing",
  "share.hint":
    "Pick the screen, window, or tab to stream. Keep this tab open while sharing — everyone in the Discord call watches through the Activity.",
  "share.advanced": "Advanced",
  "share.optimize": "Optimize for",
  "share.opt.auto": "✨ Automatic (recommended)",
  "share.opt.text": "📖 Text (code, slides)",
  "share.opt.motion": "🎮 Motion (games, video)",
  "share.sound": "Sound",
  "share.snd.app": "🎵 App sound — no call echo (recommended)",
  "share.snd.system": "🔊 Whole-screen sound (echo-prone!)",
  "share.snd.none": "🔇 No sound",
  "share.sndHint.app":
    "Pick a window or a browser tab — only that app's sound is shared, so the Discord call is never re-broadcast.",
  "share.sndHint.system":
    "⚠ Shares everything on your speakers, INCLUDING the Discord call — everyone will hear themselves unless Discord uses a different output device (Windows: Settings → Sound → Volume mixer → Discord → Output).",
  "share.sndHint.none": "Video only; the voice call carries the commentary.",
  "share.liveLine": "Live at {fps} fps — {realFps} fps · {kbps} kbps (target {target})",
  "share.watching": {
    zero: "nobody watching",
    one: "{count} watching",
    other: "{count} watching",
  } as Message,
  "share.upload": "total upload ≈ {mbps} Mbps",
  "share.overBudget": " ⚠ over your egress budget",
  "share.minimize": "You can minimize this tab; the stream keeps running.",

  // --- stingers drawer ---------------------------------------------
  "st.title": "Stingers",
  "st.close": "Close stingers",
  "st.dropLetGo": "Let go!",
  "st.drop": "Drop pictures and sounds here",
  "st.uploading": "Uploading…",
  "st.choose": "Choose files",
  "st.formats": "png jpg gif webp · mp3 ogg wav · up to {size} each",
  "st.used": " · {used}/{max} used",
  "st.dice": "Surprise the room",
  "st.loading": "Opening the crayon box…",
  "st.empty":
    "Nothing in here yet. Drop a meme and an airhorn in and the whole room gets them.",
  "st.pictures": "Pictures ({count})",
  "st.sounds": "Sounds ({count})",
  "st.chipStart": "start",
  "st.chipStop": "stop",
  "st.chipOn": "on",
  "st.chipStartTitle": "Play when a stream starts",
  "st.chipStopTitle": "Play when a stream stops",
  "st.chipOnTitle": "Use this one at all",
  "st.room": "room",
  "st.roomTitle": "Play this at the whole room",
  "st.delete": "delete",
  "st.deleteTitle": "Delete {name}",
  "st.confirm": "Delete it?",
  "st.yes": "yes",
  "st.no": "no",
  "st.previewStop": "Stop the preview",
  "st.previewPlay": "Listen here only (nobody else hears it)",
  "st.tooBig": "⛔ {names} — bigger than {max}.",
  "st.errList": "couldn't read the folder ({status})",
  "st.errUpload": "upload refused ({status})",
  "st.errSave": "couldn't save that ({status})",
  "st.errDelete": "couldn't delete that ({status})",
  // placar
  "placar.create": "Create scoreboard",
  "placar.close": "Close scoreboard",
  "placar.modalTitle": "What are we counting?",
  "placar.placeholder": "e.g. times someone said 'like'",
  "placar.createBtn": "Create",
  "placar.cancel": "Never mind",
  "placar.charCount": "{count}/60",
  "placar.plus": "Add a point for {name}",
  "placar.minus": "Take a point from {name}",
  "error.placar.alreadyActive": "⛔ A scoreboard is already running — close it first.",
  "error.placar.tooFast": "⛔ One point per second — easy!",
  "error.placar.notPublisher": "⛔ Only the person sharing can do that.",
  // --- awards toast (Activity-side) ---------------------------------
  "awards.ready": "That's a wrap! The trophy ceremony is ready.",
  "awards.view": "See the trophies",
  "awards.dismiss": "Dismiss",
  // --- lobby --------------------------------------------------------
  "lobby.title": "The TV's off",
  "lobby.subtitle": "Nobody's sharing yet",
  "lobby.cta": "Turn on the TV",
  "lobby.here": { one: "{count} person here", other: "{count} people here" } as Message,
  "lobby.alone": "Just you for now",
  
  // --- instant clips -------------------------------------------------
  "assist.button": "Deixa comigo â point at the screen",
  "attn.title": "How many are really watching",
  "hat.title": "The slot is filling up â auto-pass when it brims",
  "multi.label": "Palcos",
  "corrente.pick": "Passar a Telaâ¦",
  "corrente.line": "â¡ {name} takes over in {s}s â speak now or cheer",
  "corrente.vai": "Vai!",
  "corrente.calma": "Calma!",
  "corrente.canceled": "The room said calma â handoff canceled.",
  "err.corrente.notPublisher": "â Only the person sharing can pass the screen.",
  "err.corrente.badTarget": "â Pick someone who's in the room.",
  "err.corrente.active": "â A handoff is already counting down.",
  "aposta.dare": "Bet against {name}",
  "aposta.against": "Betting against {name}:",
  "aposta.placeholder": "I bet that… (Enter sends, Esc cancels)",
  "aposta.accept": "Bora! (accept)",
  "aposta.decline": "Tô fora",
  "aposta.waiting": "Waiting on {name}…",
  "aposta.live": "Bet is ON — the streamer judges.",
  "aposta.judgeChallenger": "The challenger called it",
  "aposta.judgeTarget": "The challenged survives it",
  "aposta.won": "🏆 {name} takes it!",
  "aposta.declined": "Declined. No guts, no glory.",
  "aposta.expired": "Nobody answered — bet is off.",
  "err.aposta.cooldown": "⛔ One bet per breath — wait a moment.",
  "err.aposta.badTarget": "⛔ Pick someone in the room (not yourself).",
  "err.aposta.full": "⛔ Three live bets is plenty.",
  "err.aposta.notTarget": "⛔ Only the challenged answers.",
  "err.aposta.notJudge": "⛔ Only the streamer judges.",
  "replay.button": "Quem entrou? â replay the last stretch",
  "replay.title": "Who came in?",
  "replay.noJoins": "Nobody new in this stretch",
  "replay.quiet": "All quiet",
  "replay.heatLabel": "Hype over the last stretch",
  "replay.download": "Save the last 90s",
  "replay.close": "Close",
  "clip.button": "Clip that!",
  "clip.working": "Cutting the last 30s...",
  "clip.ready": "Clip's ready — grab it",
  "clip.download": "Download",
  "clip.cooldown": "Hang on a sec",
  "clip.expired": "That clip expired",
  
  // --- captions -------------------------------------------------------
  "caption.placeholder": "Type a caption and hit Enter",
  "caption.enable": "Enable captions",
  "caption.disable": "Disable captions",
  
  // --- jukebox --------------------------------------------------------
  "jukebox.title": "Jukebox",
  "jukebox.by": "requested by {name}",
  "jukebox.approve": "Approve",
  "jukebox.request_asset": "Request: {title}",
} satisfies Record<string, Message>;

export type MessageKey = keyof typeof en;

/* ------------------------------------------------------------------ */
/* pt-BR                                                               */
/* ------------------------------------------------------------------ */
/* Register: informal-but-not-sloppy. "call" and "aba" rather than
   "chamada de voz" and "guia", "tá" rather than "está" in the two places
   the app speaks *to* you, full verbs everywhere a person has to act.
   Terminology follows Discord's own pt-BR client. See docs/i18n.md. */

const ptBR: Record<MessageKey, Message> = {
  "lang.label": "Idioma",
  "lang.en": "EN",
  "lang.pt": "PT",
  "lang.en.full": "English",
  "lang.pt.full": "Português (Brasil)",

  "conn.open": "conectado",
  "conn.connecting": "conectando",
  "conn.reconnecting": "reconectando",
  "conn.closed": "desconectado",
  "conn.unauthorized": "sem autorização",
  "conn.superseded": "substituída",
  "conn.starting": "iniciando",
  "conn.sr": "Conexão: {status}",

  "header.onAir": "Ao vivo",

  "stage.waiting": "Esperando a imagem…",
  "stage.liveHere": "🎥 Você tá ao vivo a {fps} fps.",
  "stage.liveTab": "🎥 Você tá ao vivo a {fps} fps pela aba do navegador.",
  "stage.zoomTitle": "Role pra dar zoom · arraste pra mover",
  "stage.fsTitle": "Tela cheia · F (T pro modo cinema)",
  "stage.shareScreen": "Compartilhar tela",
  "stage.companionOpen": "Comece a transmitir na aba nova.",
  "stage.companionOpening": "Abrindo a aba de transmissão…",
  "stage.companionLate": "A aba não abriu? Abre de novo.",
  "stage.companionFailed": "A aba não abriu.",
  "stage.openAgain": "Abrir de novo",

  // "Sumir" is what a Brazilian actually says about vanishing on purpose
  // ("sumi da call"); "Ocultar tela" is what a settings dialog says. The
  // card keeps the sanctioned phrase "Voltamos já" — first person plural,
  // because the room is being addressed, not one viewer.
  "blank.button.on": "Sumir agora",
  "blank.button.off": "Voltar",
  "blank.card.title": "Voltamos já",
  "blank.hotkey.hint": "Atalho: Ctrl+Shift+B",
  "blank.badge.blanked": "Escondido",

  // "Luzes apagadas" over "Modo cinema": the Activity already spends
  // "modo cinema" on theater mode in stage.fsTitle, and two different
  // things must not share one name.
  "cinema.toggle": "Luzes apagadas",
  "cinema.toggleTitle":
    "Escurece tudo em volta da imagem; os controles somem depois de 3 s parado. Mexa o mouse, ou aperte H, pra trazer de volta.",

  "roster.inRoom": "na sala",
  // "transmitindo" is the exact verb and it is five characters too long: in
  // a 186px sidebar it pushes the tag onto its own line for almost every
  // name, and the tag is meant to read as the person's suffix (design.md
  // § 5.5). "ao vivo" is what Discord's own badge says about a member who
  // is streaming, matches the header badge word-for-word, and is exactly as
  // wide as English's "sharing".
  "roster.sharing": "ao vivo",
  "roster.you": "você",

  "footer.takeStage": "Assumir o palco",
  "footer.stopSharing": "Parar de transmitir",
  // Discord's own pt-BR stream settings say "Taxa de quadros". It is 6
  // characters longer than "Framerate"; the footer wraps rather than
  // truncates (see .app-footer { flex-wrap: wrap }).
  "footer.framerate": "Taxa de quadros",
  "footer.volume": "🎧 Volume",
  "footer.volumeTitle":
    "No alto-falante, seu microfone joga o som da transmissão de volta na call — fone resolve.",
  "footer.stingerVolumeTitle": "Volume das vinhetas só pra você",
  "footer.stingers": "🎺 Vinhetas",
  "footer.stingersTitle": "Adicione, escolha e dispare as vinhetas da sala",

  // --- cinema pause + shared doodles ---------------------------------
  "cinema.pause": "Pausar pra galera",
  "cinema.resume": "Voltar",
  "cinema.interval": "INTERVALO 🍿",
  "cinema.canvasTitle": "Rabiscos da galera",
  "cinema.undo": "Desfazer",
  "cinema.colorRed": "vermelho",
  "cinema.colorBlue": "azul",
  "cinema.colorYellow": "amarelo",
  "cinema.colorGrass": "verde",
  "cinema.colorPink": "rosa",
  "cinema.colorPurple": "roxo",

  // A fila é a coisa; o rodízio é o relógio em cima dela. "Pedir a vez" e
  // "é tua!" são as frases que as pessoas usam de verdade — docs/i18n.md § 3.
  "queue.title": "Fila da vez",
  "queue.request": "Pedir a vez",
  "queue.withdraw": "Sair da fila",
  // "Passar a vez" é o par exato de "Pedir a vez": uma pessoa pede, a outra
  // passa. "Passar o bastão" é a metáfora de corrida de revezamento e não
  // combina com "o palco", que é a metáfora da casa.
  "queue.pass": "Passar a vez",
  "queue.empty": "Ninguém na fila ainda.",
  "queue.position": "{name} — {n}º na fila",
  "queue.chipTitle": "{name} tá esperando",
  "queue.modeLabel": "Vez",
  "queue.modeLivre": "Livre",
  // "Rodízio" é a palavra que todo brasileiro já entende sem explicação.
  "queue.modeRodizio": "Rodízio",
  "queue.modeTitle":
    "Livre: passa o palco quando quiser. Rodízio: 20 minutos pra cada um, e o app pergunta quem é o próximo.",

  "telinha.badge": "telinha — uns segundos atrás",
  "telinha.waiting": "Sintonizando a telinhaâ¦",
  "telinha.noToken": "Esse link veio sem ingresso â abre a telinha pela Activity.",
  "telinha.mute": "Mutar",
  "telinha.unmute": "Com som",
  "telinha.open": "Telinha",
  "turn.warmup": "🔥 Aquecendo — tu é o próximo!",
  "turn.yours": "É tua!",
  "turn.yoursBody": "Bora — assume o palco antes dos {s}s acabarem.",
  "turn.take": "Assumir o palco",
  "turn.pill": "É tua por {s}s",
  // "{name} é o próximo" would need to agree with the person's gender, and a
  // display name cannot tell us. "É a vez de {name}" agrees with "a vez" and
  // is what somebody would actually say out loud.
  "turn.someone": "🎤 Agora é a vez de {name}.",
  "turn.wheel": "🎡 A roleta escolheu {name}!",
  "turn.missed": "⏱ Ninguém pegou — bora pro próximo.",

  "rodizio.left": "faltam {m}m {s}s",
  "rodizio.oneMinute": "⏰ Falta um minuto no palco.",
  "rodizio.upTitle": "Tua vez acabou!",
  "rodizio.upBody": "Passou voando, né? Passa a vez ou pega mais cinco minutos.",
  "rodizio.extend": "+5 min",

  "err.tookStage": "✋ {name} assumiu o palco.",
  "err.superseded":
    "Aberto em outro lugar — esta janela foi desconectada. Feche e abra a Atividade aqui pra assumir.",
  "err.shareToken": "Token de compartilhamento recusado ({status}).",
  "err.stage.noNext": "⛔ Não tem pra quem passar — chame alguém pra fila primeiro.",
  "err.stage.extended": "⛔ Você já pegou seus +5.",
  "err.stage.cooldown": "⛔ Espera um pouquinho antes de passar de novo.",
  "err.cinema.notPublisher": "⛔ Só quem tá transmitindo pode pausar.",
  "err.cinema.rateLimited": "⛔ Calma! Você tá desenhando rápido demais.",
  "err.cinema.badStroke": "⛔ Esse traço não foi — tenta um mais curto.",
  "err.assist.cooldown": "⛔ Calma — espera um pouquinho antes de apontar de novo.",
  "err.assist.bounds": "⛔ Esse ponto ficou fora da tela.",

  "modal.kick": "✋ Tirar {name} do palco?",
  "modal.yes": "Bora, minha vez",
  "modal.no": "Deixa pra lá",

  "share.sub": "compartilhamento de tela",
  "share.room": "Sala",
  "share.connection": "conexão",
  "share.expired":
    "⛔ A sessão expirou — volte pro Discord e clique em Compartilhar tela de novo.",
  "share.notConnected":
    "⚠ Sem conexão — ninguém tá vendo sua tela agora. Reconectando…",
  "share.replaced":
    "Esta transmissão foi substituída por uma aba mais nova — pode fechar esta aqui.",
  "share.start": "Começar a transmitir",
  "share.hint":
    "Escolha a tela, a janela ou a aba que você quer transmitir. Deixe esta aba aberta enquanto transmite — todo mundo na call assiste pela Atividade.",
  "share.advanced": "Avançado",
  "share.optimize": "Otimizar para",
  "share.opt.auto": "✨ Automático (recomendado)",
  "share.opt.text": "📖 Texto (código, slides)",
  "share.opt.motion": "🎮 Movimento (jogos, vídeo)",
  "share.sound": "Som",
  "share.snd.app": "🎵 Som do app — sem eco na call (recomendado)",
  "share.snd.system": "🔊 Som da tela inteira (dá eco!)",
  "share.snd.none": "🔇 Sem som",
  "share.sndHint.app":
    "Escolha uma janela ou uma aba do navegador — só o som daquele app é compartilhado, então a call do Discord nunca volta pro ar.",
  "share.sndHint.system":
    "⚠ Compartilha tudo que sai no seu alto-falante, INCLUSIVE a call do Discord — todo mundo vai se ouvir, a não ser que o Discord use outra saída de áudio (Windows: Configurações → Som → Mixer de volume → Discord → Saída).",
  "share.sndHint.none": "Só vídeo; o papo fica por conta da call.",
  "share.liveLine": "Ao vivo a {fps} fps — {realFps} fps · {kbps} kbps (alvo {target})",
  "share.watching": {
    zero: "ninguém assistindo",
    one: "{count} assistindo",
    other: "{count} assistindo",
  },
  "share.upload": "upload total ≈ {mbps} Mbps",
  "share.overBudget": " ⚠ acima do seu limite de banda",
  "share.minimize": "Pode minimizar esta aba; a transmissão continua rodando.",

  "st.title": "Vinhetas",
  "st.close": "Fechar as vinhetas",
  "st.dropLetGo": "Solta!",
  "st.drop": "Solte imagens e sons aqui",
  "st.uploading": "Enviando…",
  "st.choose": "Escolher arquivos",
  "st.formats": "png jpg gif webp · mp3 ogg wav · até {size} cada",
  "st.used": " · {used}/{max} usados",
  "st.dice": "Surpreenda a sala",
  "st.loading": "Abrindo a caixa de giz de cera…",
  "st.empty":
    "Nada aqui ainda. Jogue um meme e uma buzina aqui dentro que a sala inteira recebe.",
  "st.pictures": "Imagens ({count})",
  "st.sounds": "Sons ({count})",
  "st.chipStart": "começo",
  "st.chipStop": "fim",
  "st.chipOn": "usar",
  "st.chipStartTitle": "Tocar quando uma transmissão começa",
  "st.chipStopTitle": "Tocar quando uma transmissão acaba",
  "st.chipOnTitle": "Usar esta aqui",
  "st.room": "sala",
  "st.roomTitle": "Tocar isso pra sala inteira",
  "st.delete": "apagar",
  "st.deleteTitle": "Apagar {name}",
  "st.confirm": "Apagar?",
  "st.yes": "sim",
  "st.no": "não",
  "st.previewStop": "Parar a prévia",
  "st.previewPlay": "Ouvir só aqui (mais ninguém escuta)",
  "st.tooBig": "⛔ {names} — maior que {max}.",
  "st.errList": "não deu pra ler a pasta ({status})",
  "st.errUpload": "envio recusado ({status})",
  "st.errSave": "não deu pra salvar ({status})",
  "st.errDelete": "não deu pra apagar ({status})",
  // placar
  "placar.create": "Criar placar",
  "placar.close": "Fechar placar",
  "placar.modalTitle": "O que vamos contar?",
  "placar.placeholder": "ex: vezes que alguém falou 'tipo'",
  "placar.createBtn": "Criar",
  "placar.cancel": "Deixa pra lá",
  "placar.charCount": "{count}/60",
  "placar.plus": "Dar um ponto pra {name}",
  "placar.minus": "Tirar um ponto de {name}",
  "error.placar.alreadyActive": "⛔ Já tem um placar rolando — fecha ele primeiro.",
  "error.placar.tooFast": "⛔ Um ponto por segundo — calma!",
  "error.placar.notPublisher": "⛔ Só quem tá transmitindo pode fazer isso.",
  // --- awards toast (Activity-side) ---------------------------------
  "awards.ready": "Acabou! A entrega de troféus tá pronta.",
  "awards.view": "Ver os troféus",
  "awards.dismiss": "Fechar",
  // --- lobby --------------------------------------------------------
  "lobby.title": "A TV tá apagada",
  "lobby.subtitle": "Ninguém tá transmitindo ainda",
  "lobby.cta": "Acender a TV",
  "lobby.here": { one: "{count} pessoa por aqui", other: "{count} pessoas por aqui" },
  "lobby.alone": "Só você por enquanto",
  
  // --- clipe instantâneo --------------------------------------------
  "assist.button": "Deixa comigo â aponta na tela",
  "attn.title": "Quantos tão olhando de verdade",
  "hat.title": "O tempo tá enchendo — passa sozinho quando transbordar",
  "multi.label": "Palcos",
  "corrente.pick": "Passar a Telaâ¦",
  "corrente.line": "â¡ {name} assume em {s}s â fala agora ou torce",
  "corrente.vai": "Vai!",
  "corrente.calma": "Calma!",
  "corrente.canceled": "A sala pediu calma â passagem cancelada.",
  "err.corrente.notPublisher": "⛔ Só quem tá transmitindo pode passar a tela.",
  "err.corrente.badTarget": "⛔ Escolhe alguém que tá na sala.",
  "err.corrente.active": "⛔ Já tem uma passagem contando.",
  "aposta.dare": "Apostar contra {name}",
  "aposta.against": "Apostando contra {name}:",
  "aposta.placeholder": "aposto que… (Enter manda, Esc cancela)",
  "aposta.accept": "Bora! (aceito)",
  "aposta.decline": "Tô fora",
  "aposta.waiting": "Esperando {name}…",
  "aposta.live": "Aposta valendo — quem julga é o streamer.",
  "aposta.judgeChallenger": "Quem desafiou acertou",
  "aposta.judgeTarget": "O desafiado sobreviveu",
  "aposta.won": "🏆 {name} levou!",
  "aposta.declined": "Recusou. Sem coragem, sem glória.",
  "aposta.expired": "Ninguém respondeu — aposta cancelada.",
  "err.aposta.cooldown": "⛔ Uma aposta por vez — respira.",
  "err.aposta.badTarget": "⛔ Escolhe alguém da sala (e não você mesmo).",
  "err.aposta.full": "⛔ Três apostas rolando já chega.",
  "err.aposta.notTarget": "⛔ Só o desafiado responde.",
  "err.aposta.notJudge": "⛔ Só o streamer julga.",
  "replay.button": "Quem entrou? — rever o último trecho",
  "replay.title": "Quem entrou?",
  "replay.noJoins": "Ninguém novo nesse trecho",
  "replay.quiet": "Tudo calmo",
  "replay.heatLabel": "Hype do último trecho",
  "replay.download": "Salvar os últimos 90s",
  "replay.close": "Fechar",
  "clip.button": "Clipa isso!",
  "clip.working": "Recortando os últimos 30s...",
  "clip.ready": "Clipe pronto — pega aí",
  "clip.download": "Baixar",
  "clip.cooldown": "Calma aí, já já",
  "clip.expired": "Esse clipe expirou",
  
  // --- legendas -------------------------------------------------------
  "caption.placeholder": "Escreve a legenda e dá Enter",
  "caption.enable": "Ligar legendas",
  "caption.disable": "Desligar legendas",
  
  // --- jukebox --------------------------------------------------------
  "jukebox.title": "Jukebox",
  "jukebox.by": "pedido por {name}",
  "jukebox.approve": "Aprovar",
  "jukebox.request_asset": "Pedir: {title}",
};

const dictionaries: Record<Locale, Record<MessageKey, Message>> = {
  en,
  "pt-BR": ptBR,
};

/* ------------------------------------------------------------------ */
/* detection                                                           */
/* ------------------------------------------------------------------ */

/** Map any BCP-47-ish tag onto one of ours. Unknown languages return null so
 *  the caller can fall through to the next source rather than landing on a
 *  language nobody asked for. */
export function normalizeLocale(raw: string | null | undefined): Locale | null {
  if (!raw) return null;
  const s = raw.toLowerCase().replace("_", "-");
  if (s === "pt" || s.startsWith("pt-")) return "pt-BR";
  if (s === "en" || s.startsWith("en-")) return "en";
  return null;
}

function fromStorage(): Locale | null {
  try {
    return normalizeLocale(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null; // private mode
  }
}

/** `?lang=` — how openCompanion hands the Activity's language to the
 *  companion tab, which lives on a different origin and therefore cannot see
 *  the Activity's localStorage. */
function fromUrl(): Locale | null {
  try {
    return normalizeLocale(new URLSearchParams(location.search).get("lang"));
  } catch {
    return null;
  }
}

function fromNavigator(): Locale | null {
  const list =
    navigator.languages && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
  for (const tag of list) {
    const hit = normalizeLocale(tag);
    if (hit) return hit;
  }
  return null;
}

/**
 * Whether the language was *chosen* rather than guessed — by this user on
 * this origin (localStorage) or by the Activity that opened this tab
 * (`?lang`). A chosen language must never be overwritten by the Discord
 * client's own locale arriving a beat later.
 */
const chosen = fromUrl() !== null || fromStorage() !== null;

// Precedence: ?lang → localStorage → navigator → en.
//
// `?lang` outranks a stored value on purpose: the companion tab is opened
// *by* the Activity, so the Activity's current language is the fresher
// intent. It is not written to storage, so a direct visit to /share still
// gets whatever this browser last chose here.
const [locale, setLocaleSignal] = createSignal<Locale>(
  fromUrl() ?? fromStorage() ?? fromNavigator() ?? "en",
);

export { locale };

/** Switch the language. Persisted unless the value was merely detected. */
export function setLocale(next: Locale, persist = true): void {
  setLocaleSignal(next);
  document.documentElement.lang = next;
  if (!persist) return;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode: the choice lasts for this page load */
  }
}

/**
 * Adopt the locale the Discord client reports (see
 * `discord.ts → fetchClientLocale`). Zero-friction detection: it arrives
 * asynchronously, after first paint, and every `t()` in the tree re-runs.
 * It loses to an explicit choice — that is the whole contract of the toggle.
 */
export function adoptClientLocale(raw: string | null | undefined): void {
  if (chosen) return;
  const hit = normalizeLocale(raw);
  if (hit && hit !== locale()) setLocale(hit, false);
}

/** The value to hand to `?lang=` when opening the companion tab. */
export function localeParam(): string {
  return locale();
}

document.documentElement.lang = locale();

/* ------------------------------------------------------------------ */
/* lookup                                                              */
/* ------------------------------------------------------------------ */

export interface Params {
  [k: string]: string | number;
}

const interpolate = (tpl: string, params?: Params): string =>
  params
    ? tpl.replace(/\{(\w+)\}/g, (whole, key: string) =>
        key in params ? String(params[key]) : whole,
      )
    : tpl;

/**
 * Translate. Reactive: reading it inside JSX subscribes that fragment to the
 * locale signal, so switching language re-renders the whole UI with no
 * reload and no remount.
 *
 *     t("modal.kick", { name: "pedro" })
 *     t("share.watching", { count: viewers() })
 */
/**
 * Map a server error code (`ErrorData.Code`, e.g. `"stage.noNext"`) onto its
 * dictionary key, or null when the code is one this client does not know.
 *
 * The lookup is a membership test against the real dictionary rather than a
 * cast, so a server that grows a new code renders nothing instead of the raw
 * identifier — and adding the key here is what makes it appear, in both
 * languages, with the build enforcing the pair.
 */
export function errorKey(code: string): MessageKey | null {
  const key = `err.${code}`;
  return key in en ? (key as MessageKey) : null;
}

export function t(key: MessageKey, params?: Params): string {
  const msg: Message =
    dictionaries[locale()][key] ?? (en[key] as Message) ?? key;
  if (typeof msg === "string") return interpolate(msg, params);

  const count = Number(params?.count ?? 0);
  const form =
    count === 0 && msg.zero !== undefined
      ? msg.zero
      : msg[pluralRule[locale()](count)];
  return interpolate(form, params);
}
 

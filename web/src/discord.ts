// Discord Embedded App SDK bootstrap. Outside Discord (plain browser tab,
// local dev) we fall back to a fake identity so the whole pipeline can be
// developed and demoed without the Discord client.

import { DiscordSDK } from "@discord/embedded-app-sdk";

export interface Identity {
  inDiscord: boolean;
  userId: string;
  username: string;
  /** Room id — the activity instance id inside Discord. */
  room: string;
  /** Discord OAuth access token; proves identity to the janjacast server. */
  accessToken?: string;
}

const CLIENT_ID = import.meta.env.JANJACAST_DISCORD_CLIENT_ID as string | undefined;

let sdkInstance: DiscordSDK | null = null;

export function inDiscordFrame(): boolean {
  return new URLSearchParams(location.search).has("frame_id");
}

/** Whether this document may call getDisplayMedia. Discord's Activity iframe
 *  denies the "display-capture" feature by permissions policy — the M1 spike
 *  confirmed this empirically — in which case capture must happen in a
 *  companion browser tab. */
export function captureAllowed(): boolean {
  const doc = document as Document & {
    featurePolicy?: { allowsFeature(f: string): boolean };
    permissionsPolicy?: { allowsFeature(f: string): boolean };
  };
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  return policy ? policy.allowsFeature("display-capture") : true;
}

/** Open a URL in the user's real browser. Inside Discord this must go
 *  through the SDK (the iframe cannot window.open). */
/** true = opened, false = the user dismissed Discord's confirmation (or a
 *  popup blocker ate window.open), null = old client, can't tell. */
export async function openExternal(url: string): Promise<boolean | null> {
  if (sdkInstance) {
    const { opened } = await sdkInstance.commands.openExternalLink({ url });
    return opened;
  }
  return window.open(url, "_blank", "noopener") !== null;
}

interface ServerConfig {
  publicOrigin: string;
  clientId?: string;
  /** Whether the server has a stinger asset store at all. */
  stingers?: boolean;
}

async function fetchConfig(): Promise<ServerConfig> {
  const resp = await fetch(apiPath("/api/config"));
  if (!resp.ok) throw new Error(`config fetch failed: ${resp.status}`);
  return (await resp.json()) as ServerConfig;
}

/** The server's externally reachable origin — where the companion capture
 *  tab must point, since the Activity itself lives on Discord's proxy. */
export async function fetchPublicOrigin(): Promise<string> {
  return (await fetchConfig()).publicOrigin;
}

/** Whether JANJACAST_STINGER_DIR is configured. False hides the Stingers
 *  button entirely rather than opening a panel onto 404s. */
export async function fetchStingersEnabled(): Promise<boolean> {
  return Boolean((await fetchConfig()).stingers);
}

/**
 * The language the *Discord client* is set to, e.g. "pt-BR" / "en-US".
 *
 * This is the zero-friction half of locale detection: a Brazilian whose
 * Discord is in Portuguese gets a Portuguese Activity without touching
 * anything. `userSettingsGetLocale` needs the `identify` scope, which
 * `setupIdentity` has already taken, so it only works once the SDK is ready
 * — call it *after* setupIdentity resolves.
 *
 * Returns null outside Discord, on older clients that lack the command, and
 * on any RPC failure: the caller then falls back to `navigator.language`.
 * Best-effort by construction — a language guess must never be able to break
 * startup.
 */
export async function fetchClientLocale(): Promise<string | null> {
  if (!sdkInstance) return null;
  try {
    const { locale } = await sdkInstance.commands.userSettingsGetLocale();
    return locale || null;
  } catch {
    return null;
  }
}

/** Prefix for same-origin API/WS paths: Discord routes activity traffic
 *  through its proxy under `/.proxy/`. */
export function apiPath(path: string): string {
  return inDiscordFrame() ? `/.proxy${path}` : path;
}

export async function setupIdentity(): Promise<Identity> {
  if (!inDiscordFrame()) {
    const params = new URLSearchParams(location.search);
    const room = params.get("room") ?? "dev";
    const userId = Math.random().toString(36).slice(2, 10);
    return {
      inDiscord: false,
      userId,
      username: params.get("name") ?? `dev-${userId.slice(0, 4)}`,
      room,
    };
  }

  // Prefer the build-time id; otherwise ask the server — this is what lets
  // one published Docker image serve any Discord application.
  const clientId = CLIENT_ID ?? (await fetchConfig()).clientId;
  if (!clientId) {
    throw new Error(
      "no Discord client id: set DISCORD_CLIENT_ID on the server (or JANJACAST_DISCORD_CLIENT_ID at build time)",
    );
  }

  const sdk = new DiscordSDK(clientId);
  sdkInstance = sdk;
  await sdk.ready();

  // Software-decoding 1080p60 in an Activity is punishing; ask Discord to
  // enable hardware acceleration. Best-effort — older clients lack it.
  sdk.commands.encourageHardwareAcceleration().catch(() => {});

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify"],
  });

  const resp = await fetch(apiPath("/api/token"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!resp.ok) throw new Error(`token exchange failed: ${resp.status}`);
  const { access_token } = (await resp.json()) as { access_token: string };

  const auth = await sdk.commands.authenticate({ access_token });

  return {
    inDiscord: true,
    userId: auth.user.id,
    username: auth.user.global_name ?? auth.user.username,
    room: sdk.instanceId,
    accessToken: access_token,
  };
}

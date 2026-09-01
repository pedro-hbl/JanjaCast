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
  /** Discord OAuth access token; proves identity to the golive server. */
  accessToken?: string;
}

const CLIENT_ID = import.meta.env.GOLIVE_DISCORD_CLIENT_ID as string | undefined;

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
export async function openExternal(url: string): Promise<void> {
  if (sdkInstance) {
    await sdkInstance.commands.openExternalLink({ url });
  } else {
    window.open(url, "_blank", "noopener");
  }
}

interface ServerConfig {
  publicOrigin: string;
  clientId?: string;
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
      "no Discord client id: set DISCORD_CLIENT_ID on the server (or GOLIVE_DISCORD_CLIENT_ID at build time)",
    );
  }

  const sdk = new DiscordSDK(clientId);
  sdkInstance = sdk;
  await sdk.ready();

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

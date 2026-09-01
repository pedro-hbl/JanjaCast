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
}

const CLIENT_ID = import.meta.env.GOLIVE_DISCORD_CLIENT_ID as string | undefined;

export function inDiscordFrame(): boolean {
  return new URLSearchParams(location.search).has("frame_id");
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

  if (!CLIENT_ID) {
    throw new Error(
      "GOLIVE_DISCORD_CLIENT_ID is not set — rebuild the client with it in the environment",
    );
  }

  const sdk = new DiscordSDK(CLIENT_ID);
  await sdk.ready();

  const { code } = await sdk.commands.authorize({
    client_id: CLIENT_ID,
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
  };
}

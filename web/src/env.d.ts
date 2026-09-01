/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly JANJACAST_DISCORD_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// MediaStreamTrackProcessor (Chromium insertable streams) is not in the
// standard TS DOM lib yet.
declare class MediaStreamTrackProcessor<T = VideoFrame | AudioData> {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<T>;
}

import { apiPath } from "./discord";
import * as MuxerMP4 from "mp4-muxer";
import * as MuxerWebM from "webm-muxer";

type Header = {
  videoCodec?: string;
  width?: number; height?: number; framerate?: number;
  audioCodec?: string; sampleRate?: number; channels?: number;
};

export async function downloadClip(tokenPath: string): Promise<void> {
  const url = apiPath(tokenPath);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`clip fetch ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  let off = 0;
  const magic = String.fromCharCode((buf[0]||0),(buf[1]||0),(buf[2]||0),(buf[3]||0));
  if (magic !== "JCLP") throw new Error("bad clip stream");
  off += 4;
  const hdrLen = ((buf[off]||0)<<24)|((buf[off+1]||0)<<16)|((buf[off+2]||0)<<8)|((buf[off+3]||0)); off+=4;
  const header: Header = JSON.parse(new TextDecoder().decode(buf.subarray(off, off+hdrLen))); off+=hdrLen;
  const vcodec = header.videoCodec || "";
  const useMP4 = vcodec.startsWith("avc1");
  let chunks: { kind:number; key:boolean; ts:number; payload:Uint8Array }[] = [];
  while (off < buf.length) {
    const kind = buf[off++] || 0;
    const flags = buf[off++] || 0;
    const len = ((buf[off]||0)<<24)|((buf[off+1]||0)<<16)|((buf[off+2]||0)<<8)|(buf[off+3]||0); off+=4;
    const ts = Number((BigInt(buf[off]||0)<<56n)|(BigInt(buf[off+1]||0)<<48n)|(BigInt(buf[off+2]||0)<<40n)|(BigInt(buf[off+3]||0)<<32n)|
      (BigInt(buf[off+4]||0)<<24n)|(BigInt(buf[off+5]||0)<<16n)|(BigInt(buf[off+6]||0)<<8n)|BigInt(buf[off+7]||0)); off+=8;
    const payload = buf.subarray(off, off+len); off+=len;
    chunks.push({ kind, key: (flags&1)!==0, ts, payload });
  }
  // Mux by codec
  if (useMP4) {
    const mux = new (MuxerMP4 as any).MP4Muxer({ target: new (MuxerMP4 as any).ArrayBufferTarget(), fastStart: true });
    for (const c of chunks) {
      if (c.kind !== 1) continue; // video only for now; Opus-in-MP4 support varies
      mux.addVideoChunk({ type: c.key?"key":"delta", timestamp: c.ts, duration: 0, data: c.payload }, { codec: vcodec });
    }
    mux.finalize();
    const ab = (mux.target as any).buffer as ArrayBuffer;
    const blob = new Blob([ab], { type: "video/mp4" });
    triggerDownload(blob, "janjacast-clip.mp4");
  } else {
    const mux = new (MuxerWebM as any).WebMMuxer({ target: new (MuxerWebM as any).ArrayBufferTarget(), video: { codec: vcodec || "vp8" }, audio: header.audioCodec? { codec: header.audioCodec }: undefined });
    for (const c of chunks) {
      if (c.kind === 1) mux.addVideoChunk({ type: c.key?"key":"delta", timestamp: c.ts, duration: 0, data: c.payload });
      else mux.addAudioChunk?.({ type: "delta", timestamp: c.ts, duration: 0, data: c.payload });
    }
    mux.finalize();
    const ab = (mux.target as any).buffer as ArrayBuffer;
    const blob = new Blob([ab], { type: "video/webm" });
    triggerDownload(blob, "janjacast-clip.webm");
  }
}

function triggerDownload(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(a.href);
  a.remove();
}

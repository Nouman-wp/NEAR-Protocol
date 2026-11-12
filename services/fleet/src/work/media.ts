import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TYPES = {
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  gif: "image/gif",
  vtt: "text/vtt; charset=utf-8",
} as const;

export type MediaExt = keyof typeof TYPES;

/** A file a studio delivered: content-addressed, so the hash in a signed delivery pins its bytes. */
export interface MediaRef {
  url: string;
  sha256: string;
  bytes: number;
  type: string;
  width?: number;
  height?: number;
}

/**
 * Deliverables that are files (images, a GIF, captions) are stored once under their
 * sha256 and served by the swarm at /media/<sha256>.<ext>. A job's result carries the URL
 * and the hash, and the seller's signed delivery covers the result, so anyone can check
 * that the file they download is the file that was delivered.
 */
export class MediaStore {
  constructor(
    readonly dir: string,
    readonly baseUrl: string,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  put(content: Uint8Array | string, ext: MediaExt, size?: { width: number; height: number }): MediaRef {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const name = `${sha256}.${ext}`;
    const path = join(this.dir, name);
    if (!existsSync(path)) writeFileSync(path, buf);
    return { url: `${this.baseUrl}/media/${name}`, sha256, bytes: buf.length, type: TYPES[ext], ...(size ?? {}) };
  }

  /** The bytes behind a media URL or file name, if this store holds them. */
  read(urlOrName: string): Buffer | null {
    const name = urlOrName.split("/").pop() ?? "";
    if (!/^[0-9a-f]{64}\.(svg|jpg|gif|vtt)$/.test(name)) return null;
    const path = join(this.dir, name);
    return existsSync(path) ? readFileSync(path) : null;
  }

  /** For the HTTP handler: the file and its content type. */
  serve(name: string): { body: Buffer; type: string } | null {
    const body = this.read(name);
    if (!body) return null;
    return { body, type: TYPES[name.split(".").pop() as MediaExt] };
  }
}

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type Log = (msg: string) => void;

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

/**
 * Downloads `url` to `dest` unless a file with the expected checksum is already there.
 * Writes to a temp file first so an interrupted download never leaves a broken file in place.
 */
export async function downloadFile(url: string, dest: string, sha256: string | undefined, log: Log): Promise<void> {
  if (await exists(dest)) {
    if (!sha256 || (await sha256File(dest)) === sha256) return;
    log(`checksum mismatch, re-downloading ${path.basename(dest)}`);
  }
  await mkdir(path.dirname(dest), { recursive: true });

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);

  const total = Number(res.headers.get("content-length") ?? 0);
  let received = 0;
  let lastReport = 0;
  const hash = createHash("sha256");
  const progress = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      hash.update(chunk);
      const now = Date.now();
      if (now - lastReport > 2000) {
        lastReport = now;
        const mb = (received / 1048576).toFixed(1);
        log(total ? `  ${path.basename(dest)}: ${mb} / ${(total / 1048576).toFixed(1)} MB` : `  ${path.basename(dest)}: ${mb} MB`);
      }
      cb(null, chunk);
    },
  });

  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as never), progress, createWriteStream(tmp));
    const actual = hash.digest("hex");
    if (sha256 && actual !== sha256) throw new Error(`checksum mismatch for ${url}: expected ${sha256}, got ${actual}`);
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

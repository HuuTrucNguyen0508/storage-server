import { randomBytes } from "k6/crypto";

// 64 KiB of random bytes, made once per VU. Larger blobs repeat it; the first bytes are
// stamped per call so every upload is a different file.
const BLOCK = new Uint8Array(randomBytes(64 * 1024));

export function blob(size) {
  const out = new Uint8Array(size);
  for (let off = 0; off < size; off += BLOCK.length) {
    out.set(off + BLOCK.length <= size ? BLOCK : BLOCK.subarray(0, size - off), off);
  }
  const stamp = new Uint8Array(randomBytes(Math.min(16, size)));
  out.set(stamp, 0);
  return out.buffer;
}

export function text(size) {
  const line = "The quick brown fox jumps over the lazy dog. Load generator filler text.\n";
  return line.repeat(Math.ceil(size / line.length)).slice(0, size);
}

// Fixtures are read once per VU in the init context (k6 requires open() there).
export function fixture(path) {
  return open(path, "b");
}

// ulid.js — in-house ULID generator (ADR-007: no vendored deps for 30 lines).
// Lowercase per ADR-010. 48-bit ms timestamp + 80 bits of crypto randomness,
// Crockford base32, lexically sortable by creation time.

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';

export function ulid(now = Date.now()) {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = B32[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  let rs = '';
  for (let i = 0; i < 16; i++) rs += B32[rand[i] % 32];
  return ts + rs;
}

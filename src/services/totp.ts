import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Time-based one-time passwords (RFC 6238) for admin two-factor sign-in: 6 digits, 30-second
// steps, HMAC-SHA1, as Google Authenticator, 1Password, Authy and others expect.

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SEC = 30;
const DIGITS = 6;
// Codes from the neighbouring steps are accepted too, for clock drift between phone and server
const DRIFT_STEPS = 1;

function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/[\s=]/g, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("Invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 160-bit secret, the size RFC 4226 recommends, as base32 for authenticator apps
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(message).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

// The time step the code belongs to, or null when it doesn't match. Callers store the step and
// refuse codes from it or earlier, so a code can't be used twice.
export function verifyTotp(secretBase32: string, code: string, now = Date.now()): number | null {
  const given = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const secret = base32Decode(secretBase32);
  const current = Math.floor(now / 1000 / STEP_SEC);
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(given))) return step;
  }
  return null;
}

// Link that authenticator apps read from a QR code
export function totpUrl(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SEC) });
  return `otpauth://totp/${label}?${params}`;
}

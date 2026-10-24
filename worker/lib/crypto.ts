const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256(value: string | ArrayBuffer): Promise<string> {
  const data = typeof value === "string" ? encoder.encode(value) : value;
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

export async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) mismatch |= (left[i % left.length] ?? 0) ^ (right[i % right.length] ?? 0);
  return mismatch === 0;
}

export async function requestHash(method: string, path: string, body: unknown): Promise<string> {
  return sha256(`${method.toUpperCase()}\n${path}\n${JSON.stringify(body)}`);
}

export function randomId(): string {
  return crypto.randomUUID();
}

export function randomSafeInteger(): number {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  return Number((BigInt(bytes[0] ?? 0) << 21n) | (BigInt(bytes[1] ?? 0) & 0x1fffffn)) || 1;
}

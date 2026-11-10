// electron/src/main/oauth/protocol/pkce.ts
//
// RFC 7636 PKCE（S256）+ OAuth state。随机源 node:crypto。
import { createHash, randomBytes } from 'node:crypto';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 字节随机 → 43 字符 base64url（RFC 7636 §4.1 允许 43-128） */
export function createVerifier(): string {
  return base64url(randomBytes(32));
}

export function challengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = createVerifier();
  return { verifier, challenge: challengeFor(verifier) };
}

/** 16 字节随机 base64url（CSRF 防护） */
export function createState(): string {
  return base64url(randomBytes(16));
}

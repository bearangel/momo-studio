// electron/tests/oauth/pkce.test.ts
//
// PKCE（S256）+ state 生成的回归锁（Task 4，2026-11-10 OAuth 模块）。
import { describe, it, expect } from 'vitest';
import {
  challengeFor,
  createPkcePair,
  createState,
  createVerifier,
} from '../../src/main/oauth/protocol/pkce';

describe('pkce', () => {
  it('匹配 RFC 7636 附录 B 向量', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
  it('生成 43 字符 base64url verifier 与对应 challenge', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(challengeFor(verifier));
  });
  it('state 每次不同且 URL 安全', () => {
    const a = createState();
    const b = createState();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('verifier 每次不同（唯一性回归锁：复用 verifier 等于 PKCE 失效）', () => {
    const a = createVerifier();
    const b = createVerifier();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('多组 pkce pair 的 verifier 互不相同', () => {
    const verifiers = new Set(Array.from({ length: 20 }, () => createPkcePair().verifier));
    expect(verifiers.size).toBe(20);
  });
  it('challenge 恒为 43 字符无填充 base64url（不含 + / =）', () => {
    expect(challengeFor('')).toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
    expect(challengeFor('')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challengeFor('中文 verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('state 为 16 字节 base64url（22 字符）', () => {
    expect(createState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

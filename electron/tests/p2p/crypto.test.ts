// crypto.ts 的单元测试——验证 X25519 ECDH 共享密钥派生 + secretbox 加解密往返。
// 覆盖：
//   - 双方 ECDH 派生一致（A→B == B→A）
//   - encrypt + decrypt 往返 plaintext 一致
//   - 用错误密钥解密密文返回 null（认证失败）
//   - 篡改密文 1 字节返回 null（Poly1305 认证失败）
import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { encryptPayload, decryptPayload, deriveSharedKey, randomNonce } from '../../src/main/p2p/crypto';

describe('p2p crypto', () => {
  it('deriveSharedKey 双方一致（X25519 ECDH）', () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();
    const k1 = deriveSharedKey(alice.secretKey, bob.publicKey);
    const k2 = deriveSharedKey(bob.secretKey, alice.publicKey);
    expect(Array.from(k1)).toEqual(Array.from(k2));
  });

  it('encryptPayload + decryptPayload 往返', () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();
    const sharedKey = deriveSharedKey(alice.secretKey, bob.publicKey);
    const nonce = randomNonce();
    const plaintext = new TextEncoder().encode('hello secret');
    const ciphertext = encryptPayload(plaintext, sharedKey, nonce);
    const decrypted = decryptPayload(ciphertext, sharedKey, nonce);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });

  it('decryptPayload 用错误密钥返回 null', () => {
    const alice = nacl.box.keyPair();
    const eve = nacl.box.keyPair();
    const realKey = deriveSharedKey(alice.secretKey, nacl.box.keyPair().publicKey);
    const wrongKey = deriveSharedKey(eve.secretKey, nacl.box.keyPair().publicKey);
    const nonce = randomNonce();
    const ct = encryptPayload(new TextEncoder().encode('hi'), realKey, nonce);
    expect(decryptPayload(ct, wrongKey, nonce)).toBeNull();
  });

  it('decryptPayload 篡改密文返回 null', () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();
    const key = deriveSharedKey(alice.secretKey, bob.publicKey);
    const nonce = randomNonce();
    const ct = encryptPayload(new TextEncoder().encode('hi'), key, nonce);
    ct[0] ^= 0xff;
    expect(decryptPayload(ct, key, nonce)).toBeNull();
  });
});
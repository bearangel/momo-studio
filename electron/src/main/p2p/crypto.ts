// crypto.ts
//
// E2E 加密 helper——HubTransport 用。
// 流程：
//   1. 双方各自有 X25519 box keyPair（独立于 Ed25519 签名密钥）
//   2. deriveSharedKey(mySecret, peerPublic) → 32 字节共享密钥
//   3. randomNonce() → 24 字节 nonce
//   4. encryptPayload(plaintext, key, nonce) → ciphertext
//   5. decryptPayload 反向
//
// 用 tweetnacl 的 secretbox（XSalsa20-Poly1305，等价于 AES-GCM 安全级别）。
import nacl from 'tweetnacl';

export function deriveSharedKey(mySecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return nacl.box.before(peerPublicKey, mySecretKey);
}

export function randomNonce(): Uint8Array {
  return nacl.randomBytes(nacl.box.nonceLength);
}

export function encryptPayload(plaintext: Uint8Array, sharedKey: Uint8Array, nonce: Uint8Array): Uint8Array {
  return nacl.box.after(plaintext, nonce, sharedKey);
}

export function decryptPayload(ciphertext: Uint8Array, sharedKey: Uint8Array, nonce: Uint8Array): Uint8Array | null {
  return nacl.box.open.after(ciphertext, nonce, sharedKey);
}
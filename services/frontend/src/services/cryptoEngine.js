/**
 * cryptoEngine.js — Zero-Knowledge Client-Side Encryption Engine
 * 
 * Uses the Web Crypto API (native browser, zero dependencies) for
 * AES-256-GCM encryption/decryption. The server never sees plaintext or keys.
 * 
 * Flow:
 *   1. User provides a password
 *   2. PBKDF2 derives a 256-bit AES-GCM key from password + random salt
 *   3. Each chunk is encrypted with a unique random 12-byte IV
 *   4. Salt is stored server-side (not secret), IVs stored per-chunk
 *   5. On download, password + salt re-derive the same key to decrypt
 */

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 256; // AES-256
const IV_LENGTH = 12;   // 96 bits, recommended for GCM
const SALT_LENGTH = 32; // 256 bits

/**
 * Generate a random salt for key derivation.
 * @returns {Uint8Array} 32-byte random salt
 */
export function generateSalt() {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/**
 * Derive an AES-256-GCM CryptoKey from a password and salt using PBKDF2.
 * @param {string} password - User-provided vault password
 * @param {Uint8Array} salt - Random salt (stored alongside encrypted file)
 * @returns {Promise<CryptoKey>} AES-GCM key for encrypt/decrypt
 */
export async function deriveKey(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,        // not extractable — key never leaves SubtleCrypto
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a single chunk with AES-256-GCM.
 * @param {CryptoKey} key - Derived AES-GCM key
 * @param {ArrayBuffer} plainChunk - Raw chunk data
 * @returns {Promise<{ ciphertext: ArrayBuffer, iv: Uint8Array }>}
 */
export async function encryptChunk(key, plainChunk) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plainChunk
  );

  return { ciphertext, iv };
}

/**
 * Decrypt a single chunk with AES-256-GCM.
 * @param {CryptoKey} key - Derived AES-GCM key
 * @param {ArrayBuffer} ciphertext - Encrypted chunk data (includes auth tag)
 * @param {Uint8Array} iv - 12-byte initialization vector used during encryption
 * @returns {Promise<ArrayBuffer>} Decrypted plaintext chunk
 */
export async function decryptChunk(key, ciphertext, iv) {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
}

/**
 * Convert a Uint8Array to a base64 string (for JSON serialization).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert a base64 string back to a Uint8Array.
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Compute SHA-256 hash of an ArrayBuffer using SubtleCrypto.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>} hex-encoded SHA-256 hash
 */
export async function sha256(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Decrypt an entire encrypted file array buffer chunk by chunk.
 * @param {ArrayBuffer} encBuffer - The raw encrypted bytes received from server
 * @param {Object} fileMeta - File metadata containing size, encryptionSalt, chunkIVs, mimeType
 * @param {string} password - User's vault password
 * @returns {Promise<Blob>} Decrypted file as Blob
 */
export async function decryptFileBuffer(encBuffer, fileMeta, password) {
  if (!fileMeta.encryptionSalt || !fileMeta.chunkIVs?.length) {
    throw new Error('Missing encryption metadata. File cannot be decrypted.');
  }

  const salt = base64ToBytes(fileMeta.encryptionSalt);
  const key = await deriveKey(password, salt);

  const CHUNK_SIZE = 4 * 1024 * 1024;
  const GCM_TAG_SIZE = 16;
  const chunkIVs = fileMeta.chunkIVs;
  const parts = [];
  let offset = 0;

  for (let i = 0; i < chunkIVs.length; i++) {
    const iv = base64ToBytes(chunkIVs[i]);
    const encChunkSize = Math.min(CHUNK_SIZE, fileMeta.size - (i * CHUNK_SIZE)) + GCM_TAG_SIZE;
    const encChunk = encBuffer.slice(offset, offset + encChunkSize);
    offset += encChunkSize;

    const decrypted = await decryptChunk(key, encChunk, iv);
    parts.push(new Uint8Array(decrypted));
  }

  return new Blob(parts, { type: fileMeta.mimeType || 'application/octet-stream' });
}


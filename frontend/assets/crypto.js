// RelaySecret crypto — WebCrypto only. No external libs.
//
// RSv1 blob layout (little-endian, but there are no multi-byte ints to worry about):
//
//   offset  size  field
//   ------  ----  -----------------------------------------------------
//   0       8     magic     = "RSv1" + 4x NUL     (ASCII, version tag)
//   8       16    salt      = PBKDF2 salt
//   24      12    iv        = AES-GCM nonce (random, unique per message)
//   36      N     ct||tag   = AES-GCM ciphertext with 16-byte auth tag
//
// Key derivation:
//   passphrase = (userPassword || "") + tempKey
//   key        = PBKDF2-HMAC-SHA256(passphrase, salt, 600_000) -> 256 bits
//
// 600k iterations matches OWASP 2023 / NIST SP 800-132 guidance. The salt is
// 16 bytes (bumped from the archived 8) and the IV is random per-message
// rather than derived, so reusing the same passphrase twice is still safe.
//
// The archived CBC+"Salted__" layout is NOT supported — this is a clean break.

const MAGIC        = new Uint8Array([0x52, 0x53, 0x76, 0x31, 0, 0, 0, 0]); // "RSv1\0\0\0\0"
const MAGIC_LEN    = 8;
const SALT_LEN     = 16;
const IV_LEN       = 12;
const HEADER_LEN   = MAGIC_LEN + SALT_LEN + IV_LEN; // 36
const PBKDF2_ITERS = 600_000;
const KEY_BITS     = 256;

const enc = new TextEncoder();

function buf2hex(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0');
  return s;
}

async function deriveKey(userPassword, tempKey, salt, usage) {
  const passphrase = (userPassword || '') + (tempKey || '');
  const base = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    [usage]
  );
}

export async function encryptBlob(plaintextBytes, userPassword, tempKey) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv   = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key  = await deriveKey(userPassword, tempKey, salt, 'encrypt');
  const ct   = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintextBytes)
  );
  const out = new Uint8Array(HEADER_LEN + ct.length);
  out.set(MAGIC, 0);
  out.set(salt, MAGIC_LEN);
  out.set(iv, MAGIC_LEN + SALT_LEN);
  out.set(ct, HEADER_LEN);
  return out;
}

export async function decryptBlob(blobBytes, userPassword, tempKey) {
  if (blobBytes.length < HEADER_LEN + 16) {
    throw new Error('Blob too small to be a valid RSv1 payload');
  }
  for (let i = 0; i < MAGIC_LEN; i++) {
    if (blobBytes[i] !== MAGIC[i]) {
      throw new Error('Unknown blob format (expected RSv1)');
    }
  }
  const salt = blobBytes.slice(MAGIC_LEN, MAGIC_LEN + SALT_LEN);
  const iv   = blobBytes.slice(MAGIC_LEN + SALT_LEN, HEADER_LEN);
  const ct   = blobBytes.slice(HEADER_LEN);
  const key  = await deriveKey(userPassword, tempKey, salt, 'decrypt');
  // AES-GCM verifies the tag; subtle.decrypt throws on tamper / wrong key.
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new Uint8Array(pt);
}

export async function sha1Hex(bytes) {
  return buf2hex(await crypto.subtle.digest('SHA-1', bytes));
}

export async function sha256Hex(str) {
  return buf2hex(await crypto.subtle.digest('SHA-256', enc.encode(str)));
}

// Derive purpose-specific bearer capabilities without exposing the encryption
// key to the Worker. A capability can authorize room/KV/delete operations, but
// cannot be used to derive tempKey or decrypt content.
export async function deriveCapability(tempKey, purpose) {
  return sha256Hex(`RelaySecret capability v1\0${purpose}\0${tempKey}`);
}

export async function capabilityId(capability) {
  return (await sha256Hex(capability)).slice(0, 16);
}

export async function capabilityDigest(capability) {
  return sha256Hex(capability);
}

// 32 hex chars = 128 bits of entropy. Used as the URL-fragment temp key.
export function randomTempKey() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return buf2hex(b);
}

// ---------------------------------------------------------------------------
// Chunked formats.
//
// RSv2 declares the chunk count and authenticates the complete header plus
// chunk index as AES-GCM associated data. This makes size/header edits,
// reordering, missing chunks, and appended records detectable.
//
// RSv2 header:
//   0..7    "RSv2" + 4 NUL
//   8..11   nominal chunk size (uint32 LE)
//   12..19  total plaintext size (uint64 LE)
//   20..23  total chunk count (uint32 LE)
//   24..39  PBKDF2 salt
//   40..51  base AES-GCM IV
// ---------------------------------------------------------------------------

const MAGIC_V2 = new Uint8Array([0x52, 0x53, 0x76, 0x32, 0, 0, 0, 0]);
export const RSv2_HEADER_LEN = 52;

const CHUNK_LEN_PREFIX = 4;
const MAX_CHUNK_SIZE = 512 * 1024 * 1024;
const MAX_CHUNKS = 10_000;

function readUint32LE(buf, offset) {
  return (
    buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    (buf[offset + 3] << 24)
  ) >>> 0;
}

function writeUint32LE(buf, offset, val) {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
  buf[offset + 2] = (val >>> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

function readUint64LE(buf, offset) {
  const lo = readUint32LE(buf, offset);
  const hi = readUint32LE(buf, offset + 4);
  return hi * 0x100000000 + lo;
}

function writeUint64LE(buf, offset, val) {
  writeUint32LE(buf, offset, val >>> 0);
  writeUint32LE(buf, offset + 4, Math.floor(val / 0x100000000));
}

function deriveChunkIV(baseIV, chunkIndex) {
  const iv = new Uint8Array(baseIV);
  iv[8] ^= chunkIndex & 0xff;
  iv[9] ^= (chunkIndex >>> 8) & 0xff;
  iv[10] ^= (chunkIndex >>> 16) & 0xff;
  iv[11] ^= (chunkIndex >>> 24) & 0xff;
  return iv;
}

function chunkAad(header, chunkIndex) {
  const aad = new Uint8Array(header.length + 4);
  aad.set(header);
  writeUint32LE(aad, header.length, chunkIndex);
  return aad;
}

function validateHeaderNumbers(chunkSize, totalSize, totalChunks) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) {
    throw new Error('Invalid chunk size');
  }
  if (!Number.isSafeInteger(totalSize) || totalSize < 1) {
    throw new Error('Invalid total size');
  }
  if (!Number.isSafeInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS) {
    throw new Error('Invalid chunk count');
  }
}

export function multipartChunkCount(totalSize, chunkSize) {
  if (!Number.isSafeInteger(totalSize) || totalSize < 1 || chunkSize <= RSv2_HEADER_LEN) {
    throw new Error('Invalid multipart dimensions');
  }
  return Math.ceil((totalSize + RSv2_HEADER_LEN) / chunkSize);
}

export async function createChunkedEncryptContext(
  userPassword,
  tempKey,
  chunkSize,
  totalSize,
  totalChunks,
) {
  validateHeaderNumbers(chunkSize, totalSize, totalChunks);

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const baseIV = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(userPassword, tempKey, salt, 'encrypt');

  const header = new Uint8Array(RSv2_HEADER_LEN);
  header.set(MAGIC_V2, 0);
  writeUint32LE(header, 8, chunkSize);
  writeUint64LE(header, 12, totalSize);
  writeUint32LE(header, 20, totalChunks);
  header.set(salt, 24);
  header.set(baseIV, 40);

  async function encryptChunk(plainChunk, chunkIndex) {
    if (chunkIndex < 0 || chunkIndex >= totalChunks) {
      throw new Error('Chunk index outside declared structure');
    }
    const iv = deriveChunkIV(baseIV, chunkIndex);
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: chunkAad(header, chunkIndex) },
      key,
      plainChunk,
    ));
    const record = new Uint8Array(CHUNK_LEN_PREFIX + ct.length);
    writeUint32LE(record, 0, ct.length);
    record.set(ct, CHUNK_LEN_PREFIX);
    return record;
  }

  return { header, encryptChunk };
}

export async function* encryptChunked(
  chunkIterator,
  userPassword,
  tempKey,
  chunkSize,
  totalSize,
  onProgress,
) {
  const totalChunks = Math.ceil(totalSize / chunkSize);
  const ctx = await createChunkedEncryptContext(
    userPassword,
    tempKey,
    chunkSize,
    totalSize,
    totalChunks,
  );
  yield ctx.header;

  let encrypted = 0;
  let chunkIndex = 0;
  for await (const plainChunk of chunkIterator) {
    if (chunkIndex >= totalChunks) throw new Error('Too many plaintext chunks');
    yield await ctx.encryptChunk(plainChunk, chunkIndex);
    encrypted += plainChunk.length;
    chunkIndex++;
    if (onProgress) onProgress(encrypted, totalSize);
  }
  if (chunkIndex !== totalChunks || encrypted !== totalSize) {
    throw new Error('Plaintext chunk structure does not match declared size');
  }
}

export async function* decryptChunked(
  headerBytes,
  userPassword,
  tempKey,
  fetchRange,
  onProgress,
  objectSize,
) {
  const format = detectFormat(headerBytes);
  if (format !== 'v2') {
    throw new Error('Expected a chunked RelaySecret payload');
  }

  const headerLen = RSv2_HEADER_LEN;
  if (headerBytes.length < headerLen) throw new Error('Truncated chunked header');
  const header = headerBytes.slice(0, headerLen);

  const { chunkSize, totalSize, totalChunks } = chunkedMetadata(header);

  const salt = header.slice(24, 40);
  const baseIV = header.slice(40, 52);
  const key = await deriveKey(userPassword, tempKey, salt, 'decrypt');

  let pos = headerLen;
  let decrypted = 0;
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const lenBuf = await fetchRange(pos, pos + CHUNK_LEN_PREFIX);
    if (lenBuf.length !== CHUNK_LEN_PREFIX) throw new Error('Missing chunk length');
    const ctLen = readUint32LE(lenBuf, 0);
    if (ctLen < 16 || ctLen > chunkSize + 16) throw new Error('Invalid ciphertext chunk length');

    const ctBuf = await fetchRange(
      pos + CHUNK_LEN_PREFIX,
      pos + CHUNK_LEN_PREFIX + ctLen,
    );
    if (ctBuf.length !== ctLen) throw new Error('Truncated ciphertext chunk');

    const algorithm = {
      name: 'AES-GCM',
      iv: deriveChunkIV(baseIV, chunkIndex),
      additionalData: chunkAad(header, chunkIndex),
    };
    const pt = new Uint8Array(await crypto.subtle.decrypt(algorithm, key, ctBuf));
    decrypted += pt.length;
    if (decrypted > totalSize) throw new Error('Decrypted data exceeds declared size');
    yield pt;

    pos += CHUNK_LEN_PREFIX + ctLen;
    if (onProgress) onProgress(decrypted, totalSize);
  }

  if (decrypted !== totalSize) throw new Error('Decrypted size does not match authenticated header');
  if (Number.isSafeInteger(objectSize) && pos !== objectSize) {
    throw new Error('Ciphertext object contains missing or appended data');
  }
}

export function detectFormat(header) {
  if (header.length < MAGIC_LEN) throw new Error('Header too small');
  const candidates = [
    ['v1', MAGIC],
    ['v2', MAGIC_V2],
  ];
  for (const [name, magic] of candidates) {
    let match = true;
    for (let i = 0; i < MAGIC_LEN; i++) {
      if (header[i] !== magic[i]) match = false;
    }
    if (match) return name;
  }
  throw new Error('Unknown blob format');
}

export function chunkedMetadata(header) {
  const format = detectFormat(header);
  if (format !== 'v2') throw new Error('Not a chunked payload');
  const headerLen = RSv2_HEADER_LEN;
  if (header.length < headerLen) throw new Error('Truncated chunked header');
  const chunkSize = readUint32LE(header, 8);
  const totalSize = readUint64LE(header, 12);
  const totalChunks = readUint32LE(header, 20);
  validateHeaderNumbers(chunkSize, totalSize, totalChunks);
  return { format, headerLen, chunkSize, totalSize, totalChunks };
}

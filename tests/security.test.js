import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  capabilityId,
  capabilityDigest,
  createChunkedEncryptContext,
  decryptChunked,
  deriveCapability,
  multipartChunkCount,
  RSv2_HEADER_LEN,
} from '../frontend/assets/crypto.js';
import {
  verifyScopedCapability,
} from '../worker/src/util/capability.js';
import { refererGate } from '../worker/src/util/cors.js';
import { deleteObj } from '../worker/src/routes/deleteObj.js';
import { enforceRateLimits } from '../worker/src/util/abuse.js';
import { enforceTurnstile } from '../worker/src/util/turnstile.js';
import {
  generateRoomCodeFromWords,
  normalizeRoomCode,
  parseRoomWordList,
  validateRoomCode,
} from '../frontend/assets/room-code.js';

const roomWords = parseRoomWordList(readFileSync(
  new URL('../frontend/assets/eff_large_wordlist.txt', import.meta.url),
  'utf8',
));

function join(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function collect(generator) {
  const parts = [];
  for await (const part of generator) parts.push(part);
  return join(parts);
}

async function makeCiphertext() {
  const plaintext = new TextEncoder().encode('authenticated chunk structure');
  const chunkSize = 64;
  const totalChunks = multipartChunkCount(plaintext.length, chunkSize);
  const ctx = await createChunkedEncryptContext(
    '',
    '0123456789abcdef0123456789abcdef',
    chunkSize,
    plaintext.length,
    totalChunks,
  );

  const firstSize = chunkSize - RSv2_HEADER_LEN;
  const first = plaintext.slice(0, firstSize);
  const second = plaintext.slice(firstSize);
  const records = [
    await ctx.encryptChunk(first, 0),
    await ctx.encryptChunk(second, 1),
  ];
  return {
    plaintext,
    ciphertext: join([ctx.header, ...records]),
  };
}

function ranges(bytes) {
  return async (start, end) => bytes.slice(start, end);
}

test('purpose-specific capability authorizes only its derived resource id', async () => {
  const capability = await deriveCapability('room-fragment-secret', 'room');
  const id = await capabilityId(capability);
  assert.equal(await verifyScopedCapability(id, capability), true);
  assert.equal(await verifyScopedCapability('0000000000000000', capability), false);
});

test('room codes contain eight independently generated EFF words', async () => {
  const code = generateRoomCodeFromWords(roomWords);
  const parts = code.split('.');
  assert.equal(parts.length, 8);
  assert.equal(await validateRoomCode(parts.join(' '), roomWords), code);
  assert.equal(normalizeRoomCode(`  ${parts.join('  ')}  `), code);
  await assert.rejects(() => validateRoomCode(`${parts.slice(0, 7).join('.')}.notaword`, roomWords));
});

test('RSv2 decrypts a complete authenticated multipart structure', async () => {
  const { plaintext, ciphertext } = await makeCiphertext();
  assert.equal(new TextDecoder().decode(ciphertext.slice(0, 4)), 'RSv2');
  const decrypted = await collect(decryptChunked(
    ciphertext.slice(0, RSv2_HEADER_LEN),
    '',
    '0123456789abcdef0123456789abcdef',
    ranges(ciphertext),
    undefined,
    ciphertext.length,
  ));
  assert.deepEqual(decrypted, plaintext);
});

test('RSv2 rejects authenticated-header modification', async () => {
  const { ciphertext } = await makeCiphertext();
  const tampered = new Uint8Array(ciphertext);
  tampered[12] ^= 1;
  await assert.rejects(() => collect(decryptChunked(
    tampered.slice(0, RSv2_HEADER_LEN),
    '',
    '0123456789abcdef0123456789abcdef',
    ranges(tampered),
    undefined,
    tampered.length,
  )));
});

test('RSv2 rejects truncated and appended structures', async () => {
  const { ciphertext } = await makeCiphertext();
  const truncated = ciphertext.slice(0, -1);
  await assert.rejects(() => collect(decryptChunked(
    truncated.slice(0, RSv2_HEADER_LEN),
    '',
    '0123456789abcdef0123456789abcdef',
    ranges(truncated),
    undefined,
    truncated.length,
  )));

  const appended = join([ciphertext, new Uint8Array([0])]);
  await assert.rejects(() => collect(decryptChunked(
    appended.slice(0, RSv2_HEADER_LEN),
    '',
    '0123456789abcdef0123456789abcdef',
    ranges(appended),
    undefined,
    appended.length,
  )));
});

test('multipart sizing covers the header-offset boundary', () => {
  const chunkSize = 128 * 1024 * 1024;
  assert.equal(multipartChunkCount(chunkSize * 4, chunkSize), 5);
});

test('origin gate uses exact origins rather than prefix matching', () => {
  const env = { FRONTEND_ORIGIN: 'https://relaysecret.example' };
  const allowed = new Request('https://api.example/test', {
    headers: { Origin: 'https://relaysecret.example' },
  });
  const prefixedAttacker = new Request('https://api.example/test', {
    headers: { Origin: 'https://relaysecret.example.attacker.test' },
  });
  assert.equal(refererGate(allowed, env), null);
  assert.equal(refererGate(prefixedAttacker, env).status, 403);
});

test('object deletion requires the capability bound at upload time', async () => {
  const capability = await deriveCapability('fragment', 'object-delete');
  const expectedDigest = await capabilityDigest(capability);
  let deleted = false;
  const binding = {
    async head() {
      return { customMetadata: { deleteauth: expectedDigest } };
    },
    async delete() {
      deleted = true;
    },
  };
  const env = {
    FRONTEND_ORIGIN: 'devmode',
    R2_US: binding,
    R2_US_BUCKET: 'test',
  };
  const key = `1day/${'a'.repeat(64)}`;
  const url = new URL(`https://api.example/obj?region=us&key=${key}`);

  const denied = await deleteObj(url, new Request(url), env);
  assert.equal(denied.status, 403);
  assert.equal(deleted, false);

  const allowed = await deleteObj(url, new Request(url, {
    headers: { 'X-Relay-Capability': capability },
  }), env);
  assert.equal(allowed.status, 200);
  assert.equal(deleted, true);
});

test('rate limits and configured Turnstile fail closed', async () => {
  const deny = { async limit() { return { success: false }; } };
  const request = new Request('https://api.example/presign/put', {
    headers: { 'CF-Connecting-IP': '192.0.2.1' },
  });
  const rateResponse = await enforceRateLimits(
    request,
    { FRONTEND_ORIGIN: 'devmode', API_RATE_LIMITER: deny },
    '/presign/put',
    'GET',
  );
  assert.equal(rateResponse.status, 429);

  const challengeResponse = await enforceTurnstile(
    request,
    { FRONTEND_ORIGIN: 'devmode', TURNSTILE_SECRET: 'configured-secret' },
  );
  assert.equal(challengeResponse.status, 403);
});

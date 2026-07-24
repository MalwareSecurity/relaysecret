// High-entropy, manually enterable room codes.
//
// Eight independent selections from EFF's 7,776-word long list provide about
// 103 bits of entropy. Rejection sampling prevents modulo bias.

import { sha256Hex } from './crypto.js';

const WORDLIST_URL = '/assets/eff_large_wordlist.txt';
const WORD_COUNT = 8;
const EXPECTED_LIST_SIZE = 7776;
let cachedWords;

export function parseRoomWordList(text) {
  const words = String(text)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/).at(-1));

  if (
    words.length !== EXPECTED_LIST_SIZE ||
    new Set(words).size !== EXPECTED_LIST_SIZE ||
    words.some((word) => !/^[a-z]+(?:-[a-z]+)*$/.test(word))
  ) {
    throw new Error('The room-code word list is invalid.');
  }
  return words;
}

export async function roomWordList() {
  if (cachedWords) return cachedWords;
  const response = await fetch(WORDLIST_URL, { cache: 'force-cache' });
  if (!response.ok) throw new Error('Could not load the room-code word list.');
  cachedWords = parseRoomWordList(await response.text());
  return cachedWords;
}

function randomIndex(size) {
  const range = 0x100000000;
  const ceiling = Math.floor(range / size) * size;
  const sample = new Uint32Array(1);
  do {
    crypto.getRandomValues(sample);
  } while (sample[0] >= ceiling);
  return sample[0] % size;
}

export function generateRoomCodeFromWords(words) {
  if (!Array.isArray(words) || words.length !== EXPECTED_LIST_SIZE) {
    throw new Error('The room-code word list is unavailable.');
  }
  return Array.from({ length: WORD_COUNT }, () => words[randomIndex(words.length)]).join('.');
}

export async function generateRoomCode() {
  return generateRoomCodeFromWords(await roomWordList());
}

export function normalizeRoomCode(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s,_.]+/g, '.')
    .replace(/\.+/g, '.');
}

export async function validateRoomCode(value, words) {
  const code = normalizeRoomCode(value);
  const parts = code.split('.');
  if (parts.length !== WORD_COUNT || parts.some((word) => !/^[a-z]+(?:-[a-z]+)*$/.test(word))) {
    throw new Error('Enter all eight words, separated by spaces.');
  }
  const allowed = new Set(words || await roomWordList());
  const unknown = parts.find((word) => !allowed.has(word));
  if (unknown) throw new Error(`“${unknown}” is not a valid room-code word.`);
  return code;
}

export async function roomTempKey(value, words) {
  return sha256Hex(await validateRoomCode(value, words));
}

// capability.js — verify bearer capabilities without learning encryption keys.
//
// The browser derives a purpose-specific 256-bit capability from the secret in
// the URL fragment. The public resource id is the first 16 hex characters of
// SHA-256(capability). The Worker sees the capability, but never the fragment
// key used for encryption.

const HEX_256 = /^[a-f0-9]{64}$/;
const HEX_64 = /^[a-f0-9]{16}$/;

function toHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

function constantTimeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function readCapability(request) {
  return (request.headers.get('X-Relay-Capability') || '').trim().toLowerCase();
}

export async function capabilityDigest(capability) {
  if (!HEX_256.test(capability)) return null;
  return sha256Hex(capability);
}

export async function verifyScopedCapability(resourceId, capability) {
  if (!HEX_64.test(resourceId) || !HEX_256.test(capability)) return false;
  const digest = await sha256Hex(capability);
  return constantTimeStringEqual(resourceId, digest.slice(0, 16));
}

export async function verifyCapabilityDigest(expectedDigest, capability) {
  if (!HEX_256.test(expectedDigest || '') || !HEX_256.test(capability)) return false;
  const digest = await sha256Hex(capability);
  return constantTimeStringEqual(expectedDigest, digest);
}

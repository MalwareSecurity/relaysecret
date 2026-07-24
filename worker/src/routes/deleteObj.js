// DELETE /obj?region=&key= — delete an object via the R2 binding.
// Binding-based delete is simpler and cheaper than presigning a DELETE.

import { jsonResponse, errorResponse } from '../util/json.js';
import { resolveRegion } from '../util/regions.js';
import { KEY_REGEX, tunnelHash } from '../util/keys.js';
import {
  readCapability,
  verifyCapabilityDigest,
  verifyScopedCapability,
} from '../util/capability.js';

export async function deleteObj(url, request, env) {
  const q = url.searchParams;
  const region = resolveRegion(q.get('region'), env);

  const key = q.get('key') || '';
  if (!KEY_REGEX.test(key)) {
    return errorResponse('invalid key', 'BAD_INPUT', 400, env, request);
  }
  if (!region.binding) {
    return errorResponse('region unavailable', 'NO_BINDING', 500, env, request);
  }

  const capability = readCapability(request);
  const room = (q.get('room') || '').toLowerCase();

  if (room) {
    if (!await verifyScopedCapability(room, capability)) {
      return errorResponse('delete authorization failed', 'FORBIDDEN', 403, env, request);
    }
    const expectedPrefix = `1day/${await tunnelHash(room)}/`;
    if (!key.startsWith(expectedPrefix)) {
      return errorResponse('delete authorization failed', 'FORBIDDEN', 403, env, request);
    }
  } else {
    const head = await region.binding.head(key);
    const expectedDigest = head?.customMetadata?.deleteauth || '';
    if (!head || !await verifyCapabilityDigest(expectedDigest, capability)) {
      return errorResponse('delete authorization failed', 'FORBIDDEN', 403, env, request);
    }
  }

  await region.binding.delete(key);
  return jsonResponse({ ok: true, key }, 200, env, request);
}

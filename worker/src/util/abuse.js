// abuse.js — route-class rate limiting for anonymous public endpoints.

import { errorResponse } from './json.js';

function clientKey(request) {
  // This header is set by Cloudflare at the edge and cannot be supplied by an
  // Internet client to the Worker. Anonymous applications have no better
  // stable actor identifier; Turnstile adds a second control for costly writes.
  return request.headers.get('CF-Connecting-IP') || 'unknown-client';
}

async function limited(binding, key) {
  if (!binding || typeof binding.limit !== 'function') return false;
  const result = await binding.limit({ key });
  return !result.success;
}

export async function enforceRateLimits(request, env, pathname, method) {
  const key = clientKey(request);

  if (await limited(env.API_RATE_LIMITER, key)) {
    return errorResponse('rate limit exceeded', 'RATE_LIMITED', 429, env, request, {
      'Retry-After': '60',
    });
  }

  const isMutation =
    pathname === '/presign/put' ||
    pathname === '/presign/tunnel-put' ||
    pathname === '/presign/multipart-init' ||
    (pathname.startsWith('/clipboard/') && method === 'POST') ||
    (pathname === '/obj' && method === 'DELETE');

  if (isMutation && await limited(env.MUTATION_RATE_LIMITER, key)) {
    return errorResponse('mutation rate limit exceeded', 'RATE_LIMITED', 429, env, request, {
      'Retry-After': '60',
    });
  }

  const isExpensive =
    pathname === '/presign/multipart-init' || pathname.startsWith('/sha1/');

  if (isExpensive && await limited(env.EXPENSIVE_RATE_LIMITER, key)) {
    return errorResponse('expensive-operation rate limit exceeded', 'RATE_LIMITED', 429, env, request, {
      'Retry-After': '60',
    });
  }

  return null;
}

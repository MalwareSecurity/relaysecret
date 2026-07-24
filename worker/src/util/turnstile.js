// turnstile.js — optional server-side validation for costly write operations.

import { errorResponse } from './json.js';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const EXPECTED_ACTION = 'turnstile-spin-v2';

function enabled(env) {
  return !!env.TURNSTILE_SECRET && env.TURNSTILE_SECRET !== 'none';
}

function allowedHostnames(env) {
  if (!env.FRONTEND_ORIGIN || env.FRONTEND_ORIGIN === 'devmode') return null;
  const hosts = [];
  for (const value of env.FRONTEND_ORIGIN.split(',')) {
    try {
      hosts.push(new URL(value.trim()).hostname);
    } catch {
      // Deployment validation should reject malformed origins. Ignore here so
      // a malformed optional entry cannot make a valid hostname pass.
    }
  }
  return hosts;
}

export function requiresHumanCheck(pathname, method) {
  return (
    pathname === '/presign/put' ||
    pathname === '/presign/tunnel-put' ||
    pathname === '/presign/multipart-init' ||
    (pathname.startsWith('/clipboard/') && method === 'POST')
  );
}

export async function enforceTurnstile(request, env) {
  if (!enabled(env)) return null;

  const token = request.headers.get('X-Turnstile-Token') || '';
  if (!token || token.length > 2048) {
    return errorResponse('human verification required', 'TURNSTILE_REQUIRED', 403, env, request);
  }

  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET);
  body.set('response', token);
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) body.set('remoteip', clientIp);
  body.set('idempotency_key', crypto.randomUUID());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetch(SITEVERIFY, {
      method: 'POST',
      body,
      signal: controller.signal,
    });
  } catch {
    return errorResponse('human verification unavailable', 'TURNSTILE_UNAVAILABLE', 503, env, request);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return errorResponse('human verification unavailable', 'TURNSTILE_UNAVAILABLE', 503, env, request);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    return errorResponse('human verification unavailable', 'TURNSTILE_UNAVAILABLE', 503, env, request);
  }

  const hosts = allowedHostnames(env);
  const hostnameOk = !hosts || hosts.includes(result.hostname);
  if (!result.success || result.action !== EXPECTED_ACTION || !hostnameOk) {
    return errorResponse('human verification failed', 'TURNSTILE_FAILED', 403, env, request);
  }
  return null;
}

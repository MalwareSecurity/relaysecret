// json.js — tiny response helpers. Every route returns JSON; keeping these
// centralised means CORS headers and error shape stay consistent.

import { corsHeaders } from './cors.js';

export function jsonResponse(body, status, env, request, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(env, request),
      ...extraHeaders,
    },
  });
}

// errorResponse matches the contract in docs/API.md: { error, code } + status.
export function errorResponse(message, code, status, env, request, extraHeaders = {}) {
  return jsonResponse({ error: message, code }, status, env, request, extraHeaders);
}

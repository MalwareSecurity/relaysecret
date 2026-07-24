// Thin wrappers around every Worker route documented in docs/API.md.
// All URLs built from window.CONFIG.workerUrl. Every function throws
// ApiError on non-2xx so callers can branch on .code / .status.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || ('HTTP ' + status));
    this.status = status;
    this.code = code || 'HTTP_' + status;
  }
}

function base() {
  const u = (window.CONFIG && window.CONFIG.workerUrl) || '';
  return u.replace(/\/$/, '');
}

function turnstileEnabled() {
  const key = (window.CONFIG && window.CONFIG.turnstileSiteKey) || '';
  return !!key && key !== 'none' && !key.startsWith('<');
}

const TURNSTILE_EVENT = 'relaysecret:turnstile-state';

function announceTurnstileState(state) {
  document.dispatchEvent(new CustomEvent(TURNSTILE_EVENT, { detail: { state } }));
}

// These names are referenced by data-* callback attributes on each widget.
// Keep the callbacks tiny: page-specific UI is managed by
// createTurnstileController below.
window.relaySecretTurnstileReady = () => announceTurnstileState('ready');
window.relaySecretTurnstileError = () => announceTurnstileState('error');
window.relaySecretTurnstileExpired = () => announceTurnstileState('expired');
window.relaySecretTurnstileTimeout = () => announceTurnstileState('timeout');

/**
 * Keep a protected action's button and status text in sync with the implicit
 * Turnstile widget. The backend remains the source of truth; this is only a
 * clear, fail-closed frontend state.
 */
export function createTurnstileController({ button, status, canSubmit }) {
  const configured = turnstileEnabled();
  let ready = !configured;
  let scriptLoaded = !configured;
  let loadTimer = null;

  function setVerificationStatus(message, kind = null) {
    if (!status) return;
    status.textContent = message;
    status.classList.remove('status-ok', 'status-err', 'status-warn');
    if (kind === 'ok') status.classList.add('status-ok');
    if (kind === 'err') status.classList.add('status-err');
    if (kind === 'warn') status.classList.add('status-warn');
  }

  function sync() {
    if (!button) return;
    const actionReady = typeof canSubmit === 'function' ? canSubmit() : true;
    button.disabled = !actionReady || !ready;
  }

  function hasToken() {
    const field = document.querySelector('[name="cf-turnstile-response"]');
    return !!(field && field.value);
  }

  function markReady() {
    ready = true;
    if (loadTimer) clearTimeout(loadTimer);
    setVerificationStatus('Human verification complete.', 'ok');
    sync();
  }

  function markPending(message, kind = null) {
    ready = false;
    setVerificationStatus(message, kind);
    sync();
  }

  function onState(event) {
    switch (event.detail && event.detail.state) {
      case 'ready':
        markReady();
        break;
      case 'error':
        markPending('Human verification is temporarily unavailable. It will retry automatically.', 'err');
        break;
      case 'expired':
        markPending('Human verification expired. Complete it again to continue.', 'warn');
        break;
      case 'timeout':
        markPending('Human verification timed out. Complete it again to continue.', 'warn');
        break;
      case 'reset':
        markPending('Complete human verification again to continue.');
        break;
      default:
        break;
    }
  }

  if (!configured) {
    setVerificationStatus('');
    sync();
    return { get ready() { return true; }, sync };
  }

  document.addEventListener(TURNSTILE_EVENT, onState);
  markPending('Loading human verification…');

  // A callback may have fired before this page module finished evaluating.
  // Polling also catches browser extensions or privacy tools that suppress the
  // normal callback while still allowing the response field to be populated.
  const poll = window.setInterval(() => {
    if (hasToken()) {
      markReady();
      return;
    }
    if (!scriptLoaded && window.turnstile) {
      scriptLoaded = true;
      setVerificationStatus('Complete human verification to continue.');
    }
  }, 250);

  loadTimer = window.setTimeout(() => {
    const widgetFrame = document.querySelector('.cf-turnstile iframe');
    if ((!window.turnstile || !widgetFrame) && !hasToken()) {
      markPending('Human verification could not load. Check your connection or content blocker, then reload.', 'err');
    }
  }, 12000);

  window.addEventListener('pagehide', () => {
    window.clearInterval(poll);
    if (loadTimer) window.clearTimeout(loadTimer);
    document.removeEventListener(TURNSTILE_EVENT, onState);
  }, { once: true });

  return { get ready() { return ready; }, sync };
}

function turnstileToken() {
  if (!turnstileEnabled()) return '';
  const field = document.querySelector('[name="cf-turnstile-response"]');
  const token = field && field.value;
  if (!token) {
    throw new ApiError(403, 'TURNSTILE_REQUIRED', 'Complete the human verification first.');
  }
  return token;
}

function resetTurnstile() {
  if (turnstileEnabled() && window.turnstile && typeof window.turnstile.reset === 'function') {
    window.turnstile.reset();
    announceTurnstileState('reset');
  }
}

function authHeaders(capability, human = false) {
  const headers = {};
  if (capability) headers['X-Relay-Capability'] = capability;
  if (human) {
    const token = turnstileToken();
    if (token) headers['X-Turnstile-Token'] = token;
  }
  return headers;
}

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

async function parse(res) {
  let body = null;
  try { body = await res.json(); } catch (_) { /* non-JSON */ }
  if (!res.ok) {
    const code = body && body.code;
    const msg  = body && body.error;
    throw new ApiError(res.status, code, msg);
  }
  return body;
}

async function getJSON(path, params, headers) {
  const res = await fetch(base() + path + qs(params || {}), { headers: headers || {} });
  return parse(res);
}

async function postJSON(path, params, headers) {
  const res = await fetch(base() + path + qs(params || {}), {
    method: 'POST',
    headers: headers || {},
  });
  return parse(res);
}

// --- R2 presign: single-recipient send ---------------------------------
export async function getUploadPresign({ region, expire, filename, deleteOnDownload, deleteAuth }) {
  const params = {
    region, expire, filename,
    deleteOnDownload: deleteOnDownload ? 'true' : 'false',
    deleteAuth,
  };
  try {
    return await getJSON('/presign/put', params, authHeaders('', true));
  } finally {
    resetTurnstile();
  }
}

// --- R2 presign: tunnel/room upload (always 1 day) ---------------------
export async function getTunnelUploadPresign({ region, tunnel, filename, deleteOnDownload, capability }) {
  const params = {
    region, tunnel, filename,
    deleteOnDownload: deleteOnDownload ? 'true' : 'false',
  };
  try {
    return await getJSON('/presign/tunnel-put', params, authHeaders(capability, true));
  } finally {
    resetTurnstile();
  }
}

// --- R2 presign: download ---------------------------------------------
export function getDownloadPresign({ region, key }) {
  return getJSON('/presign/get', { region, key });
}

// --- R2 presign: multipart upload (large files) -----------------------
export async function getMultipartPresign({
  region, expire, filename, chunks, deleteOnDownload, tunnel, capability, deleteAuth,
}) {
  const params = {
    region, expire, filename, chunks,
    deleteOnDownload: deleteOnDownload ? 'true' : 'false',
    deleteAuth,
  };
  if (tunnel) params.tunnel = tunnel;
  try {
    return await postJSON(
      '/presign/multipart-init',
      params,
      authHeaders(capability, true),
    );
  } finally {
    resetTurnstile();
  }
}

// --- Tunnel file listing ----------------------------------------------
export function listTunnel({ region, tunnel, capability }) {
  return getJSON('/tunnel/list', { region, tunnel }, authHeaders(capability));
}

// --- Delete an object (bypasses presigning) ---------------------------
export async function deleteObject({ region, key, capability, room }) {
  const res = await fetch(base() + '/obj' + qs({ region, key, room }), {
    method: 'DELETE',
    headers: authHeaders(capability),
  });
  return parse(res);
}

// --- VirusTotal SHA1 proxy --------------------------------------------
export function checkSha1(hash) {
  return getJSON('/sha1/' + encodeURIComponent(hash));
}

// --- Clipboard KV -----------------------------------------------------
export function clipboardGet(id, capability) {
  return getJSON('/clipboard/' + encodeURIComponent(id), {}, authHeaders(capability));
}

export async function clipboardPut(id, hexData, capability) {
  try {
    const res = await fetch(base() + '/clipboard/' + encodeURIComponent(id), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(capability, true),
      },
      body: JSON.stringify({ data: hexData }),
    });
    return parse(res);
  } finally {
    resetTurnstile();
  }
}

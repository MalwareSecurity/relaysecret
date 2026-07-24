// clipboard.js — controller for /clipboard/.
//
// Tunnel id is derived the same way as the tunnel room page:
//   tempKey   = sha256(userName) hex            (stays in URL fragment)
//   clipId    = first 16 chars of sha256(tempKey)  (query param)
//
// Transport is hex strings via the Worker /clipboard/:id KV endpoints.

import {
  encryptBlob,
  decryptBlob,
  sha256Hex,
  deriveCapability,
  capabilityId,
} from './crypto.js';
import { clipboardGet, clipboardPut, ApiError } from './api.js';
import {
  $, setStatus, getQueryParams, getFragment, bytesToHex, hexToBytes,
} from './ui.js';

const state = { clipId: '', tempKey: '', capability: '' };

function disableClipboardActions() {
  $('btnGet').disabled = true;
  $('btnUpdate').disabled = true;
}

async function boot() {
  const q = getQueryParams();
  state.tempKey = getFragment();
  if (!q.clipboardid || !state.tempKey) {
    const raw = window.prompt('Enter clipboard id (min 8 characters)');
    if (raw === null) {
      disableClipboardActions();
      setStatus($('clipInfo'), 'No clipboard selected. Switch to Send or Tunnel, or reload to try again.', 'err');
      return;
    }
    const name = raw.trim();
    if (name.length < 8) {
      disableClipboardActions();
      setStatus($('clipInfo'), 'Clipboard id must be at least 8 characters. Reload to try again.', 'err');
      return;
    }
    const tempKey = await sha256Hex(name);
    const capability = await deriveCapability(tempKey, 'clipboard');
    const id = await capabilityId(capability);
    window.location.href = window.location.pathname + '?clipboardid=' + id + '#' + tempKey;
    return;
  }
  state.capability = await deriveCapability(state.tempKey, 'clipboard');
  const expectedId = await capabilityId(state.capability);
  if (q.clipboardid !== expectedId) {
    disableClipboardActions();
    setStatus($('clipInfo'), 'Clipboard link is invalid or incomplete.', 'err');
    return;
  }
  state.clipId = expectedId;
  $('clipInfo').textContent = 'Clipboard id: ' + state.clipId;
}

$('btnUpdate').onclick = async () => {
  try {
    document.body.classList.add('busy');
    setStatus($('status'), 'Reading local clipboard…');
    const text = await navigator.clipboard.readText();
    if (!text) { setStatus($('status'), 'Nothing to upload.', 'warn'); return; }

    setStatus($('status'), 'Encrypting…');
    const plain = new TextEncoder().encode(text);
    const blob = await encryptBlob(plain, $('passInput').value, state.tempKey);

    setStatus($('status'), 'Uploading…');
    await clipboardPut(state.clipId, bytesToHex(blob), state.capability);
    setStatus($('status'), 'Clipboard updated.', 'ok');
  } catch (err) {
    console.error(err);
    setStatus($('status'), 'Update failed: ' + (err.message || err), 'err');
  } finally {
    document.body.classList.remove('busy');
  }
};

$('btnGet').onclick = async () => {
  try {
    document.body.classList.add('busy');
    setStatus($('status'), 'Fetching…');
    let payload;
    try {
      payload = await clipboardGet(state.clipId, state.capability);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setStatus($('status'), 'No clipboard data yet.', 'warn');
        return;
      }
      throw err;
    }
    if (!payload || !payload.data) {
      setStatus($('status'), 'Empty clipboard.', 'warn');
      return;
    }
    setStatus($('status'), 'Decrypting…');
    const cipher = hexToBytes(payload.data);
    const plain  = await decryptBlob(cipher, $('passInput').value, state.tempKey);
    const text   = new TextDecoder().decode(plain);

    await navigator.clipboard.writeText(text);
    setStatus($('status'), 'Copied to local clipboard (' + text.length + ' chars).', 'ok');
  } catch (err) {
    console.error(err);
    setStatus($('status'), 'Get failed — wrong password or tampered data.', 'err');
  } finally {
    document.body.classList.remove('busy');
  }
};

boot();

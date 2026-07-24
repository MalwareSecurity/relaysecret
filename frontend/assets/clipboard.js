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
import { generateRoomCode } from './room-code.js';
import {
  $, setStatus, getQueryParams, getFragment, bytesToHex, hexToBytes,
  copyToClipboard,
} from './ui.js';

const state = { clipId: '', tempKey: '', capability: '' };

function clipboardUrl(id, tempKey) {
  return window.location.origin + window.location.pathname +
    '?clipboardid=' + encodeURIComponent(id) + '#' + tempKey;
}

function showEntry(message = '', kind = null) {
  $('clipboardEntry').classList.remove('hidden');
  $('clipboardWorkspace').classList.add('hidden');
  setStatus($('clipboardEntryStatus'), message, kind);
}

function showWorkspace() {
  $('clipboardEntry').classList.add('hidden');
  $('clipboardWorkspace').classList.remove('hidden');
  $('clipInfo').textContent = 'Encrypted · expires after 1 day';
  $('clipboardUrlDisplay').textContent = clipboardUrl(state.clipId, state.tempKey);
}

async function openClipboard(nameInput) {
  const name = String(nameInput || '').trim();
  if (name.length < 8) {
    throw new Error('Enter at least 8 characters.');
  }
  const tempKey = await sha256Hex(name);
  const capability = await deriveCapability(tempKey, 'clipboard');
  const id = await capabilityId(capability);
  window.location.assign(clipboardUrl(id, tempKey));
}

async function boot() {
  const q = getQueryParams();
  state.tempKey = getFragment();
  if (!q.clipboardid || !state.tempKey) {
    showEntry();
    return;
  }
  state.capability = await deriveCapability(state.tempKey, 'clipboard');
  const expectedId = await capabilityId(state.capability);
  if (q.clipboardid !== expectedId) {
    showEntry('The clipboard link is invalid or incomplete.', 'err');
    return;
  }
  state.clipId = expectedId;
  showWorkspace();
}

$('btnCreateClipboard').onclick = async () => {
  const button = $('btnCreateClipboard');
  try {
    button.disabled = true;
    setStatus($('clipboardEntryStatus'), 'Generating a secure clipboard…');
    await openClipboard(await generateRoomCode());
  } catch (err) {
    button.disabled = false;
    setStatus($('clipboardEntryStatus'), err.message || 'Could not create the clipboard.', 'err');
  }
};

$('btnJoinClipboard').onclick = async () => {
  const button = $('btnJoinClipboard');
  try {
    button.disabled = true;
    setStatus($('clipboardEntryStatus'), 'Opening clipboard…');
    await openClipboard($('clipboardNameInput').value);
  } catch (err) {
    button.disabled = false;
    setStatus($('clipboardEntryStatus'), err.message || 'Could not open the clipboard.', 'err');
  }
};

$('clipboardNameInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('btnJoinClipboard').click();
  }
});

$('btnCopyClipboardUrl').onclick = async () => {
  const ok = await copyToClipboard(clipboardUrl(state.clipId, state.tempKey));
  setStatus($('status'), ok ? 'Clipboard link copied.' : 'Copy failed — select the link manually.', ok ? 'ok' : 'warn');
};

$('btnPaste').onclick = async () => {
  try {
    $('clipText').value = await navigator.clipboard.readText();
    setStatus($('status'), 'Pasted from this device.', 'ok');
  } catch (_) {
    $('clipText').focus();
    setStatus($('status'), 'Clipboard permission was unavailable. Paste into the text box instead.', 'warn');
  }
};

$('btnCopy').onclick = async () => {
  const text = $('clipText').value;
  if (!text) {
    setStatus($('status'), 'There is no text to copy.', 'warn');
    return;
  }
  const ok = await copyToClipboard(text);
  setStatus($('status'), ok ? 'Copied to this device.' : 'Copy permission was unavailable. Select the text manually.', ok ? 'ok' : 'warn');
};

$('btnUpdate').onclick = async () => {
  try {
    document.body.classList.add('busy');
    const text = $('clipText').value;
    if (!text) {
      setStatus($('status'), 'Enter or paste some text first.', 'warn');
      $('clipText').focus();
      return;
    }

    setStatus($('status'), 'Encrypting…');
    const plain = new TextEncoder().encode(text);
    const blob = await encryptBlob(plain, $('passInput').value, state.tempKey);

    setStatus($('status'), 'Uploading…');
    await clipboardPut(state.clipId, bytesToHex(blob), state.capability);
    setStatus($('status'), 'Shared text updated.', 'ok');
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
    const text = new TextDecoder().decode(plain);
    $('clipText').value = text;
    setStatus($('status'), 'Shared text loaded (' + text.length + ' characters).', 'ok');
  } catch (err) {
    console.error(err);
    setStatus($('status'), 'Get failed — wrong password or tampered data.', 'err');
  } finally {
    document.body.classList.remove('busy');
  }
};

boot();

// tunnel.js — controller for /tunnel/. Room mode.
//
// URL format: /tunnel/?tunnelid=<16hex>#<eight-word-room-code>
//   - the generated room code stays in the URL fragment
//   - tempkey = SHA-256(normalized room code)
//   - tunnelid derives from a separate room capability
//
// If the URL has no room, the page offers secure generation or manual entry.

// XML-escape a string for safe interpolation into XML bodies (e.g. ETag values
// in CompleteMultipartUpload). R2/S3 ETags are typically quoted MD5 hex strings
// and will never contain these characters in practice, but defensive escaping
// prevents any unexpected value from producing malformed XML.
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

import {
  encryptBlob,
  decryptBlob,
  deriveCapability,
  capabilityId,
  createChunkedEncryptContext,
  multipartChunkCount,
  chunkedMetadata,
  decryptChunked,
  detectFormat,
  RSv2_HEADER_LEN,
} from './crypto.js';
import {
  generateRoomCode,
  roomTempKey,
  validateRoomCode,
} from './room-code.js';
import {
  getTunnelUploadPresign, getDownloadPresign, getMultipartPresign, listTunnel, deleteObject,
} from './api.js';
import {
  $, formatBytes, setStatus, getQueryParams, getFragment,
  safeFilename, readFileBytes, createProgressFlow, createUploadProgressBar,
  streamDecryptedDownload, showImageModal, copyToClipboard, renderQrCode,
} from './ui.js';

const REGION = 'us'; // Tunnels are pinned to us for now (matches backend default).
const CHUNK_THRESHOLD = 500 * 1024 * 1024; // 500 MB
const CHUNK_SIZE      = 128 * 1024 * 1024;  // 128 MB

const state = {
  tunnelId: '',
  roomCode: '',
  tempKey: '',
  capability: '',
  file: null,
  ready: false, // true once we have a valid tunnelid + tempkey
  currentDecrypt: null, // { file, blobUrl, rowEl } — the row currently in "Download" state
};

// Read the tunnel temp key FRESH from the URL fragment at every action.
// Relying on a cached `state.tempKey` was causing a symmetry bug where the
// encrypt side and decrypt side could end up with different values (stale
// state, autofill on an old field, back/forward navigation, etc.).
function currentTempKey() {
  return state.tempKey;
}

// Read+normalize a password field's value. Trim handles iOS keyboard
// autofill which can insert a leading/trailing space.
function readPass(id) {
  const el = $(id);
  return el ? (el.value || '').trim() : '';
}

// Revert the currently-"ready" row back to "idle" and revoke its blob URL.
// Called at the start of every decryptOne, inside deleteOne, and inside refreshList.
function resetCurrentDecrypt() {
  if (!state.currentDecrypt) return;
  if (state.currentDecrypt.blobUrl) {
    URL.revokeObjectURL(state.currentDecrypt.blobUrl);
  }
  const row = state.currentDecrypt.rowEl;
  if (row && row.isConnected) {
    row.dataset.state = 'idle';
    const btn = row.querySelector('.row-action-btn');
    if (btn) {
      btn.textContent = 'Decrypt';
      btn.className = 'row-action-btn';
      btn.disabled = false;
    }
  }
  state.currentDecrypt = null;
}

// Lazily create the encrypt / decrypt progress flow widgets.
// (Re-)create the correct progress flow for each upload. RSv1 and RSv2 have
// different step lists, and both write to the same #encProgress container, so
// we avoid caching to prevent stale node references across upload attempts.
let _decFlow = null;
function encFlow() {
  return createProgressFlow($('encProgress'), [
    'Read the file from disk',
    'Derive AES key (PBKDF2-SHA256, 600 000 iters)',
    'Encrypt with AES-GCM-256 in your browser',
    'Request a short-lived R2 upload URL',
    'Upload ciphertext directly to R2',
  ]);
}
function encFlowChunked() {
  return createProgressFlow($('encProgress'), [
    'Request multipart upload URLs',
    'Derive AES key (PBKDF2-SHA256, 600 000 iters)',
    'Encrypt chunks with AES-GCM-256 in your browser',
    'Upload ciphertext directly to R2',
  ]);
}
function decFlow() {
  if (_decFlow) return _decFlow;
  _decFlow = createProgressFlow($('decProgress'), [
    'Request a short-lived R2 download URL',
    'Download ciphertext from R2',
    'Derive AES key (PBKDF2-SHA256, 600 000 iters)',
    'Verify auth tag & decrypt (AES-GCM-256)',
  ]);
  return _decFlow;
}

// ---------------------------------------------------------------- bootstrap / room creation
async function boot() {
  const q = getQueryParams();
  const rawCode = getFragment();
  if (!q.tunnelid || !rawCode) {
    showRoomEntry();
    return;
  }

  try {
    state.roomCode = await validateRoomCode(rawCode);
    state.tempKey = await roomTempKey(state.roomCode);
    state.capability = await deriveCapability(state.tempKey, 'room');
  } catch (err) {
    disableTunnelActions();
    showRoomEntry();
    setStatus($('roomEntryStatus'), err.message || 'The room link is invalid.', 'err');
    return;
  }

  const expectedId = await capabilityId(state.capability);
  if (q.tunnelid !== expectedId) {
    disableTunnelActions();
    showRoomEntry();
    setStatus($('roomEntryStatus'), 'The room link is invalid or incomplete.', 'err');
    return;
  }

  state.tunnelId = expectedId;
  state.ready = true;
  showRoomWorkspace();
  $('tunnelInfo').textContent = 'Encrypted room · expires in 1 day · region ' + REGION.toUpperCase();
  await refreshList();
}

function disableTunnelActions() {
  state.ready = false;
  $('btnUpload').disabled = true;
  $('btnRefresh').disabled = true;
}

function showRoomEntry() {
  $('roomEntry').classList.remove('hidden');
  for (const card of document.querySelectorAll('.room-workspace')) card.classList.add('hidden');
  $('decCard').classList.add('hidden');
}

function roomUrl(tunnel, code) {
  return window.location.origin + window.location.pathname +
    '?tunnelid=' + encodeURIComponent(tunnel) + '#' + code;
}

async function openRoom(codeInput) {
  const code = await validateRoomCode(codeInput);
  const tempKey = await roomTempKey(code);
  const capability = await deriveCapability(tempKey, 'room');
  const tunnel = await capabilityId(capability);
  window.location.assign(roomUrl(tunnel, code));
}

function showRoomWorkspace() {
  $('roomEntry').classList.add('hidden');
  for (const card of document.querySelectorAll('.room-workspace')) card.classList.remove('hidden');

  const url = roomUrl(state.tunnelId, state.roomCode);
  $('roomCodeDisplay').textContent = state.roomCode.replaceAll('.', ' ');
  $('roomUrlDisplay').textContent = url;
  renderQrCode($('roomQr'), url);
}

$('btnCreateRoom').onclick = async () => {
  const button = $('btnCreateRoom');
  try {
    button.disabled = true;
    setStatus($('roomEntryStatus'), 'Generating a secure room code…');
    await openRoom(await generateRoomCode());
  } catch (err) {
    button.disabled = false;
    setStatus($('roomEntryStatus'), err.message || 'Could not create the room.', 'err');
  }
};

$('btnJoinRoom').onclick = async () => {
  try {
    $('btnJoinRoom').disabled = true;
    setStatus($('roomEntryStatus'), 'Opening room…');
    await openRoom($('roomCodeInput').value);
  } catch (err) {
    $('btnJoinRoom').disabled = false;
    setStatus($('roomEntryStatus'), err.message || 'Could not open the room.', 'err');
  }
};

$('roomCodeInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('btnJoinRoom').click();
  }
});

$('btnCopyRoomCode').onclick = async () => {
  const ok = await copyToClipboard(state.roomCode.replaceAll('.', ' '));
  setStatus($('roomShareStatus'), ok ? 'Room code copied.' : 'Copy failed — select it manually.', ok ? 'ok' : 'warn');
};

$('btnCopyRoomUrl').onclick = async () => {
  const ok = await copyToClipboard(roomUrl(state.tunnelId, state.roomCode));
  setStatus($('roomShareStatus'), ok ? 'Room URL copied.' : 'Copy failed — select it manually.', ok ? 'ok' : 'warn');
};

// ---------------------------------------------------------------- list
async function refreshList() {
  resetCurrentDecrypt();
  $('decCard').classList.add('hidden');
  setStatus($('listStatus'), 'Loading files…');
  try {
    const resp = await listTunnel({
      region: REGION,
      tunnel: state.tunnelId,
      capability: state.capability,
    });

    // Ensure we have a valid array - handle cases where objects might be a non-array value
    let files = [];
    if (resp && Array.isArray(resp.objects)) {
      files = resp.objects;
    } else if (resp && resp.objects !== null && resp.objects !== undefined) {
      // Log unexpected response structure for debugging
      console.error('Unexpected response structure:', resp);
      throw new Error('Invalid response format: objects is not an array');
    }

    const truncated = !!(resp && resp.truncated);
    renderList(files);
    const label = files.length + ' file(s)' + (truncated ? ' (list capped at 200 — delete older files to see more)' : '');
    setStatus($('listStatus'), label, truncated ? 'warn' : null);
  } catch (err) {
    console.error('List error:', err);
    setStatus($('listStatus'), 'Failed to list: ' + (err.message || err), 'err');
  }
}

function renderList(files) {
  const tbody = $('fileListBody');
  tbody.textContent = '';
  if (files.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.className = 'muted';
    td.textContent = 'No files yet.';
    tr.append(td);
    tbody.append(tr);
    return;
  }
  for (const f of files) {
    const tr = document.createElement('tr');
    tr.dataset.state = 'idle';
    const tdName = document.createElement('td');
    tdName.className = 'name';
    tdName.textContent = safeFilename(f.objname) || '(unnamed)';
    const tdSize = document.createElement('td');
    tdSize.textContent = formatBytes(f.objsize);
    const tdActs = document.createElement('td');
    tdActs.className = 'actions';

    const btnDec = document.createElement('button');
    btnDec.className = 'row-action-btn';
    btnDec.textContent = 'Decrypt';
    btnDec.onclick = () => handleRowAction(f, tr, btnDec);
    const btnDel = document.createElement('button');
    btnDel.textContent = 'Delete';
    btnDel.onclick = () => deleteOne(f);

    tdActs.append(btnDec, btnDel);
    tr.append(tdName, tdSize, tdActs);
    tbody.append(tr);
  }
}

// Per-row button click: decrypt if idle, re-save if ready-with-blobUrl,
// re-decrypt if ready-without-blobUrl (picker path). No-op while decrypting.
function handleRowAction(f, tr, btn) {
  const rowState = tr.dataset.state;
  if (rowState === 'decrypting') return;
  if (rowState === 'ready' && state.currentDecrypt && state.currentDecrypt.blobUrl) {
    const a = document.createElement('a');
    a.href = state.currentDecrypt.blobUrl;
    a.download = safeFilename(state.currentDecrypt.file.objname) || 'file.bin';
    document.body.append(a);
    a.click();
    a.remove();
    return;
  }
  decryptOne(f, tr, btn);
}

$('btnRefresh').onclick = refreshList;

// ---------------------------------------------------------------- upload
const dz = $('dropzone');
$('dzPick').onclick = (e) => { e.preventDefault(); $('fileInput').click(); };
$('fileInput').onchange = (e) => { if (e.target.files[0]) setFile(e.target.files[0]); };
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
});

function setFile(f) {
  state.file = f;
  $('dzFileInfo').textContent = f.name + '  (' + formatBytes(f.size) + ')';
  $('filenameInput').value = f.name;
  dz.classList.add('filled');
  $('btnUpload').disabled = !state.ready;
}

$('btnUpload').onclick = async () => {
  if (!state.file) return;
  const isChunked = state.file.size > CHUNK_THRESHOLD;
  const flow = isChunked ? encFlowChunked() : encFlow();
  flow.show();
  flow.reset();
  let currentStep = 0;
  let uploadBar = null;
  try {
    document.body.classList.add('busy');
    setStatus($('uploadStatus'), 'Starting…');

    const filename = safeFilename($('filenameInput').value || state.file.name) || 'file.bin';
    const tempKey = currentTempKey();
    const pass = readPass('encPassInput');

    if (isChunked) {
      // ---- RSv2 authenticated chunked multipart path ----
      // Steps: 0=Request URLs, 1=Derive key, 2=Encrypt chunks, 3=Upload
      const file = state.file;
      const totalChunks = multipartChunkCount(file.size, CHUNK_SIZE);

      currentStep = 0;
      flow.start(0);
      setStatus($('uploadStatus'), 'Initiating multipart upload…');
      const mp = await getMultipartPresign({
        region: REGION, filename, chunks: totalChunks,
        deleteOnDownload: $('dodInput').checked,
        tunnel: state.tunnelId,
        capability: state.capability,
      });
      flow.done(0);

      currentStep = 1;
      flow.start(1);
      const ctx = await createChunkedEncryptContext(
        pass,
        tempKey,
        CHUNK_SIZE,
        file.size,
        totalChunks,
      );
      flow.done(1);

      currentStep = 2;
      flow.start(2);

      // --- Encrypt all parts sequentially (crypto context is stateful / ordered) ---
      // Part 1 carries the RSv2 header — reduce its plaintext by RSv2_HEADER_LEN
      // bytes so all non-trailing parts have equal wire size (R2 requirement).
      setStatus($('uploadStatus'), 'Encrypting…');
      const bodies = [];
      let chunkOffset = 0;
      for (let i = 0; i < mp.partUrls.length; i++) {
        const effectiveChunkSize = (i === 0) ? CHUNK_SIZE - RSv2_HEADER_LEN : CHUNK_SIZE;
        const end = Math.min(chunkOffset + effectiveChunkSize, file.size);
        const plainChunk = new Uint8Array(await file.slice(chunkOffset, end).arrayBuffer());
        const record = await ctx.encryptChunk(plainChunk, i);
        let body = record;
        if (i === 0) {
          body = new Uint8Array(ctx.header.length + record.length);
          body.set(ctx.header, 0);
          body.set(record, ctx.header.length);
        }
        bodies.push({ index: i, partNumber: mp.partUrls[i].partNumber, url: mp.partUrls[i].url, body, plainSize: plainChunk.length });
        chunkOffset = end;
      }
      if (chunkOffset !== file.size) throw new Error('Multipart plan did not cover the complete file.');
      flow.done(2);

      currentStep = 3;
      flow.start(3);

      // --- Upload parts with bounded concurrency (max 3 in-flight) ---
      const CONCURRENCY = 3;
      uploadBar = createUploadProgressBar($('uploadBar'), file.size);
      uploadBar.show();
      const bar = uploadBar;
      setStatus($('uploadStatus'), 'Uploading…');

      const partETags = new Array(bodies.length);
      let uploadedBytes = 0;
      let partsComplete = 0;

      async function uploadPart(part) {
        const putRes = await fetch(part.url, { method: 'PUT', body: part.body });
        if (!putRes.ok) throw new Error('Part ' + part.partNumber + ' failed: HTTP ' + putRes.status);
        partETags[part.index] = { partNumber: part.partNumber, etag: putRes.headers.get('ETag') || '' };
        uploadedBytes += part.plainSize;
        partsComplete++;
        bar.update(uploadedBytes, partsComplete, bodies.length);
      }

      const inFlight = new Set();
      for (let i = 0; i < bodies.length; i++) {
        const p = uploadPart(bodies[i]);
        inFlight.add(p);
        p.finally(() => inFlight.delete(p));
        if (inFlight.size >= CONCURRENCY) {
          await Promise.race(inFlight);
        }
      }
      await Promise.all(inFlight);

      bar.done();
      const partsXml = partETags
        .map(p => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
        .join('');
      const completeBody = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;
      const completeRes = await fetch(mp.completeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: completeBody,
      });
      if (!completeRes.ok) throw new Error('Complete multipart failed: HTTP ' + completeRes.status);
      flow.done(3);

      setStatus($('uploadStatus'), 'Uploaded and encrypted end-to-end.', 'ok');
    } else {
      // ---- RSv1 single-shot path ----
      flow.start(0);
      const plain = await readFileBytes(state.file);
      flow.done(0);

      currentStep = 1;
      flow.start(1);
      await new Promise((r) => setTimeout(r, 16));
      flow.done(1);

      flow.start(2);
      const blob = await encryptBlob(plain, pass, tempKey);
      flow.done(2);

      currentStep = 3;
      flow.start(3);
      setStatus($('uploadStatus'), 'Requesting upload URL…');
      const p = await getTunnelUploadPresign({
        region: REGION, tunnel: state.tunnelId, filename,
        deleteOnDownload: $('dodInput').checked,
        capability: state.capability,
      });
      flow.done(3);

      currentStep = 4;
      flow.start(4);
      setStatus($('uploadStatus'), 'Uploading ' + formatBytes(blob.length) + '…');
      const res = await fetch(p.url, { method: 'PUT', headers: p.requiredHeaders, body: blob });
      if (!res.ok) throw new Error('Upload HTTP ' + res.status);
      flow.done(4);

      setStatus($('uploadStatus'), 'Uploaded and encrypted end-to-end.', 'ok');
    }

    state.file = null;
    $('dzFileInfo').textContent = '';
    dz.classList.remove('filled');
    $('btnUpload').disabled = true;
    await refreshList();
  } catch (err) {
    console.error(err);
    flow.error(currentStep);
    if (uploadBar) uploadBar.error();
    setStatus($('uploadStatus'), err.message || 'Upload failed.', 'err');
  } finally {
    document.body.classList.remove('busy');
  }
};

// ---------------------------------------------------------------- decrypt one
async function decryptOne(f, tr, btn) {
  const card = $('decCard');
  const status = $('decStatus');
  const ta = $('decMsgOut');
  const img = $('decImg');
  card.classList.remove('hidden');
  ta.classList.add('hidden'); img.classList.add('hidden');

  // Reset any previously-"ready" row before starting a new decrypt.
  resetCurrentDecrypt();

  // Set this row to the "decrypting" state.
  tr.dataset.state = 'decrypting';
  btn.textContent = 'Decrypting…';
  btn.classList.add('primary');
  btn.disabled = true;

  let flow = null;
  let currentStep = 0;
  let downloadBar = null;
  try {
    flow = decFlow();
    flow.show();
    flow.reset();

    document.body.classList.add('busy');

    flow.start(0);
    setStatus(status, 'Fetching download URL…');
    const meta = await getDownloadPresign({ region: REGION, key: f.key });
    flow.done(0);

    currentStep = 1;
    flow.start(1);

    // Capture pass + tempkey ONCE — matches the encrypt side exactly.
    const tempKey = currentTempKey();
    const pass = readPass('decPassInput');

    // Detect format via the largest supported chunked header.
    setStatus(status, 'Detecting format…');
    const headRes = await fetch(meta.url, { headers: { Range: 'bytes=0-51' } });
    if (!headRes.ok) throw new Error('Header fetch failed: HTTP ' + headRes.status);
    const headerBytes = new Uint8Array(await headRes.arrayBuffer());
    const format = detectFormat(headerBytes);

    const name = safeFilename(meta.objname || f.objname) || 'file.bin';
    let plain = null;

    if (format === 'v2') {
      // ---- Chunked decrypt — RSv2 authenticates the complete structure. ----
      setStatus(status, 'Downloading & decrypting…');

      const { totalSize, totalChunks } = chunkedMetadata(headerBytes);

      downloadBar = createUploadProgressBar($('downloadBar'), totalSize, { partLabel: 'Chunk' });
      downloadBar.show();

      const fetchRange = async (start, end) => {
        const r = await fetch(meta.url, {
          headers: { Range: `bytes=${start}-${end - 1}` },
        });
        if (!r.ok) throw new Error('Range fetch failed: HTTP ' + r.status);
        return new Uint8Array(await r.arrayBuffer());
      };

      let totalDecrypted = 0;
      let chunksDone = 0;
      const chunkGen = decryptChunked(
        headerBytes,
        pass,
        tempKey,
        fetchRange,
        undefined,
        meta.objsize,
      );
      const { blobUrl, usedPicker } = await streamDecryptedDownload(
        name,
        chunkGen,
        (chunk) => {
          totalDecrypted += chunk.length;
          chunksDone++;
          downloadBar.update(totalDecrypted, chunksDone, totalChunks);
        },
      );
      downloadBar.done();
      flow.done(1);
      currentStep = 2; flow.start(2); flow.done(2);
      currentStep = 3; flow.start(3); flow.done(3);

      if (usedPicker) {
        // File was streamed straight to disk — no blob URL to keep.
        state.currentDecrypt = { file: f, blobUrl: null, rowEl: tr };
        setStatus(status, 'Decrypted and saved: ' + name, 'ok');
      } else {
        // Fallback: blob URL. Auto-trigger the save dialog once.
        state.currentDecrypt = { file: f, blobUrl, rowEl: tr };
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = name;
        document.body.append(a);
        a.click();
        a.remove();
        setStatus(status, 'Decrypted: ' + name, 'ok');
      }
    } else {
      // ---- RSv1 single-shot decrypt (small files only) ----
      setStatus(status, 'Downloading ciphertext…');
      const res = await fetch(meta.url);
      if (!res.ok) throw new Error('Download HTTP ' + res.status);
      const cipher = new Uint8Array(await res.arrayBuffer());
      flow.done(1);

      currentStep = 2;
      flow.start(2);
      await new Promise((r) => setTimeout(r, 16));
      flow.done(2);

      currentStep = 3;
      flow.start(3);
      setStatus(status, 'Verifying & decrypting…');
      plain = await decryptBlob(cipher, pass, tempKey);
      flow.done(3);

      const url = URL.createObjectURL(new Blob([plain], { type: 'application/octet-stream' }));
      state.currentDecrypt = { file: f, blobUrl: url, rowEl: tr };

      // Auto-trigger the save dialog once.
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();

      // Inline preview for images and text in the Decrypted card.
      const ext = name.split('.').pop().toLowerCase();
      if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
        img.src = url;
        img.classList.remove('hidden');
        img.onclick = () => showImageModal(url);
      } else if (name.endsWith('.txt') || ext === 'txt') {
        ta.value = new TextDecoder().decode(plain);
        ta.classList.remove('hidden');
      }

      setStatus(status, 'Decrypted: ' + name, 'ok');
    }

    // Transition this row's button to the "Download" / success state.
    // Guard against the row having been detached by a concurrent refreshList
    // (e.g. best-effort post-decrypt deletion refreshes the list first).
    if (tr.isConnected) {
      tr.dataset.state = 'ready';
      btn.textContent = 'Download';
      btn.className = 'row-action-btn success';
      btn.disabled = false;
    }

    if (meta.deleteondownload) {
      deleteObject({
        region: REGION,
        key: f.key,
        room: state.tunnelId,
        capability: state.capability,
      }).then(refreshList).catch(() => {});
    }
  } catch (err) {
    console.error(err);
    flow.error(currentStep);
    if (downloadBar) downloadBar.error();
    // Revert this row to idle on error.
    tr.dataset.state = 'idle';
    btn.textContent = 'Decrypt';
    btn.className = 'row-action-btn';
    btn.disabled = false;
    const isCrypto = err && /decrypt|OperationError|tag/i.test(String(err && err.message || err));
    setStatus(
      status,
      isCrypto
        ? 'Decrypt failed — wrong password, or the uploader used a password you need to type in.'
        : (err.message || 'Decrypt failed.'),
      'err'
    );
  } finally {
    document.body.classList.remove('busy');
  }
}

async function deleteOne(f) {
  resetCurrentDecrypt();
  $('decCard').classList.add('hidden');
  try {
    await deleteObject({
      region: REGION,
      key: f.key,
      room: state.tunnelId,
      capability: state.capability,
    });
    setStatus($('listStatus'), 'Deleted.', 'ok');
    await refreshList();
  } catch (err) {
    setStatus($('listStatus'), 'Delete failed.', 'err');
  }
}

boot();

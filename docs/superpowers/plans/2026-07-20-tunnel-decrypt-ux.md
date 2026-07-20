# Tunnel Decrypt UX — In-row Download Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Tunnel page's "Decrypted" card above the Upload card and replace the in-card "Save decrypted file" link with an in-row button that transforms from "Decrypt" (red) to "Download" (green) after a successful decrypt.

**Architecture:** A per-row button state machine (`idle` → `decrypting` → `ready`) tracked via `data-state` on the `<tr>`. A single `state.currentDecrypt` field holds the currently-decrypted file's blob URL and row element. A `resetCurrentDecrypt()` helper reverts the previous row and revokes its blob URL whenever a new decrypt starts, a row is deleted, or the list refreshes.

**Tech Stack:** Vanilla JS (no framework), Cloudflare Workers backend, CSS design tokens. No test framework — verification is manual in the browser.

**Spec:** `docs/superpowers/specs/2026-07-20-tunnel-decrypt-ux-design.md`

---

## File Map

| File | Responsibility | Action |
|---|---|---|
| `frontend/assets/tokens.css` | Design tokens + base button styles | Modify — add `--color-success-hover` token and `button.success` class |
| `frontend/tunnel/index.html` | Tunnel page markup | Modify — move Decrypted card above Upload, remove in-card download link |
| `frontend/assets/tunnel.js` | Tunnel page controller | Modify — add state machine, rewrite `decryptOne`, update `renderList`, `deleteOne`, `refreshList` |

---

### Task 1: Add success button styling

**Files:**
- Modify: `frontend/assets/tokens.css` (line 25, inside `:root`; line 165, after the `button.primary:hover` rule)

- [ ] **Step 1: Add the `--color-success-hover` token**

In `frontend/assets/tokens.css`, find the `--color-success` line inside `:root` (line 20) and add a new line directly after `--color-success-subtle` (line 21):

```css
  --color-success: #2A7A54;
  --color-success-subtle: #EFF8F3; /* light green tint */
  --color-success-hover: #235E42;  /* darker shade for button hover */
```

- [ ] **Step 2: Add the `button.success` CSS rule**

In `frontend/assets/tokens.css`, find the `button.primary:hover, .btn.primary:hover` block (lines 161–165) and add the success button rules directly after it (after line 165, before the `/* --- Form controls --- */` comment on line 167):

```css
button.primary:hover, .btn.primary:hover {
  background: var(--color-accent-hover);
  border-color: var(--color-accent-hover);
  box-shadow: var(--shadow-sm);
}

button.success, .btn.success {
  background: var(--color-success);
  border-color: var(--color-success);
  color: #fff;
  box-shadow: var(--shadow-xs);
}
button.success:hover, .btn.success:hover {
  background: var(--color-success-hover);
  border-color: var(--color-success-hover);
  box-shadow: var(--shadow-sm);
}

/* --- Form controls --- */
```

- [ ] **Step 3: Verify in browser**

Run the local dev server (or open the tunnel page). Add a temporary inline style `class="success"` to any visible button in the tunnel page to confirm the green styling renders. Revert the temporary test after confirming. (Alternatively, inspect via devtools that the CSS rule is present and valid.)

- [ ] **Step 4: Commit**

```bash
git add frontend/assets/tokens.css
git commit -m "Add .success button class and --color-success-hover token"
```

---

### Task 2: Move Decrypted card and remove in-card download link

**Files:**
- Modify: `frontend/tunnel/index.html` (lines 60–102)

- [ ] **Step 1: Move the Decrypted card above the Upload card**

In `frontend/tunnel/index.html`, the current structure (lines 58–102) is:

```html
    </div>  <!-- end file list card -->

    <!-- ── Upload ─────────────────────────────────────────── -->
    <div class="card stack">
      ...upload card...
    </div>

    <!-- ── Decrypted result ───────────────────────────────── -->
    <div class="card stack hidden" id="decCard">
      ...decrypted card...
    </div>
```

Cut the entire Decrypted result block (from `<!-- ── Decrypted result ──` through its closing `</div>`) and paste it **between** the file list card's closing `</div>` and the Upload card's opening comment. The new order should be:

```html
    </div>  <!-- end file list card -->

    <!-- ── Decrypted result ───────────────────────────────── -->
    <div class="card stack hidden" id="decCard">
      <h2>Decrypted</h2>
      <p id="decStatus" class="muted" role="status" aria-live="polite"></p>
      <textarea id="decMsgOut" class="hidden" readonly aria-label="Decrypted message"></textarea>
      <img id="decImg" class="preview hidden" alt="Decrypted image preview">
    </div>

    <!-- ── Upload ─────────────────────────────────────────── -->
    <div class="card stack">
      ...upload card unchanged...
    </div>
```

- [ ] **Step 2: Remove the in-card download link**

Inside the Decrypted card, delete the `<div class="row">` wrapper and its `<a id="decDownload">` child. The card's final content is just: `<h2>`, `<p id="decStatus">`, `<textarea id="decMsgOut">`, `<img id="decImg">`. No `<a id="decDownload">` element should remain.

After this step the Decrypted card block should look exactly like:

```html
    <!-- ── Decrypted result ───────────────────────────────── -->
    <div class="card stack hidden" id="decCard">
      <h2>Decrypted</h2>
      <p id="decStatus" class="muted" role="status" aria-live="polite"></p>
      <textarea id="decMsgOut" class="hidden" readonly aria-label="Decrypted message"></textarea>
      <img id="decImg" class="preview hidden" alt="Decrypted image preview">
    </div>
```

- [ ] **Step 3: Verify in browser**

Open the tunnel page. The Decrypted card should not be visible (it has `class="hidden"`). The Upload card should appear below where the Decrypted card would appear. No broken layout.

- [ ] **Step 4: Commit**

```bash
git add frontend/tunnel/index.html
git commit -m "Move Decrypted card above Upload card; remove in-card download link"
```

---

### Task 3: Add `state.currentDecrypt` and `resetCurrentDecrypt()` helper

**Files:**
- Modify: `frontend/assets/tunnel.js` (line 37–41 for `state`; insert helper after `readPass` around line 56)

- [ ] **Step 1: Add `currentDecrypt` to the state object**

In `frontend/assets/tunnel.js`, find the `state` object (lines 37–41):

```js
const state = {
  tunnelId: '',
  file: null,
  ready: false, // true once we have a valid tunnelid + tempkey
};
```

Add a `currentDecrypt` field:

```js
const state = {
  tunnelId: '',
  file: null,
  ready: false, // true once we have a valid tunnelid + tempkey
  currentDecrypt: null, // { file, blobUrl, rowEl } — the row currently in "Download" state
};
```

- [ ] **Step 2: Add the `resetCurrentDecrypt` helper**

In `frontend/assets/tunnel.js`, find the `readPass` function (lines 53–56):

```js
function readPass(id) {
  const el = $(id);
  return el ? (el.value || '').trim() : '';
}
```

Add the `resetCurrentDecrypt` helper directly after it (after line 56):

```js
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
```

- [ ] **Step 3: Commit**

```bash
git add frontend/assets/tunnel.js
git commit -m "Add state.currentDecrypt and resetCurrentDecrypt helper"
```

---

### Task 4: Rewrite `renderList` to wire row state and click handler

**Files:**
- Modify: `frontend/assets/tunnel.js` (lines 157–191, the `renderList` function)

- [ ] **Step 1: Replace the `renderList` function**

In `frontend/assets/tunnel.js`, replace the entire `renderList` function (lines 157–191) with:

```js
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
```

- [ ] **Step 2: Add the `handleRowAction` function**

Add this function directly **after** `renderList` (before the `$('btnRefresh').onclick = refreshList;` line):

```js
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
```

- [ ] **Step 3: Commit**

```bash
git add frontend/assets/tunnel.js
git commit -m "Rewrite renderList with per-row state machine and click handler"
```

---

### Task 5: Rewrite `decryptOne` to manage row button state

**Files:**
- Modify: `frontend/assets/tunnel.js` (lines 374–511, the entire `decryptOne` function)

- [ ] **Step 1: Replace `decryptOne` with the new version**

In `frontend/assets/tunnel.js`, replace the entire `decryptOne` function (from `async function decryptOne(f) {` on line 374 through its closing `}` on line 511) with:

```js
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

  const flow = decFlow();
  flow.show();
  flow.reset();
  let currentStep = 0;
  let downloadBar = null;

  try {
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

    // Detect format via first 48 bytes.
    setStatus(status, 'Detecting format…');
    const headRes = await fetch(meta.url, { headers: { Range: 'bytes=0-47' } });
    if (!headRes.ok) throw new Error('Header fetch failed: HTTP ' + headRes.status);
    const headerBytes = new Uint8Array(await headRes.arrayBuffer());
    const format = detectFormat(headerBytes);

    const name = safeFilename(meta.objname || f.objname) || 'file.bin';
    let plain = null;

    if (format === 'v2') {
      // ---- RSv2 chunked decrypt — stream directly to disk ----
      setStatus(status, 'Downloading & decrypting…');

      const dv = new DataView(headerBytes.buffer);
      const chunkSize = dv.getUint32(8, true);
      const totalSize = dv.getUint32(16, true) * 0x100000000 + dv.getUint32(12, true);
      const totalChunks = chunkSize > 0 ? Math.ceil(totalSize / chunkSize) : 1;

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
      const chunkGen = decryptChunked(headerBytes, pass, tempKey, fetchRange);
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
    tr.dataset.state = 'ready';
    btn.textContent = 'Download';
    btn.className = 'row-action-btn success';
    btn.disabled = false;

    if (meta.deleteondownload) {
      deleteObject({ region: REGION, key: f.key }).then(refreshList).catch(() => {});
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
```

- [ ] **Step 2: Verify no references to the old `decDownload` element remain in tunnel.js**

Search `frontend/assets/tunnel.js` for `decDownload`. The only references should be in the `decryptOne` function you just replaced — confirm there are **zero** matches now. The `$('decDownload')` and `a.classList.remove('hidden')` patterns from the old code are gone.

- [ ] **Step 3: Commit**

```bash
git add frontend/assets/tunnel.js
git commit -m "Rewrite decryptOne with per-row button state machine"
```

---

### Task 6: Update `deleteOne` and `refreshList` to reset current decrypt

**Files:**
- Modify: `frontend/assets/tunnel.js` (`deleteOne` around line 513; `refreshList` around line 132)

- [ ] **Step 1: Update `deleteOne` to reset current decrypt**

In `frontend/assets/tunnel.js`, find the `deleteOne` function:

```js
async function deleteOne(f) {
  try {
    await deleteObject({ region: REGION, key: f.key });
    setStatus($('listStatus'), 'Deleted.', 'ok');
    await refreshList();
  } catch (err) {
    setStatus($('listStatus'), 'Delete failed.', 'err');
  }
}
```

Replace it with:

```js
async function deleteOne(f) {
  resetCurrentDecrypt();
  $('decCard').classList.add('hidden');
  try {
    await deleteObject({ region: REGION, key: f.key });
    setStatus($('listStatus'), 'Deleted.', 'ok');
    await refreshList();
  } catch (err) {
    setStatus($('listStatus'), 'Delete failed.', 'err');
  }
}
```

- [ ] **Step 2: Update `refreshList` to reset current decrypt and hide the card**

In `frontend/assets/tunnel.js`, find the `refreshList` function (line 132):

```js
async function refreshList() {
  setStatus($('listStatus'), 'Loading files…');
  try {
```

Add `resetCurrentDecrypt()` and hide the Decrypted card at the very start, before the `try` block:

```js
async function refreshList() {
  resetCurrentDecrypt();
  $('decCard').classList.add('hidden');
  setStatus($('listStatus'), 'Loading files…');
  try {
```

- [ ] **Step 3: Commit**

```bash
git add frontend/assets/tunnel.js
git commit -m "Reset currentDecrypt on delete and list refresh"
```

---

### Task 7: Manual browser verification

**Files:** None (verification only)

- [ ] **Step 1: Verify small-file (RSv1) decrypt flow**

1. Open the tunnel page, create a room.
2. Upload a small text file (e.g. `test.txt`, a few bytes).
3. Click "Refresh list" — the file appears in the table with a "Decrypt" button.
4. Click "Decrypt" — the button label changes to "Decrypting…" (red, disabled), then to "Download" (green, enabled).
5. The Decrypted card appears **above** the Upload card (not at the bottom of the page).
6. The save dialog auto-triggers once. If the file is a `.txt`, the text content is shown in the card's textarea.
7. Click "Download" again — the save dialog triggers again without re-decrypting.

- [ ] **Step 2: Verify state reset when decrypting a second file**

1. Upload a second small file.
2. Click "Decrypt" on the first file — it becomes "Download".
3. Click "Decrypt" on the second file — the first row's button reverts to "Decrypt" (default style), the second row becomes "Download". Only one row is in the Download state.

- [ ] **Step 3: Verify state reset on delete**

1. With one row in the "Download" state, click "Delete" on that row.
2. The row disappears from the list. The Decrypted card hides. No row is left in the "Download" state.

- [ ] **Step 4: Verify state reset on refresh**

1. Upload a file, decrypt it (row is "Download").
2. Click "Refresh list".
3. The row's button reverts to "Decrypt". The Decrypted card hides.

- [ ] **Step 5: Verify error state**

1. Set a password in the decrypt field that does **not** match the uploader's password.
2. Click "Decrypt" on a row.
3. The button shows "Decrypting…" then reverts to "Decrypt" (default style, enabled). The Decrypted card shows the error message.

- [ ] **Step 6: Verify large-file (RSv2) decrypt flow (if feasible)**

If you have a file larger than 500 MB available:
1. Upload it.
2. Click "Decrypt" — the button transitions through "Decrypting…" to "Download".
3. The File System Access picker (or blob-URL fallback) saves the file.
4. Click "Download" again — if the picker was used, it re-decrypts and re-saves. If the blob-URL fallback was used, it re-triggers the save from the cached blob URL.

- [ ] **Step 7: Final commit (if any cleanup needed)**

If any fixes were made during verification, commit them:

```bash
git add -A
git commit -m "Fix verification issues from tunnel decrypt UX"
```

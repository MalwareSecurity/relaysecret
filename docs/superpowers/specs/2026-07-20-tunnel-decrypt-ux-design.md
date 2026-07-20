# Tunnel Decrypt UX — In-row Download Button & Preview Card Relocation

**Date:** 2026-07-20
**Status:** Approved (pending spec review)
**Scope:** Tunnel page only (`frontend/tunnel/index.html`, `frontend/assets/tunnel.js`)

## Problem

On the Tunnel page, clicking "Decrypt" on a file-row causes the result to appear in a "Decrypted" card at the very bottom of the page — below both the file list and the Upload card. The user has to scroll down past the Upload card to see the decrypted output or the "Save decrypted file" link. The green-tick success state also lives in that far-down card, disconnecting the success feedback from the row the user clicked.

## Solution

Move the "Decrypted" card directly above the Upload card (so it is visible as soon as a decrypt finishes, without scrolling past upload controls). Replace the in-card "Save decrypted file" link with an in-row button that transforms from "Decrypt" (red primary) to "Download" (green success) after a successful decrypt. Only one row can be in the Download state at a time.

## Layout Change

### Current order in `frontend/tunnel/index.html`

1. File list card (table with per-row Decrypt / Delete buttons)
2. Upload card (dropzone, password, options)
3. Decrypted card (hidden until decrypt) — **at the very bottom**

### New order

1. File list card
2. Decrypted card (moved up)
3. Upload card

The Decrypted card remains `hidden` until a decrypt completes. Its preview contents (message textarea, image thumbnail, status text) are unchanged. The in-card `<a id="decDownload">` link is removed — the in-row Download button replaces it.

## Button State Machine (per row)

Each file-list row has a single button in the actions cell, next to Delete. It transitions between three visual states:

| State | Label | CSS class | Disabled | Behaviour on click |
|---|---|---|---|---|
| `idle` | Decrypt | (default) | no | `decryptOne(f)` |
| `decrypting` | Decrypting… | `primary` | yes | (no-op) |
| `ready` (blobUrl set) | Download | `success` | no | trigger save via stored blobUrl |
| `ready` (picker, no blobUrl) | Download | `success` | no | `decryptOne(f)` again (re-stream to disk) |

The row's state is tracked via a `data-state` attribute on the `<tr>` element: `idle` | `decrypting` | `ready`. The blob URL (when one exists) is stored in `state.currentDecrypt.blobUrl`, not on the row itself — since only one row can be `ready` at a time, looking it up via `state.currentDecrypt` is unambiguous.

## State Management

A new field on the existing `state` object in `tunnel.js`:

```js
state.currentDecrypt = null;
// Shape: { file, blobUrl, rowEl }
//   file:   the file-list object that was decrypted
//   blobUrl: object URL for the decrypted bytes (null for the picker path)
//   rowEl:  the <tr> element that is currently in the "ready" state
```

### Reset triggers

The currently-ready row is reverted to `idle` ("Decrypt" label, default button class) when any of the following occurs:

1. **User clicks Decrypt on a different row** — `decryptOne` resets the previous row before starting.
2. **User clicks Delete on any row** — `deleteOne` resets the current decrypt state (the decrypted file may be gone).
3. **`refreshList()` runs** — list rebuild wipes all rows; `state.currentDecrypt` is cleared and any blob URL revoked.
4. **Decrypt errors out** — the row that was `decrypting` reverts to `idle`; `state.currentDecrypt` is already `null` (it was cleared in step 1 of `decryptOne` when `resetCurrentDecrypt()` ran). The previously-ready row (if any) was already reverted at that point too.

### Reset helper

```js
function resetCurrentDecrypt() {
  if (state.currentDecrypt) {
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
}
```

Called at the start of `decryptOne`, inside `deleteOne`, and inside `refreshList`.

## Button Click Handler

The per-row button's click handler inspects the row's `data-state`:

```js
btn.onclick = () => {
  const rowState = tr.dataset.state;
  if (rowState === 'decrypting') return; // disabled, should not fire
  if (rowState === 'ready' && state.currentDecrypt?.blobUrl) {
    // Re-trigger the save dialog without re-decrypting
    const a = document.createElement('a');
    a.href = state.currentDecrypt.blobUrl;
    a.download = safeFilename(state.currentDecrypt.file.objname) || 'file.bin';
    document.body.append(a);
    a.click();
    a.remove();
    return;
  }
  // idle, or ready-without-blobUrl (picker path) → (re-)decrypt
  decryptOne(f, tr, btn);
};
```

## `decryptOne` Changes

**New signature:** `decryptOne(f, tr, btn)` — receives the row element and button element so it can mutate them directly. (`renderList` passes these in.)

**Flow:**

1. **Reset any previously-ready row:** call `resetCurrentDecrypt()`.
2. **Set this row to decrypting:** `tr.dataset.state = 'decrypting'`; `btn.textContent = 'Decrypting…'`; `btn.classList.add('primary')`; `btn.disabled = true`.
3. **Show the Decrypted card** (unhide `#decCard`) and reset its preview children (hide textarea, image, old status).
4. **Run the existing decrypt logic** (unchanged): presign, fetch header, detect format, stream or single-shot decrypt.
5. **On success:**
   - **RSv1 (plaintext in memory):** create blob URL from the plaintext `Uint8Array`. Store `state.currentDecrypt = { file: f, blobUrl, rowEl: tr }`. Set `tr.dataset.state = 'ready'`. Update button: `btn.textContent = 'Download'`; swap `primary` class for `success`; `btn.disabled = false`. Show preview in the card (image / text) as before. Auto-trigger the first save via the blob URL (matches current "auto-click" behaviour for RSv2 fallback).
   - **RSv2 with File System Access picker (file already saved):** No blob URL. Store `state.currentDecrypt = { file: f, blobUrl: null, rowEl: tr }`. Set `tr.dataset.state = 'ready'`. Button becomes "Download" / `success`. The card shows a status confirmation ("Decrypted and saved: \<name\>") but no preview (the bytes were streamed to disk and are not in memory).
   - **RSv2 with blob-URL fallback (auto-saved via hidden `<a>` click):** Same as RSv1 — store the blobUrl, button becomes Download, card shows preview if applicable.
6. **On error:** revert `tr.dataset.state = 'idle'`; `btn.textContent = 'Decrypt'`; remove `primary` class; `btn.disabled = false`. Show error in the card's status. `state.currentDecrypt` stays `null` (it was cleared in step 1).

### Preview behaviour in the card

The Decrypted card shows previews **only** when the decrypted bytes are in memory (RSv1) or available as a blob URL (RSv2 fallback). For the picker path, no preview is shown — the card just displays the status line.

## `deleteOne` Changes

Before deleting, call `resetCurrentDecrypt()`. This ensures that if the user deletes the currently-decrypted file, its row's button reverts to "Decrypt" and the blob URL is revoked. The Decrypted card is also hidden (since the file it was showing is gone).

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

## `refreshList` Changes

Call `resetCurrentDecrypt()` at the start, before fetching the list. Also hide the Decrypted card. This covers the delete-on-download case (where `refreshList` is called after a file auto-deletes) and the manual refresh case.

## CSS — New `.success` Button Class

Add alongside the existing `button.primary` in `tokens.css`:

```css
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
```

Add a new token to `tokens.css` `:root`:

```css
--color-success-hover: #235E42;  /* darker shade of --color-success (#2A7A54) */
```

## HTML Changes — `frontend/tunnel/index.html`

1. **Move** the `<!-- Decrypted result -->` block (currently lines 93–102) to **between** the File list card (ends line 58) and the Upload card (starts line 60).

2. **Remove** the in-card download link:
   ```html
   <!-- DELETE this line: -->
   <a id="decDownload" class="btn primary hidden" download>Save decrypted file</a>
   ```
   The `<div class="row">` wrapper around it is also removed. The card now contains only: `<h2>Decrypted</h2>`, `<p id="decStatus">`, `<textarea id="decMsgOut">`, `<img id="decImg">`.

3. The `<div id="downloadBar">` progress bar stays where it is (inside the File list card, below the table).

## `renderList` Changes

Each row's button gets:
- Class `row-action-btn` (new class, same styling as a plain button — added so we can query it reliably).
- The row's `<tr>` gets `data-state="idle"`.
- The click handler described in "Button Click Handler" above.

## Files Touched

| File | Changes |
|---|---|
| `frontend/tunnel/index.html` | Move Decrypted card above Upload card; remove in-card download link + its row wrapper |
| `frontend/assets/tunnel.js` | Add `state.currentDecrypt`; add `resetCurrentDecrypt()` helper; rewrite `decryptOne(f, tr, btn)` to manage row button state; update `renderList` to set `data-state` and wire click handler; update `deleteOne` and `refreshList` to call `resetCurrentDecrypt` |
| `frontend/assets/tokens.css` | Add `--color-success-hover` token; add `button.success` / `.btn.success` rules |
| `frontend/assets/app.css` | (No changes — `.row-action-btn` inherits default `button` styles; `.success` lives in tokens.css with the other button modifiers) |

## Out of Scope

- The send page (`send.js` / `index.html`) decrypt flow — URL-driven, not list-driven, unaffected.
- The Upload card — unchanged.
- The `downloadBar` progress bar — unchanged.
- The `decFlow()` progress step list — unchanged.

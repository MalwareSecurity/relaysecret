# RelaySecret Worker API Contract

All endpoints live on the Worker (deployed at e.g. `https://api.relaysecret.com`). Pages frontend is served from `https://www.relaysecret.com`.

The Worker **never sees plaintext**. All encryption and decryption is done in the browser with WebCrypto. The Worker's only jobs are:
1. Mint short-lived **SigV4 presigned R2 URLs** so the client can PUT/GET encrypted blobs directly against R2's S3-compatible endpoint, and authorize deletes through the R2 binding.
2. Proxy VirusTotal SHA-1 lookups (so the API key stays server-side).
3. Store and fetch encrypted clipboard blobs in KV.

## R2 key layout (unchanged from the AWS version)

```
{n}day/{64-hex}                        # single-recipient send
{n}day/{tunnelHash}/{64-hex}           # room / tunnel mode (n is always 1)
```

`n ∈ {1,2,3,4,5,10}` — used by R2 lifecycle rules to auto-expire objects by prefix.
`tunnelHash` = first 16 chars of SHA-256(public room id) — keeps the public
room handle out of R2 listings. The room id itself derives from a separate
authorization capability, not directly from the eight-word room code.
`64-hex` = SHA-256 of (seed + timestamp + 256 crypto-random bits). Collision-free.

## Regions

Three R2 buckets, one per jurisdiction, selected by `?region=` query param:

| Param | R2 bucket binding | R2 location hint |
|-------|-------------------|------------------|
| `us`  | `R2_US`           | `wnam` (Western North America) |
| `eu`  | `R2_EU`           | `eeur` (Eastern Europe) |
| `apac`| `R2_APAC`         | `apac` (Asia-Pacific) |

Default region is `us` if `region` is missing or unknown.

## Endpoints

### `GET /presign/put?region=X&expire=N&filename=F&deleteOnDownload=B&deleteAuth=HEX`
Returns a SigV4 presigned R2 PUT URL plus the object key.

- `region`: one of `us|eu|apac`
- `expire`: one of `1|2|3|4|5|10` (days, maps to lifecycle prefix)
- `filename`: plaintext filename (kept in object metadata, never in the URL)
- `deleteOnDownload`: `true|false`
- `deleteAuth`: SHA-256 digest of the purpose-specific deletion capability
- `X-Turnstile-Token`: required when Turnstile is enabled

Response:
```json
{
  "url": "https://<account>.r2.cloudflarestorage.com/<bucket>/1day/<hex>?X-Amz-...",
  "key": "1day/<hex>",
  "region": "us",
  "requiredHeaders": {
    "x-amz-meta-filename": "<b64url(filename)>",
    "x-amz-meta-deleteondownload": "true",
    "x-amz-meta-deleteauth": "<64-hex>",
    "content-type": "application/octet-stream"
  }
}
```

Client must PUT the ciphertext with **exactly** those headers. Max body 2 GB, enforced client-side.

### `GET /presign/tunnel-put?region=X&tunnel=ID&filename=F&deleteOnDownload=B`
Same as `/presign/put` but key is scoped under `1day/<tunnelHash>/...`. Always 1-day expiry.
Requires `X-Relay-Capability`, whose SHA-256 prefix must match `ID`, and a
Turnstile token when enabled.

### `GET /presign/get?region=X&key=KEY`
Returns a short-lived (1h) presigned R2 GET URL + file metadata.

Response:
```json
{
  "url": "https://...?X-Amz-...",
  "key": "1day/<hex>",
  "objsize": 12345,
  "objname": "photo.png",
  "deleteondownload": false
}
```

### `GET /tunnel/list?region=X&tunnel=NAME`
Lists objects under `1day/<tunnelHash>/`. Uses R2 binding `list()` server-side with full pagination. Returns at most 200 objects; `truncated: true` when more exist.
Requires the room's `X-Relay-Capability`.

Response:
```json
{
  "objects": [{ "key": "...", "objsize": 1234, "objname": "photo.png", "deleteondownload": false }],
  "truncated": false
}
```

### `DELETE /obj?region=X&key=KEY[&room=ID]`
Deletes the object via R2 binding. Single-recipient objects require the
`X-Relay-Capability` whose digest was stored at upload. Tunnel objects require
the room capability and matching `room` id.

### `GET /sha1/:hash`
Proxies VirusTotal v3 `GET /api/v3/files/{id}` for the given SHA-1. API key stays in Worker secret. Returns `{sha1, positives, total, vtlink, detect, error}`.

`positives` is the sum of `malicious` + `suspicious` engines from `last_analysis_stats`. `total` is the sum of all engine counts. `vtlink` points to the VirusTotal GUI page for the file (using the SHA-256 returned by the v3 API). If the file is unknown to VirusTotal (HTTP 404 from upstream), `positives` and `total` are `0` and `detect` is `false`.

### `POST /clipboard/:id` — body `{"data": "<hex>"}`
Stores ciphertext in KV under the given clipboard id with a TTL of 1 day.
Requires `X-Relay-Capability` and a Turnstile token when enabled.

### `GET /clipboard/:id`
Returns `{"data": "<hex>"}` or 404.
Requires `X-Relay-Capability`.

### `OPTIONS /*`
CORS preflight. `Access-Control-Allow-Origin` is pinned to the configured frontend origin (e.g. `https://www.relaysecret.com`) in prod, `*` in dev.

## Error shape

```json
{ "error": "human readable", "code": "SHORT_CODE" }
```

Status codes: `400` bad input, `403` authorization or origin mismatch, `404`
not found, `429` rate limited, `500` internal, and `503` request verification
temporarily unavailable.

## Origin check

In prod, the Worker requires an exact `Origin` or Referer-origin match. This is
a browser boundary, not authentication; capabilities, Turnstile, and rate
limits enforce the corresponding security properties.

## Secrets / bindings (wrangler.toml)

Bindings:
- `R2_US`, `R2_EU`, `R2_APAC` — R2 bucket bindings
- `CLIPBOARD_KV` — KV namespace
- `API_RATE_LIMITER`, `MUTATION_RATE_LIMITER`, `EXPENSIVE_RATE_LIMITER`

Secrets (via `wrangler secret put`):
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — R2 S3-compatible credentials (used only for SigV4 presigning)
- `R2_ACCOUNT_ID` — Cloudflare account id (used to build the R2 S3 endpoint URL)
- `VT_API_KEY` — VirusTotal API key (or `"none"` to disable)
- `TURNSTILE_SECRET` — optional managed-widget secret (`"none"` to disable)
- `FRONTEND_ORIGIN` — e.g. `https://www.relaysecret.com`, or a comma-separated list `https://www.relaysecret.com,https://relaysecret.com` to allow multiple origins (or `"devmode"` to disable the gate)
- `SEED` — random string used to salt object-key generation

// Single source of truth for the Worker URL and optional Turnstile site key.
//
// This file ships with literal placeholders that deploy/deploy.sh substitutes
// at deploy time in a build copy under /tmp — the committed file is never
// mutated in place.
//
// workerUrl: the Worker API origin.
// turnstileSiteKey: public managed-widget site key, or "none" when disabled.
//
// For local dev: overwrite this file with:
//   window.CONFIG = { workerUrl: 'http://localhost:8787', turnstileSiteKey: 'none' };
window.CONFIG = {
  workerUrl: '<WORKER_ORIGIN_PLACEHOLDER>',
  turnstileSiteKey: '<TURNSTILE_SITE_KEY_PLACEHOLDER>',
};

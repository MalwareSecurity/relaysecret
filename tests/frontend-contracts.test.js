import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const pages = [
  { name: 'Send', path: 'frontend/index.html', currentHref: '/', module: '/assets/send.js' },
  { name: 'Tunnel', path: 'frontend/tunnel/index.html', currentHref: '/tunnel/', module: '/assets/tunnel.js' },
  { name: 'Clipboard', path: 'frontend/clipboard/index.html', currentHref: '/clipboard/', module: '/assets/clipboard.js' },
].map((page) => ({
  ...page,
  html: readFileSync(new URL(page.path, root), 'utf8'),
}));

function read(path) {
  return readFileSync(new URL(path, root), 'utf8');
}

function frontendScripts() {
  const assets = new URL('frontend/assets/', root);
  return readdirSync(assets, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => `frontend/assets/${entry.name}`);
}

function matches(source, expression) {
  return [...source.matchAll(expression)];
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}=(["'])(.*?)\\1`, 'i'));
  return match ? match[2] : null;
}

function tags(source, names) {
  return matches(
    source,
    new RegExp(`<(?:${names})\\b(?:"[^"]*"|'[^']*'|[^'">])*>`, 'gi'),
  ).map((match) => match[0]);
}

test('all entry points expose a minimal, navigable document structure', () => {
  for (const page of pages) {
    assert.match(page.html, /<html\b[^>]*\blang="en"/i, `${page.name}: document language`);
    assert.equal(matches(page.html, /<meta\b[^>]*\bname="viewport"[^>]*>/gi).length, 1, `${page.name}: viewport`);
    assert.equal(matches(page.html, /<meta\b[^>]*\bname="description"[^>]*>/gi).length, 1, `${page.name}: description`);
    assert.equal(matches(page.html, /<main\b/gi).length, 1, `${page.name}: one main landmark`);
    assert.equal(matches(page.html, /<h1\b/gi).length, 1, `${page.name}: one page heading`);
    assert.match(page.html, /<nav\b[^>]*\baria-label="Main navigation"/i, `${page.name}: labelled navigation`);
    assert.equal(matches(page.html, /\baria-current="page"/gi).length, 1, `${page.name}: one current navigation item`);
    assert.match(
      page.html,
      new RegExp(`<a\\b[^>]*href="${page.currentHref.replaceAll('/', '\\/')}"[^>]*aria-current="page"|<a\\b[^>]*aria-current="page"[^>]*href="${page.currentHref.replaceAll('/', '\\/')}"`, 'i'),
      `${page.name}: correct current navigation item`,
    );
    assert.match(page.html, /<footer\b[^>]*class="site-footer"/i, `${page.name}: footer`);
    assert.match(page.html, new RegExp(`<script\\b[^>]*type="module"[^>]*src="${page.module.replaceAll('/', '\\/')}">`, 'i'), `${page.name}: page controller`);
  }
});

test('document ids are unique and ARIA id references resolve', () => {
  for (const page of pages) {
    const ids = tags(page.html, '[a-z][a-z0-9:-]*')
      .map((tag) => attr(tag, 'id'))
      .filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, `${page.name}: duplicate id`);

    for (const tag of tags(page.html, '[a-z][a-z0-9:-]*')) {
      for (const attribute of ['aria-controls', 'aria-labelledby', 'aria-describedby']) {
        const references = attr(tag, attribute)?.split(/\s+/).filter(Boolean) || [];
        for (const reference of references) {
          assert.ok(ids.includes(reference), `${page.name}: ${attribute} references missing #${reference}`);
        }
      }
    }
  }
});

test('user-editable controls have labels and buttons declare their type', () => {
  for (const page of pages) {
    const labels = new Set(tags(page.html, 'label').map((tag) => attr(tag, 'for')).filter(Boolean));
    for (const tag of tags(page.html, 'input|textarea|select')) {
      if ((attr(tag, 'type') || '').toLowerCase() === 'hidden' || /\bhidden\b/.test(attr(tag, 'class') || '')) continue;
      const id = attr(tag, 'id');
      assert.ok(
        (id && labels.has(id)) || attr(tag, 'aria-label') || attr(tag, 'aria-labelledby'),
        `${page.name}: unlabelled control ${tag}`,
      );
    }
    for (const tag of tags(page.html, 'button')) {
      assert.equal(attr(tag, 'type'), 'button', `${page.name}: button must not rely on an implicit submit type`);
    }
  }
});

test('Send implements the keyboard-accessible tabs contract', () => {
  const html = pages.find((page) => page.name === 'Send').html;
  const script = read('frontend/assets/send.js');
  const tabs = tags(html, 'button').filter((tag) => attr(tag, 'role') === 'tab');
  const panels = tags(html, 'section').filter((tag) => attr(tag, 'role') === 'tabpanel');

  assert.equal(tabs.length, 3);
  assert.equal(panels.length, 3);
  assert.deepEqual(tabs.map((tag) => attr(tag, 'aria-selected')), ['true', 'false', 'false']);
  assert.deepEqual(tabs.map((tag) => attr(tag, 'tabindex')), ['0', '-1', '-1']);

  const panelIds = new Set(panels.map((tag) => attr(tag, 'id')));
  const tabIds = new Set(tabs.map((tag) => attr(tag, 'id')));
  for (const tab of tabs) assert.ok(panelIds.has(attr(tab, 'aria-controls')));
  for (const panel of panels) assert.ok(tabIds.has(attr(panel, 'aria-labelledby')));

  assert.match(script, /setAttribute\(['"]aria-selected['"]/);
  assert.match(script, /\.tabIndex\s*=\s*selected\s*\?\s*0\s*:\s*-1/);
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.match(script, new RegExp(`event\\.key\\s*===\\s*['"]${key}['"]`), `missing ${key} handling`);
  }
  assert.match(script, /\.focus\(\)/, 'selected keyboard tab receives focus');
});

test('Clipboard uses an in-page, permission-tolerant workflow', () => {
  const html = pages.find((page) => page.name === 'Clipboard').html;
  const script = read('frontend/assets/clipboard.js');
  const frontendScripts = [
    'frontend/assets/api.js',
    'frontend/assets/clipboard.js',
    'frontend/assets/crypto.js',
    'frontend/assets/room-code.js',
    'frontend/assets/qrcode.js',
    'frontend/assets/send.js',
    'frontend/assets/tunnel.js',
    'frontend/assets/ui.js',
  ].map(read).join('\n');

  assert.doesNotMatch(frontendScripts, /\b(?:window\.)?(?:prompt|alert|confirm)\s*\(/, 'native blocking dialogs are not allowed');
  for (const id of [
    'clipboardEntry',
    'btnCreateClipboard',
    'clipboardNameInput',
    'btnJoinClipboard',
    'clipboardWorkspace',
    'clipboardQr',
    'clipText',
    'btnPaste',
    'btnCopy',
    'btnUpdate',
    'btnGet',
  ]) {
    assert.match(html, new RegExp(`\\bid="${id}"`), `missing #${id}`);
  }
  assert.match(script, /navigator\.clipboard\.readText\(\)/);
  assert.match(script, /Clipboard permission was unavailable/);
  assert.match(script, /\$\(['"]clipText['"]\)\.focus\(\)/, 'manual textarea fallback receives focus');
  assert.match(script, /q\.clipboardid\s*!==\s*expectedId/, 'URL capability id is verified before opening');
  assert.match(script, /window\.location\.assign\(clipboardUrl\(/, 'create/join converges on a shareable URL');
});

test('every protected write surface retains the canonical Turnstile widget contract', () => {
  for (const page of pages) {
    assert.equal(matches(page.html, /<!--\s*TURNSTILE_SCRIPT_PLACEHOLDER\s*-->/g).length, 1, `${page.name}: script placeholder`);
    const widgets = tags(page.html, 'div').filter((tag) => /\bcf-turnstile\b/.test(attr(tag, 'class') || ''));
    assert.equal(widgets.length, 1, `${page.name}: one widget`);
    assert.equal(attr(widgets[0], 'data-sitekey'), '<TURNSTILE_SITE_KEY_PLACEHOLDER>');
    assert.equal(attr(widgets[0], 'data-action'), 'turnstile-spin-v2');
    assert.match(page.html, /\bdata-configured="<TURNSTILE_ENABLED_PLACEHOLDER>"/);
  }

  const config = read('frontend/assets/config.js');
  const api = read('frontend/assets/api.js');
  assert.match(config, /turnstileSiteKey:\s*'<TURNSTILE_SITE_KEY_PLACEHOLDER>'/);
  assert.match(api, /\[name="cf-turnstile-response"\]/);
  assert.match(api, /headers\[['"]X-Turnstile-Token['"]\]\s*=\s*token/);
  assert.match(api, /window\.turnstile\.reset\(\)/);
});

test('HTML loads only local resources plus the explicit Turnstile exception', () => {
  const allowedExternalResourceOrigins = new Set(['https://challenges.cloudflare.com']);
  const allowedOutboundLinks = new Set(['https://github.com/santrancisco/relaysecret']);

  for (const page of pages) {
    for (const tag of tags(page.html, 'script|link|img|iframe|source|video|audio')) {
      for (const attribute of ['src', 'href', 'srcset', 'poster']) {
        const value = attr(tag, attribute);
        if (!value || value.startsWith('/') || value.startsWith('data:') || value.startsWith('blob:')) continue;
        assert.doesNotMatch(value, /^\/\//, `${page.name}: protocol-relative resources are forbidden`);
        const url = new URL(value);
        assert.ok(
          allowedExternalResourceOrigins.has(url.origin),
          `${page.name}: external ${attribute} is not allowlisted: ${value}`,
        );
      }
    }

    for (const tag of tags(page.html, 'a')) {
      const href = attr(tag, 'href');
      if (!href || href.startsWith('/') || href.startsWith('#')) continue;
      const url = new URL(href);
      assert.ok(allowedOutboundLinks.has(url.origin + url.pathname.replace(/\/$/, '')), `${page.name}: outbound link is not allowlisted: ${href}`);
      if (attr(tag, 'target') === '_blank') {
        assert.match(attr(tag, 'rel') || '', /(?:^|\s)noopener(?:\s|$)/, `${page.name}: new tab must use rel=noopener`);
      }
    }
  }
});

test('scripts, styles and security headers enforce the dependency policy', () => {
  const scripts = frontendScripts();
  for (const path of scripts) {
    const source = read(path);
    for (const match of source.matchAll(/\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)) {
      assert.match(match[1], /^\.{1,2}\//, `${path}: bare or remote module import ${match[1]}`);
    }
    for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      assert.match(match[1], /^\.{1,2}\//, `${path}: remote dynamic module import ${match[1]}`);
    }
  }

  const css = read('frontend/assets/app.css') + '\n' + read('frontend/assets/tokens.css');
  assert.doesNotMatch(css, /@import\b/i);
  for (const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    assert.ok(
      match[2].startsWith('/') || match[2].startsWith('./') || match[2].startsWith('../') || match[2].startsWith('data:'),
      `external CSS resource is forbidden: ${match[2]}`,
    );
  }

  const headers = read('frontend/_headers');
  const csp = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1] || '';
  assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com(?:;|\s)/);
  assert.match(csp, /style-src 'self';/);
  assert.match(csp, /font-src 'self';/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com;/);
  assert.doesNotMatch(csp, /(?:script-src|style-src)[^;]*'unsafe-(?:inline|eval)'/);

  const ui = read('frontend/assets/ui.js');
  assert.match(ui, /import\(['"]\.\/qrcode\.js['"]\)/, 'QR generator must be loaded on demand');
  for (const page of pages) {
    assert.doesNotMatch(page.html, /<script\b[^>]*src=["'][^"']*qrcode\.js/i, `${page.name}: QR generator must not block initial rendering`);
  }
});

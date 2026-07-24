import { expect, test } from '@playwright/test';

test('all primary pages expose their task and navigation', async ({ page }) => {
  for (const [path, heading] of [
    ['/', 'Send a secret'],
    ['/tunnel/', 'Create or join a secure room'],
    ['/clipboard/', 'Share a clipboard'],
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await expect(page.locator('.site-footer')).toContainText('End-to-end encrypted');
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }
});

test('Send tabs support arrow, Home and End keyboard navigation', async ({ page }) => {
  await page.goto('/');
  const message = page.getByRole('tab', { name: 'Message' });
  const file = page.getByRole('tab', { name: 'File' });
  const decrypt = page.getByRole('tab', { name: 'Decrypt' });

  await message.focus();
  await page.keyboard.press('ArrowRight');
  await expect(file).toBeFocused();
  await expect(file).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#paneFile')).toBeVisible();

  await page.keyboard.press('End');
  await expect(decrypt).toBeFocused();
  await expect(page.locator('#paneDec')).toBeVisible();

  await page.keyboard.press('Home');
  await expect(message).toBeFocused();
});

test('Clipboard opens in-page, generates a share URL and lazy-loads QR code', async ({ page }) => {
  const resources = [];
  page.on('request', (request) => resources.push(new URL(request.url()).pathname));

  await page.goto('/clipboard/');
  await expect(page.getByRole('button', { name: 'Create a secure clipboard' })).toBeVisible();
  await expect(page.locator('#clipboardWorkspace')).toBeHidden();
  expect(resources).not.toContain('/assets/qrcode.js');

  await page.locator('#clipboardNameInput').fill('a unique shared clipboard phrase');
  await page.getByRole('button', { name: 'Join shared clipboard' }).click();
  await page.waitForURL(/clipboardid=.*#/);
  await expect(page.locator('#clipboardWorkspace')).toBeVisible();
  await expect(page.locator('#clipboardUrlDisplay')).toContainText('clipboardid=');
  await expect(page.locator('#clipboardQr svg')).toBeVisible();
  expect(resources).toContain('/assets/qrcode.js');
  await expect(page.getByRole('button', { name: 'Send this text' })).toBeEnabled();
});

test('Clipboard provides a manual fallback when clipboard permission is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
        writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
      },
    });
  });
  await page.goto('/clipboard/');
  await page.locator('#clipboardNameInput').fill('clipboard fallback phrase');
  await page.getByRole('button', { name: 'Join shared clipboard' }).click();
  await page.waitForURL(/clipboardid=.*#/);
  await page.getByRole('button', { name: 'Paste from this device' }).click();
  await expect(page.locator('#status')).toContainText('Paste into the text box instead');
  await expect(page.locator('#clipText')).toBeFocused();
});

test('Turnstile failures and recovery are explicit and fail closed', async ({ page }) => {
  await page.route('**/assets/config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: "window.CONFIG = { workerUrl: 'https://api.invalid', turnstileSiteKey: 'test-site-key' };",
  }));
  await page.goto('/');
  const button = page.locator('#btnEncrypt');
  const status = page.locator('#turnstileStatus');
  await page.locator('#msgInput').fill('secret');
  await expect(button).toBeDisabled();
  await expect(status).toContainText('Loading human verification');

  await page.evaluate(() => window.relaySecretTurnstileError());
  await expect(status).toContainText('temporarily unavailable');
  await expect(button).toBeDisabled();

  await page.evaluate(() => window.relaySecretTurnstileReady('test-token'));
  await expect(status).toContainText('verification complete');
  await expect(button).toBeEnabled();

  await page.evaluate(() => window.relaySecretTurnstileExpired());
  await expect(status).toContainText('expired');
  await expect(button).toBeDisabled();
});

test('image modal traps focus, closes with Escape and restores the trigger', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { showImageModal } = await import('/assets/ui.js');
    const trigger = document.createElement('button');
    trigger.id = 'modalTestTrigger';
    trigger.textContent = 'Open preview';
    document.body.append(trigger);
    trigger.focus();
    showImageModal('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==');
  });

  const close = page.getByRole('button', { name: 'Close preview' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.image-modal')).toBeHidden();
  await expect(page.locator('#modalTestTrigger')).toBeFocused();
});

test('mobile Tunnel rows retain filename, size and usable actions', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'mobile layout only');
  await page.goto('/tunnel/');
  await page.evaluate(() => {
    document.querySelector('#roomEntry').classList.add('hidden');
    const card = document.querySelector('#fileListBody').closest('.card');
    card.classList.remove('hidden');
    document.querySelector('#fileListBody').innerHTML = `
      <tr>
        <td class="name">a-very-long-encrypted-filename-that-must-wrap-safely.txt</td>
        <td class="size">12.34 MB</td>
        <td class="actions"><button type="button">Decrypt</button><button type="button">Delete</button></td>
      </tr>`;
  });

  const row = page.locator('#fileListBody tr');
  await expect(row).toBeVisible();
  await expect(row.locator('.name')).toContainText('filename');
  await expect(row.locator('.size')).toContainText('12.34 MB');
  const buttons = row.getByRole('button');
  await expect(buttons).toHaveCount(2);
  for (const button of await buttons.all()) {
    const box = await button.boundingBox();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThanOrEqual(40);
  }
});

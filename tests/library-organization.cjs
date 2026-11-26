'use strict';
// Browser end-to-end verification for Orbit 0.4.0 library organization features:
// play statuses, custom collections, multi-filtering, smart search operators,
// floating bulk action dock, environment variables, and alternative launch profiles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.ORBIT_PLAYWRIGHT_PATH || 'playwright');
const { installFixture } = require('./fixtures/renderer.cjs');
const root = path.resolve(__dirname, '..');

const server = http.createServer((request, response) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('Content-Type', ({
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
    })[path.extname(file)] || 'application/octet-stream');
    response.end(fs.readFileSync(file));
  } catch { response.writeHead(404).end(); }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(process.env.ORBIT_BROWSER_EXECUTABLE
    ? { headless: true, executablePath: process.env.ORBIT_BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] }
    : { headless: true, channel: process.env.ORBIT_BROWSER_CHANNEL || 'chrome' });
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(installFixture, { count: 12 });
    await page.goto(`http://127.0.0.1:${server.address().port}/src/ui/index.html`);
    await page.locator('[data-route="library"]').first().waitFor();
    await page.locator('[data-route="library"]').first().click();
    await page.locator('#status-filter').waitFor();

    // 1. Create a custom collection via Collections modal and verify it appears in sidebar + filter dropdown.
    await page.locator('[data-action="manage-collections"]').first().click();
    await page.locator('#new-col-name').waitFor();
    await page.fill('#new-col-name', 'Co-op Night');
    await page.locator('#collection-create-form [type="submit"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.side-collections-nav .nav-item').length === 1);
    await page.locator('[data-action="close-modal"]').first().click();
    await page.locator('#modal-root .dialog').waitFor({ state: 'detached' });

    // 2. Enter Select mode, pick 2 games, and batch-assign status + collection + tags via Bulk Action Dock.
    await page.locator('[data-action="toggle-select-mode"]').first().click();
    await page.locator('#bulk-action-dock').waitFor();
    const firstTwo = await page.locator('.poster-card').evaluateAll(nodes => nodes.slice(0, 2).map(n => n.dataset.id));
    assert.equal(firstTwo.length, 2);
    for (const id of firstTwo) {
      await page.locator(`.poster-card[data-id="${id}"] .card-open-trigger`).click();
    }
    await page.waitForFunction(() => document.querySelector('#bulk-action-dock .bulk-dock-meta strong')?.textContent?.includes('2'));
    await page.selectOption('#bulk-status-select', 'backlog');
    await page.locator('[data-action="bulk-collections"]').click();
    await page.locator('[data-action="bulk-add-collection"]').first().click();
    await page.locator('#modal-root .dialog').waitFor({ state: 'detached' });

    // Exit select mode and filter by status:backlog + collection.
    await page.locator('#bulk-action-dock [data-action="toggle-select-mode"]').click();
    await page.locator('#bulk-action-dock').waitFor({ state: 'detached' });
    await page.selectOption('#status-filter', 'backlog');
    await page.waitForFunction(() => document.querySelectorAll('.poster-card').length === 2);

    // 3. Test smart search operators (`status:backlog` and `is:hidden`) plus hiding a game.
    await page.locator('[data-action="clear-filters"]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.poster-card').length === 12);
    await page.fill('#global-search', 'status:backlog');
    await page.waitForFunction(() => document.querySelectorAll('.poster-card').length === 2);
    await page.fill('#global-search', '');
    await page.waitForFunction(() => document.querySelectorAll('.poster-card').length === 12);

    // Open game actions popup (uses native <hr> separator & role="menuitemradio"), hide first game.
    await page.locator(`.poster-card[data-id="${firstTwo[0]}"] [data-action="game-actions"]`).click({ force: true });
    await page.locator('#game-actions-popup').waitFor();
    const hrCount = await page.locator('#game-actions-popup hr.game-actions-divider').count();
    assert(hrCount >= 2, 'actions menu uses native <hr> separators');
    const radioCount = await page.locator('#game-actions-popup [role="menuitemradio"]').count();
    assert.equal(radioCount, 4, 'actions menu exposes 4 status menuitemradio items');
    await page.locator('#game-actions-popup [data-action="toggle-hide"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.poster-card').length === 11);

    // Reveal hidden game via smart search `is:hidden`.
    await page.fill('#global-search', 'is:hidden');
    await page.waitForFunction(() => document.querySelectorAll('.poster-card').length === 1);
    await page.fill('#global-search', '');
    await page.waitForFunction(() => document.querySelectorAll('.poster-card').length === 11);

    // 4. Edit a game to add environment variables and an alternative launch profile, then launch it from Showcase.
    await page.locator(`.poster-card[data-id="${firstTwo[1]}"] .card-open-trigger`).click();
    await page.locator('.detail-showcase').waitFor();
    await page.locator('.detail-showcase [data-action="edit"]').click();
    await page.locator('#game-form').waitFor();
    await page.locator('#game-form details.editor-section').last().locator('summary').click();
    await page.fill('#game-env', 'DXVK_HUD=fps\nMANGOHUD=1');
    await page.locator('[data-action="add-launch-profile"]').click();
    const row = page.locator('[data-profile-row]').first();
    await row.locator('[data-profile-field="name"]').fill('Mod Loader');
    await row.locator('[data-profile-field="launch_args"]').fill('--modded --dx11');
    await row.locator('[data-profile-field="launch_env"]').fill('MOD_DEBUG=1');
    await page.locator('#game-form [type="submit"]').click();
    await page.locator('#modal-root .dialog').waitFor({ state: 'detached' });

    // Open Showcase and launch the saved alternative profile.
    await page.locator(`.poster-card[data-id="${firstTwo[1]}"] .card-open-trigger`).click();
    await page.locator('.showcase-profile-btn').waitFor();
    assert.equal((await page.locator('.showcase-profile-btn').first().textContent()).trim(), 'Mod Loader');
    await page.locator('.showcase-profile-btn').first().click();

    assert.deepEqual(errors, [], 'no uncaught renderer errors');
    console.log('Library organization & launch profiles browser test passed.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});

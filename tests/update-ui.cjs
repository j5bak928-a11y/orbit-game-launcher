'use strict';
// End-to-end browser verification for Orbit's automatic update button,
// sidebar bottom-dock placement, Settings update panel, native <progress>,
// and responsive icon-rail adaptation across dark/light themes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.ORBIT_PLAYWRIGHT_PATH || 'playwright');
const { installFixture } = require('./fixtures/renderer.cjs');

const root = path.resolve(__dirname, '..');
const previewDir = process.env.ORBIT_UPDATE_PREVIEW_DIR || '';

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

    await page.addInitScript({
      content: `
        (${installFixture.toString()})({ count: 10 });
        const listeners = [];
        const origOnEvent = window.orbit.onEvent;
        window.orbit.onEvent = cb => { listeners.push(cb); return origOnEvent(cb); };
        let currentStatus = { state: 'idle', message: 'Ready to check for updates.' };
        window.orbit.getUpdateStatus = async () => currentStatus;
        window.orbit.checkForUpdates = async () => {
          currentStatus = { state: 'checking', message: 'Checking for updates…' };
          return currentStatus;
        };
        window.updateInstallCalls = 0;
        window.orbit.installUpdate = async () => {
          window.updateInstallCalls++;
          currentStatus = { state: 'installing', version: '0.4.1', message: 'Installing verified update…' };
          for (const cb of listeners) cb({ type: 'updateStatus', status: currentStatus });
          return currentStatus;
        };
        window.pushUpdateStatus = status => {
          currentStatus = status;
          for (const cb of listeners) cb({ type: 'updateStatus', status });
        };
      `,
    });

    await page.goto(`http://127.0.0.1:${server.address().port}/src/ui/index.html`);
    await page.locator('[data-route="settings"]').first().waitFor();

    // 1. Idle state: #update-shortcut lives inside .side-bottom and is empty/hidden.
    const idleCheck = await page.evaluate(() => {
      const slot = document.getElementById('update-shortcut');
      const bottom = document.querySelector('.side-bottom');
      const version = document.querySelector('.side-bottom .side-version');
      return {
        inBottom: !!bottom?.contains(slot),
        aboveVersion: !!(slot && version && (slot.compareDocumentPosition(version) & Node.DOCUMENT_POSITION_FOLLOWING)),
        display: slot ? getComputedStyle(slot).display : '',
        empty: slot?.childElementCount === 0,
      };
    });
    assert.equal(idleCheck.inBottom, true, 'update shortcut is docked inside .side-bottom');
    assert.equal(idleCheck.aboveVersion, true, 'update shortcut sits directly above .side-version');
    assert.equal(idleCheck.empty, true, 'idle state renders no update button');
    assert.equal(idleCheck.display, 'none', 'empty update slot collapses cleanly');

    // 2. Downloading state (48%): visible in sidebar dock AND Settings with native <progress>.
    await page.evaluate(() => window.pushUpdateStatus({
      state: 'downloading', version: '0.4.1', progressPercent: 48, message: 'Downloading verified update…',
    }));
    await page.locator('.side-update-btn.is-downloading').waitFor();
    const sideProgress = page.locator('#update-shortcut progress.update-progress');
    assert.equal(await sideProgress.count(), 1, 'sidebar download card uses native <progress>');
    assert.equal(await sideProgress.getAttribute('value'), '48');

    // Clicking the downloading card navigates to Settings.
    await page.locator('.side-update-btn.is-downloading').click();
    await page.locator('#update-status').waitFor();
    assert.equal(await page.locator('#update-progress-slot progress.update-progress').count(), 1);
    assert.equal(await page.locator('#update-progress-slot progress.update-progress').getAttribute('value'), '48');
    if (previewDir) {
      fs.mkdirSync(previewDir, { recursive: true });
      await page.screenshot({ path: path.join(previewDir, 'update-downloading-dark.png') });
    }

    // 3. Ready state: primary CTA leads in Settings & solid accent dock button in sidebar.
    await page.evaluate(() => window.pushUpdateStatus({
      state: 'ready', version: '0.4.1', progressPercent: 100, message: 'Update downloaded and verified. Ready to install.',
    }));
    await page.locator('.side-update-btn.is-ready').waitFor();
    const readyMetrics = await page.evaluate(() => {
      const btn = document.querySelector('.side-update-btn.is-ready');
      const sidebar = document.querySelector('.sidebar');
      const version = document.querySelector('.side-version');
      const title = btn.querySelector('.side-update-title');
      const sub = btn.querySelector('.side-update-sub');
      const actions = [...document.querySelectorAll('#update-action-slot button')];
      const b = btn.getBoundingClientRect(), s = sidebar.getBoundingClientRect(), v = version.getBoundingClientRect();
      return {
        insideSidebar: b.left >= s.left - 1 && b.right <= s.right + 1,
        aboveVersion: b.bottom <= v.top + 1,
        titlePx: parseFloat(getComputedStyle(title).fontSize),
        subPx: parseFloat(getComputedStyle(sub).fontSize),
        firstAction: actions[0]?.dataset.action,
        secondAction: actions[1]?.dataset.action,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.equal(readyMetrics.insideSidebar, true, 'sidebar update button fits within sidebar bounds');
    assert.equal(readyMetrics.aboveVersion, true, 'sidebar update button stays above version line');
    assert(readyMetrics.titlePx >= 12, 'update button title respects 12px typography floor');
    assert(readyMetrics.subPx >= 12, 'update button subtitle respects 12px typography floor');
    assert.equal(readyMetrics.firstAction, 'install-update', 'Install & restart leads in Settings update panel');
    assert.equal(readyMetrics.secondAction, 'check-update', 'Check now remains available as secondary action');
    assert.equal(readyMetrics.overflow, false, 'no horizontal overflow at 1440px');
    if (previewDir) {
      await page.locator('.update-panel-row').scrollIntoViewIfNeeded();
      await page.locator('#toast-root .toast-close').first().click().catch(() => {});
      await page.screenshot({ path: path.join(previewDir, 'update-ready-dark-1440.png') });
      await page.selectOption('#theme-select', 'light');
      await page.waitForFunction(() => document.body.dataset.theme === 'light');
      await page.screenshot({ path: path.join(previewDir, 'update-ready-light-1440.png') });
      await page.selectOption('#theme-select', 'dark');
      await page.waitForFunction(() => document.body.dataset.theme === 'dark');
    }

    // 4. Busy state (game running): sidebar & Settings install buttons disable gracefully.
    const gameId = await page.evaluate(() => window.fixture.id(1));
    await page.evaluate(id => window.fixture.setRunning([id]), gameId);
    await page.waitForFunction(() => document.querySelector('.side-update-btn.is-ready')?.disabled === true);
    assert.equal(await page.locator('#update-action-slot .update-install-btn').isDisabled(), true);
    await page.evaluate(() => window.fixture.setRunning([]));
    await page.waitForFunction(() => document.querySelector('.side-update-btn.is-ready')?.disabled === false);

    // 5. Responsive check: 1180px, 750px (icon-rail with indicator dot), and 390px/320px.
    for (const [width, height] of [[1180, 720], [750, 700], [390, 730], [320, 568]]) {
      await page.setViewportSize({ width, height });
      const check = await page.evaluate(() => {
        const btn = document.querySelector('.side-update-btn.is-ready');
        const dot = btn?.querySelector('.side-update-dot');
        const b = btn.getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          visible: b.width >= 36 && b.height >= 36 && b.right <= innerWidth + 1,
          dotDisplay: dot ? getComputedStyle(dot).display : 'none',
        };
      });
      assert.equal(check.overflow, false, `no horizontal overflow at ${width}px`);
      assert.equal(check.visible, true, `sidebar update button stays visible and usable at ${width}px`);
      if (width <= 750) {
        assert.equal(check.dotDisplay, 'block', `ready dot shows in icon-rail mode at ${width}px`);
      }
      if (previewDir && width === 390) {
        await page.screenshot({ path: path.join(previewDir, 'update-ready-dark-390.png') });
      }
    }

    // 6. Trigger install from sidebar dock button and verify installing state.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.side-update-btn.is-ready').click();
    await page.locator('.side-update-btn.is-installing').waitFor();
    assert.equal(await page.evaluate(() => window.updateInstallCalls), 1);

    assert.deepEqual(errors, [], 'no uncaught renderer errors');
    console.log('Update UI & positioning browser test passed.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});

'use strict';
// Optional mocked-renderer QA: requires Playwright and an installed Chrome.
// Set ORBIT_PLAYWRIGHT_PATH when using a shared Playwright installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.ORBIT_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const outputDir = process.env.ORBIT_QA_OUTPUT || path.join(root, 'reports/library-updates');

const {installFixture}=require('./fixtures/renderer.cjs');

(async () => {
  fs.mkdirSync(outputDir, { recursive:true });
  const browser = await chromium.launch(process.env.ORBIT_BROWSER_EXECUTABLE
    ? {headless:true,executablePath:process.env.ORBIT_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']}
    : {headless:true,channel:process.env.ORBIT_BROWSER_CHANNEL || 'chrome'});
  try {
    const page = await browser.newPage({ viewport:{ width:1440, height:900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const html = fs.readFileSync(path.join(root, 'src/ui/index.html'), 'utf8')
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/, '')
      .replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g, '')
      .replace('<link rel="stylesheet" href="./styles.css" />',
        `<style>${fs.readFileSync(path.join(root, 'src/ui/styles.css'), 'utf8')}</style>`);
    await page.setContent(html);
    await page.evaluate(installFixture, { count:5000 });
    const helper = path.join(root, 'src/ui/library-updates.js');
    if (fs.existsSync(helper)) await page.addScriptTag({ content:fs.readFileSync(helper, 'utf8') });
    await page.addScriptTag({ content:fs.readFileSync(path.join(root, 'src/ui/app.js'), 'utf8') });
    await page.locator('nav [data-route="library"]').click();
    await page.locator('.game-card').first().waitFor();
    const settle = () => page.evaluate(() => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    await settle();

    if (!baseline) {
      const styles = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.id = 'style-probe';
        probe.innerHTML = '<div class="row-right"><button class="ghost-btn row-play">Play</button></div><div class="row-cover"><img class="list-game-icon"></div><div class="cover"><img class="cover-image bad-aspect"></div><div class="row-cover"><img class="bad-aspect"></div><div id="motion-probe" style="transition:transform 3s;animation:spin 4s infinite;scroll-behavior:smooth"></div>';
        document.body.appendChild(probe);
        const icon = probe.querySelector('.list-game-icon');
        const play = getComputedStyle(probe.querySelector('.row-play'));
        return {
          playColor:play.color, playBackground:play.backgroundColor,
          iconFit:getComputedStyle(icon).objectFit,
          iconRatio:parseFloat(getComputedStyle(icon).width) / parseFloat(getComputedStyle(icon.parentElement).width),
          badImages:[...probe.querySelectorAll('.bad-aspect')].map(img=>getComputedStyle(img).display),
          appMotion:getComputedStyle(document.getElementById('motion-probe')).transitionDuration,
        };
      });
      assert.equal(styles.playColor, 'rgb(139, 122, 255)');
      assert.equal(styles.playBackground, 'rgba(139, 122, 255, 0.13)');
      assert.equal(styles.iconFit, 'contain');
      assert(Math.abs(styles.iconRatio - 0.68) < 0.01);
      assert.deepEqual(styles.badImages, ['none','none']);
      assert.equal(styles.appMotion, '0s', 'app reduced-motion setting overrides inline transitions');
      await page.emulateMedia({ reducedMotion:'reduce' });
      const osMotion = await page.evaluate(() => {
        document.body.dataset.reduceMotion = 'false';
        const style = getComputedStyle(document.getElementById('motion-probe'));
        return { animation:style.animationName, transition:style.transitionDuration, scroll:style.scrollBehavior };
      });
      assert.deepEqual(osMotion, { animation:'none', transition:'0s', scroll:'auto' });
      await page.emulateMedia({ reducedMotion:'no-preference' });
      await page.evaluate(() => { document.body.dataset.reduceMotion='true';document.getElementById('style-probe').remove(); });
    }

    await page.evaluate(() => {
      window.fixture.observe(); window.fixture.resetMetrics();
      window.unchangedCard = document.querySelector(`.game-card[data-id="${window.fixture.id(2)}"]`);
    });
    const first = '.game-card[data-id="00000000-0000-4000-8000-000000000001"] .favorite-float';
    await page.locator(first).click();
    await page.waitForFunction(() => document.querySelector('.game-card .favorite-float.active'));
    await settle();
    const favorite = await page.evaluate(() => ({
      ...window.fixture.counts,
      unchangedCardPreserved:window.unchangedCard === document.querySelector(`.game-card[data-id="${window.fixture.id(2)}"]`),
      favoriteFocusPreserved:document.activeElement?.matches('.favorite-float') || false,
    }));
    await page.screenshot({ path:path.join(outputDir, baseline ? 'library-before.png' : 'library-after.png') });
    await page.evaluate(() => {
      window.fixture.resetMetrics();
      for (let i = 1; i <= 25; i++) window.fixture.patch(window.fixture.id(3), { name:`Burst result ${i}` });
    });
    await page.locator('.game-name').filter({ hasText:'Burst result 25' }).first().waitFor();
    await settle();
    const burst = await page.evaluate(() => ({ ...window.fixture.counts }));
    if (!baseline) {
      assert.equal(favorite.listGames + favorite.snapshot, 0, 'one-game changes must not read the full library');
      assert.equal(favorite.pageRebuilds, 0, 'favorite must preserve the page');
      assert(favorite.unchangedCardPreserved, 'unaffected cards must retain their nodes');
      assert(favorite.favoriteFocusPreserved, 'favorite retains keyboard focus');
      assert.equal(burst.listGames + burst.snapshot, 0);
      assert.equal(burst.pageRebuilds, 0);

      await page.locator('#global-search').fill('Game 00003');
      await page.waitForFunction(() => document.querySelectorAll('.game-card').length === 1 && document.querySelector('.game-card')?.dataset.id === '00000000-0000-4000-8000-000000000004');
      await page.locator('.game-card[data-id="00000000-0000-4000-8000-000000000004"]').click();
      await page.locator('#modal-root [data-action="edit"]').click();
      await page.locator('#game-name').fill('Edited Fixture');
      await page.locator('#game-genre').fill('New category');
      await page.locator('#game-tags').fill('new-tag');
      await page.locator('#game-form [type="submit"]').click();
      await page.getByText('Game updated.', { exact:true }).waitFor();
      await page.locator('#global-search').fill('Edited Fixture');
      await page.locator('.game-name').filter({ hasText:'Edited Fixture' }).first().waitFor();
      assert.equal(await page.locator('#genre-filter option[value="New category"]').count(), 1);
      assert.equal(await page.locator('#tag-filter option[value="new-tag"]').count(), 1);
      await page.locator('.game-card .favorite-float').click();
      await settle();
      await page.locator('nav [data-route="favorites"]').click();
      await page.locator('.game-card[data-id="00000000-0000-4000-8000-000000000004"] .favorite-float').click();
      await settle();
      assert.equal(await page.locator('.game-card').count(), 1, 'unfavoriting removes only that favorite');
      await page.locator('nav [data-route="library"]').click();
      await page.locator('#global-search').fill('Edited Fixture');
      await page.locator('.game-card[data-id="00000000-0000-4000-8000-000000000004"]').click();
      await page.locator('#modal-root [data-action="remove-confirm"]').click();
      await page.locator('#modal-root [data-action="remove"]').click();
      await page.getByText('Game removed from your library.', { exact:true }).waitFor();
      await page.getByText('No matching games', { exact:true }).waitFor();
      await settle();
      assert.equal(await page.locator('.game-card').count(), 0);
      await page.locator('header [data-action="add"]').click();
      await page.locator('#game-name').fill('New Fixture');
      await page.locator('#game-executable').fill('C:/Games/NewFixture.exe');
      await page.locator('#game-form [type="submit"]').click();
      await page.getByText('Game added to your library.', { exact:true }).waitFor();
      await page.locator('#global-search').fill('New Fixture');
      await page.locator('.game-name').filter({ hasText:'New Fixture' }).first().waitFor();
      await page.evaluate(() => {
        window.fixture.resetMetrics(); window.fixture.resetEvent(); window.fixture.resetEvent();
      });
      await settle();
      const resets = await page.evaluate(() => ({ ...window.fixture.counts }));
      assert.equal(resets.snapshot, 1, 'concurrent reset events share one snapshot read');
      await page.evaluate(() => window.fixture.setRunning([window.fixture.id(5001)]));
      await page.getByText('● Playing now', { exact:true }).waitFor();
    }
    assert.deepEqual(errors, []);
    const result = { mode:baseline ? 'before' : 'after', browser:browser.version(), libraryGames:5000,
      favorite, burst, journeysPassed:!baseline, note:'Mocked IPC in installed headless Chrome; not native Electron.' };
    fs.writeFileSync(path.join(outputDir, baseline ? 'renderer-before.json' : 'renderer-after.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

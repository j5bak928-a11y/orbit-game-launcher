'use strict';
// Optional mocked-renderer QA: requires Playwright and an installed Chrome.
// Set ORBIT_PLAYWRIGHT_PATH when using a shared Playwright installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.ORBIT_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const outputDir = path.join(root, 'reports/library-updates');

function installFixture({ count }) {
  const games = Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    name: `Game ${String(i).padStart(5, '0')}`, source: i % 2 ? 'epic' : 'steam',
    source_id: String(100000 + i), executable: 'C:/Games/Test.exe', install_path: 'C:/Games',
    launch_uri: '', cover: '', banner: '', icon: '', genre: 'Adventure', tags: ['Fixture'],
    favorite: false, total_play_seconds: 0, last_played_at: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    launch_args: [], working_dir: '',
  }));
  let revision = 0;
  let nextId = count;
  let runningIds = [];
  let settings = { theme:'dark', accent:'#8b7aff', reduceMotion:true, autoScan:false,
    useSteamArtwork:false, libraryFolders:[], view:'grid', sort:'name', onboardingDone:true };
  const listeners = [];
  const counts = { listGames:0, snapshot:0, runningGames:0, events:0, pageRebuilds:0 };
  const copy = value => JSON.parse(JSON.stringify(value));
  const emit = event => { counts.events++; for (const listener of listeners) listener(copy(event)); };
  const snapshot = () => ({ games:copy(games), runningIds:runningIds.slice(), revision });
  const changed = (updates = [], removedIds = []) => emit({
    type:'gamesChanged', games:updates, removedIds, runningIds, revision:++revision,
  });
  const add = data => {
    const game = { ...games[0], ...data, id:`00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
      favorite:false, tags:data.tags || [], total_play_seconds:0 };
    games.push(game); changed([game]); return { game:copy(game), added:true };
  };
  window.orbit = {
    bootstrap:async () => ({ ...snapshot(), settings:copy(settings), platform:'win32', version:'test' }),
    librarySnapshot:async () => { counts.snapshot++; return snapshot(); },
    listGames:async () => { counts.listGames++; return copy(games); },
    runningGames:async () => { counts.runningGames++; return runningIds.slice(); },
    favoriteGame:async id => {
      const game = games.find(g => g.id === id); game.favorite = !game.favorite;
      game.updated_at = new Date().toISOString(); changed([game]); return copy(game);
    },
    updateGame:async (id, patch) => {
      const game = games.find(g => g.id === id); Object.assign(game, patch);
      changed([game]); return copy(game);
    },
    addGame:async data => add(data),
    removeGame:async id => { games.splice(games.findIndex(g => g.id === id), 1); changed([], [id]); return true; },
    launchGame:async id => { runningIds = [id]; changed([]); return { tracked:true, message:'Fixture launched' }; },
    saveSettings:async patch => { settings = { ...settings, ...patch }; emit({ type:'settingsChanged', settings }); return copy(settings); },
    chooseExecutable:async () => 'C:/Games/Test.exe', chooseArtwork:async () => null,
    inspectGameFile:async file => ({ executable:file, name:'Fixture', working_dir:'C:/Games', cover:'', icon:'' }),
    chooseFolder:async () => 'C:/Games',
    openGameFolder:async () => true, openAppData:async () => true,
    discoverGames:async () => ({ games:[], warnings:[] }),
    importGames:async items => { for (const item of items) add(item); return { imported:items.length, skipped:0, errors:[] }; },
    repairSteamArtwork:async () => ({ found:0, icons:0, attempted:0, disabled:false }),
    exportLibrary:async () => ({ path:'fixture.orbit', portable:true }),
    restoreLibrary:async () => ({ imported:0, skipped:0, errors:[] }),
    onEvent:callback => { listeners.push(callback); return () => {}; },
  };
  window.fixture = {
    counts, id:n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    resetMetrics() { for (const key of Object.keys(counts)) counts[key] = 0; },
    patch(id, patch) { const game = games.find(g => g.id === id); Object.assign(game, patch); changed([game]); },
    resetEvent() { emit({ type:'gamesChanged', reason:'restore', revision:++revision }); },
    setRunning(ids) { runningIds = ids; changed([]); },
    observe() {
      const slot = document.getElementById('page-slot');
      new MutationObserver(mutations => {
        counts.pageRebuilds += mutations.filter(m => m.target === slot && m.type === 'childList').length;
      }).observe(slot, { childList:true, subtree:true });
    },
  };
}

(async () => {
  fs.mkdirSync(outputDir, { recursive:true });
  const browser = await chromium.launch({ headless:true, channel:process.env.ORBIT_BROWSER_CHANNEL || 'chrome' });
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

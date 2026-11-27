'use strict';
// Layout-only Chromium fixture: no Electron profile, installed game data, or desktop input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.ORBIT_PLAYWRIGHT_PATH || 'playwright');
const { installFixture } = require('./fixtures/renderer.cjs');

const root = path.resolve(__dirname, '..');
const server = http.createServer((request, response) => {
  const file = path.resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
  if (!file.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
  try {
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.png': 'image/png', '.webp': 'image/webp' };
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    response.end(fs.readFileSync(file));
  } catch { response.writeHead(404).end(); }
});
const sizes = [[1920,1080], [1440,900], [910,610], [768,700], [390,700], [320,568], [320,380]];
const themes = ['dark', 'light'];
const languages = ['de', 'fr', 'nl'];
const issues = [];
const failed = (scenario, problem) => issues.push(`${scenario}: ${problem}`);
const round = value => Math.round(value * 10) / 10;

async function inspect(page, scenario, { detail = false, empty = false, large = false } = {}) {
  const observed = await page.evaluate(({ detail, empty, large }) => {
    const root = document.querySelector('#controller-root');
    if (!root) return { missing: true };
    const one = selector => root.querySelector(selector);
    const rect = node => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
        width: r.width, height: r.height };
    };
    const visible = node => !!node && getComputedStyle(node).display !== 'none' &&
      !node.closest('[inert]') && node.getClientRects().length > 0;
    const header = rect(one('.tv-header')), logo = rect(one('.tv-brand')),
      exit = rect(one('.tv-exit')), footer = rect(one('.tv-footer')),
      main = rect(one('.tv-main')), lane = rect(one('.tv-recent')),
      sheet = rect(one('.tv-sheet')), spotlight = rect(one('.tv-spotlight'));
    const focus = document.activeElement;
    const active = rect(focus);
    const controls = [...root.querySelectorAll('.tv-focus')].filter(visible);
    const hintItems = [...root.querySelectorAll('.tv-hints > span')].map(rect);
    const pagination = rect(one('.tv-pagination'));
    const buttons = [...root.querySelectorAll('.tv-sheet-actions .tv-focus, .tv-tabs .tv-focus, .tv-exit, .tv-empty .tv-focus')]
      .filter(visible).map(node => ({ name: node.textContent.trim().slice(0, 32),
        kind: node.dataset.tvKey, rect: rect(node), scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth, css: getComputedStyle(node).overflowWrap }));
    const clipped = [...root.querySelectorAll('.tv-spotlight-copy, .tv-library-heading, .tv-empty, .tv-section-heading, .tv-sheet-copy, .tv-sheet-actions, .tv-pagination')]
      .filter(visible).filter(node => {
        const style = getComputedStyle(node);
        return style.overflowX === 'hidden' && node.scrollWidth > node.clientWidth + 3;
      }).map(node => ({ selector: node.className, scroll: node.scrollWidth, box: node.clientWidth }));
    const contrast = (foreground, background) => {
      const values = color => (color.match(/[\d.]+/g) || []).slice(0,3).map(Number);
      const luminance = color => values(color).reduce((sum, channel, index) => {
        const s = channel / 255, linear = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        return sum + linear * [0.2126, 0.7152, 0.0722][index];
      }, 0);
      const a = luminance(foreground), b = luminance(background);
      return (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05);
    };
    const spotlightTitle = one('.tv-spotlight h2');
    const spotlightStyle = spotlightTitle && getComputedStyle(spotlightTitle);
    const contrastNodes = [['footer hints', '.tv-hints > span', '.tv-footer'],
      ['empty description', '.tv-empty p', '.tv-empty'],
      ['detail instruction', '.tv-sheet-hint', '.tv-sheet']];
    const contrasts = contrastNodes.map(([name, text, bg]) => {
      const foreground = one(text), background = one(bg);
      return foreground && background && visible(foreground)
        ? { name, ratio: contrast(getComputedStyle(foreground).color, getComputedStyle(background).backgroundColor) }
        : null;
    }).filter(Boolean);
    return {
      viewport: { width: innerWidth, height: innerHeight }, zoom: getComputedStyle(document.documentElement).zoom,
      docWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
      header, logo, exit, footer, main, lane, sheet, spotlight, hintItems, pagination, active,
      focusKey: focus?.dataset?.tvKey || '', visibleControls: controls.length,
      controls: buttons, clipped, contrasts, empty, detail, large, cards: root.querySelectorAll('[data-tv-game]').length,
      spotlightScroll: one('.tv-spotlight')?.scrollHeight || 0,
      spotlightHeight: one('.tv-spotlight')?.clientHeight || 0,
      spotlightTitleHeight: spotlightTitle?.clientHeight || 0,
      spotlightLineHeight: spotlightStyle ? parseFloat(spotlightStyle.lineHeight) : 0,
      sheetScroll: one('.tv-sheet')?.scrollHeight || 0,
      sheetHeight: one('.tv-sheet')?.clientHeight || 0,
      emptyButton: rect(one('.tv-empty .tv-focus')),
      root: rect(root),
      footerScrollWidth: one('.tv-footer')?.scrollWidth || 0,
      footerWidth: one('.tv-footer')?.clientWidth || 0,
      statusVisibility: getComputedStyle(one('.tv-controller-status')).display,
      statusAccessibleText: one('.tv-controller-status').textContent.trim(),
    };
  }, { detail, empty, large });
  if (observed.missing) { failed(scenario, 'controller root missing'); return; }
  const o = observed, v = o.viewport, eps = 2;
  if (o.docWidth > v.width + eps || o.bodyWidth > v.width + eps)
    failed(scenario, `document horizontal overflow ${o.docWidth}/${o.bodyWidth} > ${v.width}`);
  if (o.logo.right > o.exit.left - 3 || o.exit.right > v.width + eps || o.exit.left < -eps)
    failed(scenario, `header logo/exit overlap or offscreen: logo=${JSON.stringify(o.logo)} exit=${JSON.stringify(o.exit)}`);
  if (o.exit.height < 43.5) failed(scenario, `Exit touch height ${round(o.exit.height)}px`);
  if (o.footer.bottom > v.height + eps || o.footer.top < -eps ||
    o.footerScrollWidth > o.footerWidth + eps) failed(scenario, `footer overflow ${JSON.stringify(o.footer)} width ${o.footerScrollWidth}/${o.footerWidth}`);
  for (const [i, h] of o.hintItems.entries()) {
    if (h.left < o.footer.left - eps || h.right > o.footer.right + eps ||
      h.top < o.footer.top - eps || h.bottom > o.footer.bottom + eps)
      failed(scenario, `footer hint ${i} out of bounds ${JSON.stringify(h)}`);
  }
  if (!o.main || o.main.height < 38) failed(scenario, `main viewport too short ${o.main?.height}`);
  if (o.cards > 40) failed(scenario, `5000-game pagination rendered ${o.cards} cards`);
  for (const item of o.controls) {
    if (item.rect.left < -eps || item.rect.right > v.width + eps)
      failed(scenario, `action ${item.kind} out of viewport ${JSON.stringify(item.rect)}`);
    if (item.scrollWidth > item.clientWidth + 3 && item.css !== 'anywhere')
      failed(scenario, `action ${item.kind} text overflows ${item.scrollWidth}/${item.clientWidth}`);
    if (item.rect.height < 43.5)
      failed(scenario, `action ${item.kind} touch height ${round(item.rect.height)}`);
  }
  for (const c of o.clipped) failed(scenario, `clipped ${c.selector}: ${c.scroll}/${c.box}`);
  for (const sample of o.contrasts) {
    if (sample.ratio < 4.5) failed(scenario, `${sample.name} text contrast ${round(sample.ratio)}:1 below 4.5:1`);
  }
  if (v.width <= 700 && (o.statusVisibility === 'none' || !o.statusAccessibleText))
    failed(scenario, 'narrow controller live connection status is not accessible');
  if (o.spotlightScroll > o.spotlightHeight + 3)
    failed(scenario, `spotlight clipped vertically ${o.spotlightScroll}/${o.spotlightHeight}`);
  if (o.spotlightLineHeight && o.spotlightTitleHeight > o.spotlightLineHeight * 3 + 3)
    failed(scenario, `overlong spotlight title pushes beyond 3 lines: ${o.spotlightTitleHeight}/${o.spotlightLineHeight}`);
  if (detail) {
    if (!o.sheet) failed(scenario, 'detail sheet missing');
    else {
      if (o.sheet.left < -eps || o.sheet.right > v.width + eps ||
        o.sheet.top < -eps || o.sheet.bottom > v.height + eps)
        failed(scenario, `detail sheet outside screen ${JSON.stringify(o.sheet)}`);
      if (!o.focusKey.startsWith('detail:')) failed(scenario, `detail focus escaped ${o.focusKey}`);
      if (o.active && (o.active.left < o.sheet.left - eps || o.active.right > o.sheet.right + eps ||
        o.active.top < o.sheet.top - eps || o.active.bottom > o.sheet.bottom + eps))
        failed(scenario, `focused detail action outside visible sheet ${JSON.stringify(o.active)}`);
      if (v.height <= 480) {
        for (const key of ['detail:play', 'detail:favorite', 'detail:back']) {
          const action = o.controls.find(item => item.kind === key);
          if (!action || action.rect.top < Math.max(o.sheet.top, 0) + 8 ||
            action.rect.bottom > Math.min(o.sheet.bottom, v.height) - 8)
            failed(scenario, `short-height detail ${key} is outside visible sheet: ${JSON.stringify(action?.rect)}`);
        }
      }
    }
  } else if (!o.active || !o.focusKey) failed(scenario, `lost controller focus: ${o.focusKey}`);
  if (empty && o.pagination?.height) failed(scenario, 'empty state displays dead pagination');
}

async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(process.env.ORBIT_BROWSER_EXECUTABLE
    ? { headless: true, executablePath: process.env.ORBIT_BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] }
    : { headless: true, channel: process.env.ORBIT_BROWSER_CHANNEL || 'chrome' });
  let checks = 0;
  try {
    for (const count of [0, 1, 5000]) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US', reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(installFixture, { count });
      await page.addInitScript(size => {
        if (size > 0) {
          window.fixture.patch(window.fixture.id(1), { name: 'Very long controller game title '.repeat(8),
            last_played_at: '2026-11-04T10:00:00Z' });
        }
        if (size > 1) window.fixture.patch(window.fixture.id(2), { last_played_at: '2026-11-03T10:00:00Z' });
      }, count);
      await page.goto(`http://127.0.0.1:${server.address().port}/src/ui/index.html`);
      await page.getByRole('button', { name: 'Enter controller mode', exact: true }).click();
      await page.locator('#controller-root').waitFor();
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        for (const language of languages) {
          await page.evaluate(code => window.OrbitI18n.setLanguage(code), language);
          for (const theme of themes) {
            await page.evaluate(value => window.orbit.saveSettings({ theme: value }), theme);
            await page.waitForTimeout(65);
            // Locale/theme fixture callbacks can leave this independent visual
            // layout scene closed. Reenter before measuring its geometry; the
            // dedicated controller-entry test covers lifecycle transitions.
            if (!(await page.locator('#controller-root').count())) {
              await page.locator('[data-action="controller-mode"]').click();
              await page.locator('#controller-root').waitFor();
            }
            const scenario = `games=${count} ${width}x${height} ${language}/${theme}`;
            await inspect(page, scenario, { empty: count === 0, large: count === 5000 });
            checks++;
            const capture = (count === 0 && width === 320 && height === 568 && language === 'de' && theme === 'light') ||
              (count === 1 && width === 1440 && language === 'de' && theme === 'dark') ||
              (count === 1 && width === 390 && language === 'fr' && theme === 'light') ||
              (count === 5000 && width === 910 && language === 'de' && theme === 'dark') ||
              (count === 5000 && width === 320 && height === 380 && language === 'fr' && theme === 'light');
            if (capture && process.env.ORBIT_LAYOUT_OUTPUT) {
              fs.mkdirSync(process.env.ORBIT_LAYOUT_OUTPUT, { recursive: true });
              await page.screenshot({ path: path.join(process.env.ORBIT_LAYOUT_OUTPUT,
                `layout-${count}-${width}x${height}-${language}-${theme}.png`) });
            }
            if ((width === 320 && height === 380) || (width === 910 && height === 610)) {
              const first = page.locator('.tv-library .tv-card').first();
              if (count > 0 && await first.count()) {
                await first.click();
                await page.locator('.tv-sheet').waitFor();
                await inspect(page, `${scenario} detail`, { detail: true });
                checks++;
                if (process.env.ORBIT_LAYOUT_OUTPUT && count === 5000 && language === 'fr' && theme === 'light' &&
                  ((width === 320 && height === 380) || width === 910)) {
                  fs.mkdirSync(process.env.ORBIT_LAYOUT_OUTPUT, { recursive: true });
                  await page.screenshot({ path: path.join(process.env.ORBIT_LAYOUT_OUTPUT,
                    `detail-5000-${width}x${height}-fr-light.png`) });
                }
                await page.keyboard.press('Escape');
              }
            }
          }
        }
      }
      // At 200% browser zoom, the CSS layout viewport is approximately
      // half the physical dimensions; this verifies the equivalent layout
      // without distorting DOM rectangles with CSS transform/zoom.
      await page.setViewportSize({ width: 384, height: 350 });
      // The last compact-detail Escape can legitimately leave controller
      // mode if the detail has already been dismissed. Restore the fixture
      // before measuring the independent 200%-equivalent viewport.
      if (!(await page.locator('#controller-root').count())) {
        await page.locator('[data-action="controller-mode"]').click();
        await page.locator('#controller-root').waitFor();
      }
      await page.waitForTimeout(90);
      await inspect(page, `games=${count} 768x700 @200%-equivalent viewport`, { empty: count === 0 });
      checks++;
      if (count > 0) {
        await page.locator('.tv-library .tv-card').first().click();
        await page.locator('.tv-sheet').waitFor();
        await inspect(page, `games=${count} 768x700 @200%-equivalent detail`, { detail: true });
        checks++;
        await page.keyboard.press('Escape');
      }
      if (count === 1) {
        await page.setViewportSize({ width: 390, height: 700 });
        await page.locator('.tv-library .tv-card').first().click();
        await page.locator('.tv-sheet').waitFor();
        await page.evaluate(() => window.fixture.setRunning([window.fixture.id(1)]));
        await page.waitForFunction(() => document.querySelector('.tv-sheet .tv-play')?.getAttribute('aria-disabled') === 'true');
        for (const [width, height, language] of [[390,700,'de'], [320,568,'fr']]) {
          await page.setViewportSize({ width, height });
          await page.evaluate(code => window.OrbitI18n.setLanguage(code), language);
          for (const theme of themes) {
            await page.evaluate(value => window.orbit.saveSettings({ theme: value }), theme);
            const play = page.locator('.tv-sheet .tv-play');
            await play.focus();
            await inspect(page, `running game ${width}x${height} ${language}/${theme}`, { detail: true });
            checks++;
            const state = await play.evaluate(node => {
              const style = getComputedStyle(node);
              return { aria: node.getAttribute('aria-disabled'), disabled: node.disabled,
                background: style.backgroundColor, color: style.color,
                outlineWidth: parseFloat(style.outlineWidth), outlineOffset: parseFloat(style.outlineOffset),
                focusKey: document.activeElement?.dataset?.tvKey };
            });
            assert.equal(state.aria, 'true', 'running game Play must announce unavailable to assistive tech');
            assert.equal(state.disabled, false, 'unavailable Play remains focusable');
            assert.equal(state.focusKey, 'detail:play', 'active Play control retains focus while unavailable');
            assert.match(state.background, /rgba\(139, 122, 255, 0\.3/, 'unavailable Play must use muted accent background');
            assert.equal(state.color, 'rgb(244, 242, 250)', 'unavailable Play retains light readable text in both themes');
            assert(state.outlineWidth >= 3 && state.outlineOffset >= 4, 'unavailable Play retains a visible focus ring');
          }
        }
        await page.keyboard.press('Escape');
      }
      for (const error of errors) failed(`games=${count}`, `page error ${error}`);
      await page.close();
      console.log(`Layout fixture ${count} games finished`);
    }
    if (issues.length) {
      console.error(`Controller layout defects (${issues.length}):\n${issues.slice(0, 70).join('\n')}`);
      if (issues.length > 70) console.error(`...and ${issues.length - 70} more`);
      const categories = new Map();
      for (const issue of issues) {
        const detail = issue.slice(issue.indexOf(': ') + 2);
        const category = detail.startsWith('action ') && detail.includes('touch height')
          ? detail.slice(0, detail.indexOf(' touch height'))
          : detail.startsWith('header ') ? 'header'
          : detail.startsWith('footer ') ? 'footer'
          : detail.startsWith('spotlight ') ? 'spotlight'
          : detail.startsWith('detail ') ? 'detail'
          : detail.startsWith('focused ') ? 'focused'
          : detail.startsWith('document ') ? 'document'
          : detail.startsWith('clipped ') ? 'clipped'
          : detail;
        categories.set(category, (categories.get(category) || 0) + 1);
      }
      console.error('Categories:', JSON.stringify([...categories]));
      console.error('Last issues:', issues.slice(-12).join('\n'));
      if (process.env.ORBIT_LAYOUT_AUDIT !== '1') throw Error(`${issues.length} controller layout defects`);
    }
    console.log(`Controller layout: ${checks} Chromium scenarios checked; ${issues.length} defects.`);
    assert(checks >= 120);
  } finally {
    await browser.close();
    server.close();
  }
}
run().catch(error => { console.error(error); server.close(); process.exitCode = 1; });

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const renderer = path.resolve(__dirname, '../src/ui');
const source = fs.readFileSync(path.join(renderer, 'i18n.js'), 'utf8');
const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
const { createUpdateService } = require('../src/core/updates.cjs');

function createRuntime(primary = 'en-US', fallback = 'en-GB') {
  const listeners = new Map();
  const fired = [];
  const navigator = { languages: [primary, fallback], language: fallback };
  const document = { documentElement: { lang: 'en' } };
  const window = {
    addEventListener(name, listener) {
      const callbacks = listeners.get(name) || [];
      callbacks.push(listener);
      listeners.set(name, callbacks);
    },
    dispatchEvent(event) {
      fired.push(event);
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
  };
  class CustomEvent {
    constructor(type, config) {
      this.type = type;
      this.detail = config.detail;
    }
  }
  const context = vm.createContext({
    navigator, document, window, CustomEvent, Intl, Date, Object, Number,
  });
  vm.runInContext(source, context, { filename: 'i18n.js', timeout: 1000 });
  return { i18n: window.OrbitI18n, navigator, document, window, fired };
}

test('module is loaded before controller and desktop renderers with local-only CSP', () => {
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"\s+defer><\/script>/g)]
    .map(match => match[1]);
  assert.ok(scripts.indexOf('./i18n.js') > -1);
  assert.ok(scripts.indexOf('./i18n.js') < scripts.indexOf('./controller-mode.js'));
  assert.ok(scripts.indexOf('./i18n.js') < scripts.indexOf('./app.js'));
  assert.match(html, /script-src 'self'/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(source, /\b(?:eval|Function)\s*\(/);
});

test('five supported locale choices and system preference', () => {
  const { i18n, document, fired } = createRuntime('nl-NL');
  assert.deepEqual(Array.from(i18n.languages, l => l.code), ['system', 'en', 'nl', 'de', 'fr', 'es']);
  assert.equal(i18n.getPreference(), 'system');
  assert.equal(i18n.getLanguage(), 'nl');
  assert.equal(document.documentElement.lang, 'nl');
  assert.equal(i18n.setLanguage('fr'), 'fr');
  assert.equal(document.documentElement.lang, 'fr');
  assert.equal(i18n.getPreference(), 'fr');
  assert.equal(fired.at(-1).type, 'orbit:languagechange');
  assert.equal(fired.at(-1).detail.language, 'fr');
  assert.equal(fired.at(-1).detail.preference, 'fr');
});

test('all locales translate navigation, preferences, play actions, controller and empty states', () => {
  const { i18n } = createRuntime();
  const known = ['Overview', 'Settings', 'Language', 'Play', 'No games yet', 'CONTROLLER MODE'];
  const expectations = {
    en: ['Overview', 'Settings', 'Language', 'Play', 'No games yet', 'CONTROLLER MODE'],
    nl: ['Overzicht', 'Instellingen', 'Taal', 'Spelen', 'Nog geen games', 'CONTROLLERMODUS'],
    de: ['Übersicht', 'Einstellungen', 'Sprache', 'Spielen', 'Noch keine Spiele', 'CONTROLLER-MODUS'],
    fr: ['Vue d’ensemble', 'Paramètres', 'Langue', 'Jouer', 'Aucun jeu pour le moment', 'MODE MANETTE'],
    es: ['Resumen', 'Configuración', 'Idioma', 'Jugar', 'Todavía no hay juegos', 'MODO MANDO'],
  };
  for (const code of ['en', 'nl', 'de', 'fr', 'es']) {
    i18n.setLanguage(code);
    assert.deepEqual(known.map(k => i18n.t(k)), expectations[code], code);
  }
});

test('controller right-stick scroll hint and F11/Menu tooltip translate exactly in every language', () => {
  const { i18n } = createRuntime();
  const scrollKey = 'Scroll';
  const tooltipKey = 'Controller mode (F11 / Menu)';
  const expected = {
    en: ['Scroll', 'Controller mode (F11 / Menu)'],
    nl: ['Scrollen', 'Controllermodus (F11 / Menu)'],
    de: ['Scrollen', 'Controller-Modus (F11 / Menü)'],
    fr: ['Faire défiler', 'Mode manette (F11 / Menu)'],
    es: ['Desplazar', 'Modo mando (F11 / Menú)'],
  };
  for (const [code, translated] of Object.entries(expected)) {
    i18n.setLanguage(code);
    assert.deepEqual([i18n.t(scrollKey), i18n.t(tooltipKey)], translated, code);
    for (const value of translated) {
      assert.deepEqual([...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)], [],
        'new controller labels must not introduce interpolation placeholders');
    }
  }
});

test('Rust-primary 0.2.11 What\'s New dialog retains 0.2.7–0.2.10 history in all five languages', () => {
  const { i18n } = createRuntime();
  const keys = [
    "What's new", "What's new in Orbit", "See what's new", 'Release notes',
    'Continue to your library', 'Close release notes', 'Your Orbit is ready',
    'Highlights from 0.2.7 and 0.2.8', 'Rust is now the primary Windows edition',
    'Electron remains available as a fallback.', '0.2.8 — New',
    '0.2.7 — Included improvements', 'A cleaner library', 'Controller experience',
    'Language and accessibility', 'Data safety and performance',
    'Fully purple favorite hearts', 'Read the full changelog', 'View release notes',
    'You can reopen this screen in Settings.', "Show what's new after installing or updating.",
    'Poster cards, purple Play buttons and responsive layouts.',
    'Standard gamepads: Menu/Options entry, safer focus, triggers and right-stick scrolling.',
    'English, Nederlands, Deutsch, Français and Español with automatic language selection.',
    'Safer portable backups, completed play-session history and first-run library migration.',
    'Stronger artwork handling, offline cover repair and session recovery.',
    'Windows builds are unsigned; automatic update installation remains disabled.',
    'Rust and Electron keep separate profiles. Back up before switching.',
    'Release highlights appear once per version and can be reopened in Settings.',
    'Highlights from 0.2.7, 0.2.8 and 0.2.9',
    '0.2.9 — New',
    'Favorite hearts stay top-left and align with the actions menu on the right. Outlines and selected fills are purple.',
    'Rocket League no longer stays Playing because of a leftover EAC helper process.',
    'Xbox and Game Pass local game logos appear when a portrait cover is unavailable.',
    'Release notes are always available from the sidebar and Settings.',
    'Highlights from 0.2.7 through 0.2.10',
    '0.2.10 — New',
    'A cleaner interface',
    'Selected favorite hearts remain visible; other hearts appear on hover or keyboard focus.',
    'The release notes scrollbar is slim, rounded and uses your accent color.',
    'Highlights from 0.2.7 through 0.2.11',
    '0.2.11 — New',
    "The What's New dialog no longer has a purple border around the whole window.",
    'The close button is aligned with the header and remains keyboard accessible.',
  ];
  assert.equal(keys.length, 44);
  const expectedHeadings = {
    en: ["What's new", 'Release notes', '0.2.11 — New'],
    nl: ['Wat is er nieuw', 'Versienotities', '0.2.11 — Nieuw'],
    de: ['Neuigkeiten', 'Versionshinweise', '0.2.11 — Neu'],
    fr: ['Nouveautés', 'Notes de version', '0.2.11 — Nouveautés'],
    es: ['Novedades', 'Notas de la versión', '0.2.11 — Novedades'],
  };
  const placeholderNames = value => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
    .map(match => match[1]).sort();
  for (const code of ['en', 'nl', 'de', 'fr', 'es']) {
    i18n.setLanguage(code);
    assert.deepEqual([i18n.t(keys[0]), i18n.t(keys[3]), i18n.t('0.2.11 — New')], expectedHeadings[code]);
    for (const key of keys) {
      const translated = i18n.t(key);
      assert.ok(translated.length > 0, `${code}: empty release translation for ${key}`);
      assert.deepEqual(placeholderNames(translated), placeholderNames(key), `${code}: ${key}`);
      if (code !== 'en') assert.notEqual(translated, key, `${code}: untranslated release key ${key}`);
      else assert.equal(translated, key, 'English release text should match its source key');
    }
  }
});

test('update availability interpolates the release version in every supported language', async () => {
  const { i18n } = createRuntime();
  const electron = createUpdateService({
    app:{isPackaged:true,getVersion:()=>'0.2.10'},platform:'win32',
    fetchRelease:async()=>new Response(JSON.stringify({tag_name:'v0.2.11',draft:false,prerelease:false})),
  });
  const status = await electron.check();
  const expected = {
    en:'Orbit 0.2.11 is available.', nl:'Orbit 0.2.11 is beschikbaar.',
    de:'Orbit 0.2.11 ist verfügbar.', fr:'Orbit 0.2.11 est disponible.',
    es:'Orbit 0.2.11 está disponible.'
  };
  for (const [code, message] of Object.entries(expected)) {
    i18n.setLanguage(code);
    assert.equal(i18n.t(status.message, {version:status.version}), message);
    const unknown = 'Updater request failed: HTTP 418 <retry in 30s>';
    assert.equal(i18n.t(unknown), unknown);
  }
});

test('English fallback for unknown keys, including prototype names, and Dutch Spelen override', () => {
  const { i18n } = createRuntime();
  i18n.setLanguage('en');
  assert.equal(i18n.t('Spelen'), 'Play');
  for (const code of ['nl', 'de', 'fr', 'es']) {
    i18n.setLanguage(code);
    assert.equal(i18n.t('Unknown UI sentence'), 'Unknown UI sentence');
    assert.equal(i18n.t('__proto__'), '__proto__');
    assert.equal(i18n.t('constructor'), 'constructor');
  }
  i18n.setLanguage('nl');
  assert.equal(i18n.t('Spelen'), 'Spelen');
});

test('system language prioritizes navigator.languages[0] and defaults to English', () => {
  const runtime = createRuntime('de-AT', 'fr-FR');
  const { i18n, navigator, window } = runtime;
  assert.equal(i18n.getLanguage(), 'de');
  i18n.setLanguage('es');
  navigator.languages[0] = 'nl-BE';
  window.dispatchEvent({ type: 'languagechange' });
  assert.equal(i18n.getLanguage(), 'es', 'explicit language choice remains fixed');
  i18n.setLanguage('system');
  assert.equal(i18n.getLanguage(), 'nl');
  navigator.languages[0] = 'zh-CN';
  window.dispatchEvent({ type: 'languagechange' });
  assert.equal(i18n.getLanguage(), 'en', 'unsupported primary OS locale falls back to English');
  navigator.languages = [];
  navigator.language = 'fr-CA';
  i18n.setLanguage('system');
  assert.equal(i18n.getLanguage(), 'fr', 'uses navigator.language if languages is empty');
});

test('language changes are rejected if unsupported, without changing the preference', () => {
  const { i18n } = createRuntime();
  i18n.setLanguage('es');
  assert.throws(() => i18n.setLanguage('xx'), { name: 'RangeError', message: /Unsupported Orbit language/ });
  assert.equal(i18n.getLanguage(), 'es');
  assert.equal(i18n.getPreference(), 'es');
});

test('parameter interpolation is literal, repeated, and leaves missing tokens untouched', () => {
  const { i18n } = createRuntime();
  i18n.setLanguage('de');
  assert.equal(i18n.t('View details for {name}', { name: 'Hollow Knight' }), 'Details zu Hollow Knight anzeigen');
  assert.equal(i18n.t('View details for {name}'), 'Details zu {name} anzeigen');
  assert.equal(i18n.t('{name} + {name}', { name: 'Test' }), 'Test + Test');
  assert.equal(i18n.t('View details for {name}', Object.create({ name: 'Inherited' })), 'Details zu {name} anzeigen');
});

test('translation output is inert text; markup and interpolated data require caller HTML escaping', () => {
  const { i18n, document } = createRuntime();
  i18n.setLanguage('fr');
  const malicious = '<img src=x onerror=alert(1)>';
  const translated = i18n.t('View details for {name}', { name: malicious });
  assert.ok(translated.includes(malicious), 't() is a pure text translator, not an HTML sanitizer');
  const escapeHtml = input => String(input).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  const escaped = escapeHtml(translated);
  assert.ok(escaped.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!escaped.includes('<img'));
  assert.equal(document.documentElement.lang, 'fr');
  assert.equal(document.documentElement.innerHTML, undefined, 'module never writes HTML');
});

test('locale-aware date and number formatting follow the selected language', () => {
  const { i18n } = createRuntime();
  const date = new Date('2026-11-07T12:00:00.000Z');
  const options = { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' };
  const locales = { en: 'en-US', nl: 'nl-NL', de: 'de-DE', fr: 'fr-FR', es: 'es-ES' };
  for (const [code, locale] of Object.entries(locales)) {
    i18n.setLanguage(code);
    assert.equal(i18n.formatNumber(1234.5), new Intl.NumberFormat(locale).format(1234.5));
    assert.equal(i18n.formatDate(date, options), new Intl.DateTimeFormat(locale, options).format(date));
  }
  assert.equal(i18n.formatDate('invalid'), '');
  assert.equal(i18n.formatDate(null), '');
});

test('translation catalog covers literal keys consumed by both renderers', () => {
  const catalog = new Set(
    [...source.matchAll(/^\s*\[\s*"((?:\\.|[^"\\])*)"\s*,/gm)]
      .map(match => JSON.parse('"' + match[1] + '"')),
  );
  const missing = [];
  for (const file of ['app.js', 'controller-mode.js']) {
    const rendererSource = fs.readFileSync(path.join(renderer, file), 'utf8');
    const calls = /\b(?:t|tr)\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g;
    for (const match of rendererSource.matchAll(calls)) {
      const literal = match[1];
      const key = literal[0] === '"' ? JSON.parse(literal) : literal.slice(1, -1).replace(/\\'/g, "'");
      if (!catalog.has(key) && !['Steam', 'Epic Games', 'GOG', 'EA app', 'Ubisoft Connect', 'Battle.net', 'Xbox / PC Game Pass', 'Heroic', 'Legendary'].includes(key))
        missing.push(file + ': ' + key);
    }
    if (file === 'controller-mode.js') {
      for (const match of rendererSource.matchAll(/data-tv-(?:i18n|aria)="([^"]+)"/g)) {
        if (!catalog.has(match[1])) missing.push(file + ': static controller label ' + match[1]);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('every catalog row has four translations, matching placeholders and a unique English key', () => {
  const start = source.indexOf('const entries = [');
  const end = source.indexOf('\n];', start);
  assert.ok(start >= 0 && end > start);
  const data = source.slice(start, end);
  const rows = [...data.matchAll(/^\s*(\[.*\]),?\s*$/gm)].map(match => JSON.parse(match[1]));
  assert.ok(rows.length > 200, 'covers navigation, settings, library, controller and import flows');
  const seen = new Set();
  const placeholders = value => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
    .map(match => match[1]).sort();
  for (const row of rows) {
    assert.equal(row.length, 5, 'English plus Dutch, German, French and Spanish: ' + row[0]);
    assert.ok(row.every(value => typeof value === 'string' && value.length > 0), row[0]);
    assert.ok(!seen.has(row[0]), 'duplicate English key: ' + row[0]);
    seen.add(row[0]);
    for (const translated of row.slice(1))
      assert.deepEqual(placeholders(translated), placeholders(row[0]), 'placeholder mismatch for ' + row[0]);
  }
});

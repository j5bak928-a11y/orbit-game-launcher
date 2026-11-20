'use strict';

const translations = require('./tray-labels.json');

function nativeLabel(value) {
  // Win32 menus interpret ampersands as keyboard-mnemonic markers.
  return value.replace(/[\p{Cc}]/gu, ' ').replaceAll('&', '&&');
}

function trayMenuEntries({active, favorites, recent}, language, systemLanguage, blocked) {
  const locale = (language === 'system' ? systemLanguage : language) || 'en';
  const code = locale.split('-')[0].toLowerCase();
  const labels = Object.hasOwn(translations, code) ? translations[code] : translations.en;
  const timeFormat = new Intl.DateTimeFormat(Object.hasOwn(translations, code) ? code : 'en', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const entries = [{label: labels.open, action: 'open'}];
  if (!active.length) entries.push({label: labels.inactive, enabled: false});
  for (const game of active) {
    const time = new Date(game.started_at);
    const status = Number.isFinite(time.valueOf()) ? ' · ' + labels.tracking.replace('{time}', timeFormat.format(time)) : '';
    entries.push({label: nativeLabel(game.name + status), enabled: false});
  }
  for (const [games, heading] of [[favorites, labels.favorites], [recent, labels.recent]]) {
    if (!games.length) continue;
    entries.push({label: heading, submenu: games.map(game => ({
      label: nativeLabel(game.name), id: game.id, enabled: !blocked.has(game.id)
    }))});
  }
  entries.push({type: 'separator'}, {label: labels.quit, action: 'quit'});
  return entries;
}

module.exports = {trayMenuEntries};

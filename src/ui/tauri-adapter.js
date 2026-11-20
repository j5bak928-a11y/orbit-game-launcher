// Keep the renderer's existing Electron preload API when running under Tauri.
// Tauri injects __TAURI__ before deferred page scripts when withGlobalTauri=true.
(() => {
  if (window.orbit || !window.__TAURI__?.core?.invoke) return;

  const {core, event} = window.__TAURI__;
  // Wry/WebView2 registers custom protocols on a local HTTP(S) origin rather
  // than as a navigable orbit-art: scheme. Convert local artwork URLs only
  // under Windows Tauri; Electron and other platforms keep the original URI.
  window.OrbitArtworkUrl = token => {
    if (!/^[a-f\d-]{36}\.(jpg|jpeg|png|webp)$/.test(token || '')) return null;
    const onWindows = /^Win/i.test(window.navigator?.platform || '') ||
      /Windows/i.test(window.navigator?.userAgent || '');
    if (!onWindows) return `orbit-art://file/${token}`;
    const scheme = window.location?.protocol === 'https:' ? 'https' : 'http';
    return `${scheme}://orbit-art.localhost/file/${token}`;
  };
  const methods = [
    'bootstrap', 'getWindowState', 'setFullscreen', 'saveControllerReturn', 'librarySnapshot',
    'listGames', 'getStatistics', 'listSessions', 'correctSession', 'runningGames', 'getGame', 'addGame', 'updateGame',
    'removeGame', 'favoriteGame', 'saveSettings', 'chooseExecutable',
    'inspectGameFile', 'findOnlineCover', 'chooseArtwork', 'chooseFolder',
    'discoverGames', 'repairSteamArtwork', 'importGames', 'launchGame',
    'openGameFolder', 'openAppData', 'getAppInfo', 'exportLibrary',
    'restoreLibrary', 'getUpdateStatus', 'checkForUpdates', 'installUpdate'
  ];
  const subscribers = new Set();
  const api = {};

  for (const method of methods) {
    api[method] = async (...args) => {
      try {
        return await core.invoke('orbit_invoke', {method, args});
      } catch (error) {
        // Tauri can reject promises with a string; the UI expects .message.
        throw error instanceof Error ? error : new Error(String(error));
      }
    };
  }

  api.onEvent = callback => {
    if (typeof callback !== 'function') return () => {};
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  };

  // Register once for the page lifetime. Boot awaits this so changes emitted
  // during bootstrap cannot arrive before the handler is listening.
  api.ready = Promise.resolve().then(async () => {
    if (typeof event?.listen !== 'function') throw Error('Tauri event bridge is unavailable.');
    await event.listen('orbit:event', incoming => {
      for (const callback of subscribers) {
        try { callback(incoming.payload); }
        catch (error) { console.error('Orbit event handler failed:', error); }
      }
    });
  });

  window.orbit = Object.freeze(api);
})();

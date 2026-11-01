// Keep the renderer's existing Electron preload API when running under Tauri.
// Tauri injects __TAURI__ before deferred page scripts when withGlobalTauri=true.
(() => {
  if (window.orbit || !window.__TAURI__?.core?.invoke) return;

  const {core, event} = window.__TAURI__;
  const methods = [
    'bootstrap', 'getWindowState', 'setFullscreen', 'librarySnapshot',
    'listGames', 'runningGames', 'getGame', 'addGame', 'updateGame',
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

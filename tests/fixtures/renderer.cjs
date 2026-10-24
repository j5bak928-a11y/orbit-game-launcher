'use strict';
// Shared deterministic desktop IPC fixture. No operating-system or network access.
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

module.exports={installFixture};

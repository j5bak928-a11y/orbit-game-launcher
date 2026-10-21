'use strict';
// Local executable inspection. No uploaded binaries, external databases or
// unbounded recursive search: only a small set of neighboring artwork folders.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const {identifyGame,readWindowsProductName} = require('./game-identity.cjs');
const {isPortraitArtwork} = require('./cover-shape.cjs');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const IGNORE_NAMES = /^(?:game|game-win(?:32|64)-shipping|launcher|start|play|run|shipping|unityplayer|unrealengine|application|win64-shipping|setup|install|unins\w*)$/i;
const normalize = name => name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
function suggestedName(executable) {
  const basename = path.basename(executable, path.extname(executable));
  const trimmed = basename.replace(/[-_](?:win32|win64)[-_]shipping$/i,'').replace(/[-_]shipping$/i,'');
  let chosen = IGNORE_NAMES.test(basename) || !trimmed ? path.basename(path.dirname(executable)) : trimmed;
  if (/^(?:binaries|win32|win64|x64)$/i.test(chosen)) chosen = path.basename(path.dirname(path.dirname(executable)));
  return chosen.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Untitled game';
}
function rankArtwork(filename, gameKey) {
  const stem = path.basename(filename, path.extname(filename));
  const key = normalize(stem);
  const score = new Map([
    ['cover', 100], ['poster', 99], ['boxart', 98], ['keyart', 97],
    ['library600x900', 95], ['verticalcover', 94], ['folder', 90],
    ['artwork', 85], ['capsule', 75],
  ]);
  if (score.has(key)) return score.get(key);
  if (gameKey && (key === gameKey || key === `${gameKey}cover` || key === `${gameKey}poster` || key === `${gameKey}boxart`)) return 82;
  if (/^steam\d+library600x900$/.test(key)) return 92;
  return 0;
}
async function findNearbyArtwork(executable, displayName='') {
  const folder = path.dirname(executable);
  const gameKeys = [normalize(suggestedName(executable)),normalize(displayName)].filter(Boolean);
  const candidates = [];
  for (const [relative, penalty] of [['', 0], ['artwork', 2], ['art', 3], ['images', 4]]) {
    const dir = path.join(folder, relative);
    let items;
    try { items = await fsp.readdir(dir, {withFileTypes:true}); }
    catch { continue; }
    // Never search large arbitrary asset collections. Exact named artwork files
    // in these four locations are enough for a trustworthy local fallback.
    if (items.length > 5000) continue;
    for (const item of items) {
      if (!item.isFile() || !IMAGE_EXT.has(path.extname(item.name).toLowerCase())) continue;
      const score = Math.max(...gameKeys.map(key => rankArtwork(item.name,key))) - penalty;
      if (score <= 0) continue;
      candidates.push({file:path.join(dir, item.name), score});
    }
  }
  candidates.sort((a,b)=>b.score-a.score || a.file.localeCompare(b.file));
  for (const entry of candidates.slice(0, 16)) {
    try {const stat = await fsp.stat(entry.file);if (stat.isFile() && stat.size > 0 && stat.size <= 15*1024*1024 && isPortraitArtwork(await fsp.readFile(entry.file))) return entry.file;}
    catch { /* broken or disappearing artwork is optional */ }
  }
  return null;
}
async function verifyExecutable(executable) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw Error('Choose an executable file on this computer.');
  const resolved = path.normalize(executable);
  const stat = await fsp.stat(resolved).catch(()=>null);
  if (!stat?.isFile()) throw Error('That executable was not found. Choose an existing game file.');
  if (process.platform === 'win32' && !['.exe','.com'].includes(path.extname(resolved).toLowerCase())) {
    throw Error('Choose a .exe or .com game executable.');
  }
  return resolved;
}
async function inspectGameFile(executable, {saveArtwork, extractIcon, readProductName=readWindowsProductName, lookupCover} = {}) {
  const file = await verifyExecutable(executable);
  const fallbackName = suggestedName(file);
  // A known alias needs no slow OS metadata read; everything else can benefit
  // from the actual Windows VERSIONINFO ProductName when it is available.
  let identity = identifyGame(file,{fallbackName});
  if(identity.kind==='filename' && readProductName){
    try{
      const productName=await readProductName(file);
      identity=identifyGame(file,{productName,fallbackName});
    }catch{/* A malformed or metadata-free executable must still be addable. */}
  }
  const result = {
    executable:file, name:identity.name, suggested_name:fallbackName,
    recognized:identity.kind!=='filename', name_source:identity.kind,
    working_dir:path.dirname(file), cover:'', icon:'', cover_source:''
  };
  const candidate = await findNearbyArtwork(file,result.name);
  if (candidate && saveArtwork) {
    try {result.cover = await saveArtwork(candidate);result.cover_source='local';}
    catch { /* Invalid local image: use the executable icon. */ }
  }
  if (extractIcon) {
    try {result.icon = await extractIcon(file) || '';}catch { /* Windows may not expose an icon. */ }
  }
  // Public cover imagery can be found for recognized standalone titles without
  // requiring a Steam installation. Never change how this executable launches.
  if(!result.cover && (identity.steamId || identity.kind==='metadata') && lookupCover){
    try{
      result.cover=await lookupCover({name:identity.name,steamId:identity.steamId}) || '';
      if(result.cover)result.cover_source='steam';
    }catch{/* Fully offline / rate-limited / unavailable artwork uses the icon. */}
  }
  return result;
}
module.exports = {suggestedName, rankArtwork, findNearbyArtwork, verifyExecutable, inspectGameFile};

'use strict';
(() => {
const el=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Keep the renderer usable in isolated tests that do not load the i18n catalog.
const t=(key,params={})=>window.OrbitI18n?.t?.(key,params)??String(key).replace(/\{([\w]+)\}/g,(_,name)=>String(params[name]??`{${name}}`));
// Every translated string inserted into HTML is escaped. Library data stays untouched.
const tr=(key,params)=>esc(t(key,params));
const formatNumber=value=>window.OrbitI18n?.formatNumber?.(value)??String(value);
function applyLanguage(language){
 if(!window.OrbitI18n?.setLanguage)return;
 if(window.OrbitI18n.getPreference?.()!==(language||'system'))window.OrbitI18n.setLanguage(language||'system');
 document.documentElement.lang=window.OrbitI18n.getLanguage?.()||'en';
}
const iconPaths={
 home:"<path d=\"M3 10.5 12 3l9 7.5\"/><path d=\"M5.5 9.5V20h13V9.5M10 20v-6h4v6\"/>",
 library:"<rect x=\"3\" y=\"4\" width=\"8\" height=\"7\" rx=\"1.5\"/><rect x=\"13\" y=\"4\" width=\"8\" height=\"7\" rx=\"1.5\"/><rect x=\"3\" y=\"13\" width=\"8\" height=\"7\" rx=\"1.5\"/><rect x=\"13\" y=\"13\" width=\"8\" height=\"7\" rx=\"1.5\"/>",
 heart:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
 clock:"<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M12 7.5v5l3.3 2\"/>",
 settings:'<circle cx="12" cy="12" r="3"/><path d="M12.22 2h-.44a2 2 0 0 0-2 1.72l-.14 1.05a2 2 0 0 1-2.98 1.72l-.91-.52a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.91.53a2 2 0 0 1 0 3.44l-.91.53a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.91-.52a2 2 0 0 1 2.98 1.72l.14 1.05a2 2 0 0 0 2 1.72h.44a2 2 0 0 0 2-1.72l.14-1.05a2 2 0 0 1 2.98-1.72l.91.52a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.91-.53a2 2 0 0 1 0-3.44l.91-.53a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.91.52a2 2 0 0 1-2.98-1.72l-.14-1.05A2 2 0 0 0 12.22 2z"/>',
 search:'<circle cx="10.6" cy="10.6" r="6.6"/><path d="m16 16 5 5"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',play:'<path d="m8 5 12 7-12 7V5Z"/>',
 arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
 chevron:'<path d="m9 18 6-6-6-6"/>',
 grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
 list:'<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.1M3 12h.1M3 18h.1" stroke-width="3"/>',
 refresh:"<path d=\"M20 7v5h-5M4 17v-5h5\"/><path d=\"M5.3 9A7 7 0 0 1 18 6.5L20 12M4 12l2 5.5A7 7 0 0 0 18.7 15\"/>",
 download:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v3h16v-3"/>',
 folder:'<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/>',
 monitor:'<rect x="2" y="3" width="20" height="15" rx="2"/><path d="M8 22h8m-4-4v4"/>',
 sparkles:'<path d="m12 3 2 7 7 2-7 2-2 7-2-7-7-2 7-2 2-7ZM19 2v5M16.5 4.5h5"/>',
 trophy:'<path d="M7 3h10v7a5 5 0 0 1-10 0V3ZM7 5H4v4a4 4 0 0 0 4 4m9-8h3v4a4 4 0 0 1-4 4M12 15v5m-5 1h10"/>',
 close:'<path d="M18 6 6 18M6 6l12 12"/>',
 edit:'<path d="m5 17 1 3 3-1L20 8l-4-4L5 17ZM14 6l4 4"/>',
 trash:'<path d="M4 7h16M10 3h4m-8 4 1 14h10l1-14M10 11v6m4-6v6"/>',
 upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 17v4h16v-4"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
 check:'<path d="m4 12 5 5L20 6"/>',
 alert:'<path d="M12 3 2 21h20L12 3Zm0 7v5m0 3v.1"/>',
 lightning:'<path d="m13 2-9 12h7l-1 8 10-13h-7l0-7Z"/>',
 gamepad:"<path d=\"M7 7h10a5 5 0 0 1 4.9 5.9l-.8 4.3a2.2 2.2 0 0 1-3.7 1.2L15 16H9l-2.4 2.4a2.2 2.2 0 0 1-3.7-1.2l-.8-4.3A5 5 0 0 1 7 7Z\"/><path d=\"M6.5 11.5h4M8.5 9.5v4M16 11h.01M18 13h.01\" stroke-width=\"2.4\"/>",
 external:'<path d="M13 4h7v7M20 4l-9 9M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"/>',
 image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="2"/><path d="m3 17 6-6 4 4 2-2 6 6"/>',
 sort:'<path d="M5 3v18m-3-3 3 3 3-3M12 7h9M12 12h7M12 17h4"/>',
 chart:'<path d="M3 3v18h18M7 16v-4m5 4V7m5 9v-7"/><path d="m5 10 5-4 4 2 5-5"/>',
 dots:'<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>'
};
const ic=(name,size=18)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${iconPaths[name]||iconPaths.gamepad}</svg>`;
const state={games:[],collections:[],runningIds:[],settings:null,route:'home',query:'',filter:'all',status:'all',collection:'all',playtime:'all',showHidden:false,selectMode:false,selectedGames:new Set(),lastSelectedId:null,tag:'all',genre:'all',view:'grid',sort:'name',modal:null,imports:[],importPage:0,selectedImports:new Set(),scanWarnings:[],scanDiagnostics:[],pendingLaunches:new Set(),scanning:false,busy:false,platform:'',version:'',viewGames:[],statistics:{status:'idle',data:null,error:''},updateStatus:{state:'idle',message:'Update check not started.'}};
const PLAY_STATUSES=[['playing','Currently Playing'],['backlog','Backlog'],['completed','Completed'],['on_hold','On Hold']];
const STATUS_LABELS=Object.fromEntries(PLAY_STATUSES);
const COLLECTION_ICONS=['folder','sparkles','heart','trophy','gamepad','clock','lightning','library'];
const PLAYTIME_FILTERS=[['unplayed','Never played'],['under2','Under 2h'],['2to10','2h–10h'],['over10','10h+']];
const PLAYTIME_LABELS=Object.fromEntries(PLAYTIME_FILTERS);
function statusLabel(code){return STATUS_LABELS[code]?t(STATUS_LABELS[code]):'';}
function gameCollectionIds(gameId){return state.collections.filter(c=>Array.isArray(c.game_ids)&&c.game_ids.includes(gameId)).map(c=>c.id);}
function parseEnvText(raw){
 const out={};
 const lines=String(raw||'').split(/\r?\n/);
 for(const line of lines){
  const trimmed=line.trim();
  if(!trimmed||trimmed.startsWith('#'))continue;
  const eq=trimmed.indexOf('=');
  if(eq<=0)throw Error(t('Use KEY=VALUE format (one per line) for environment variables.'));
  const key=trimmed.slice(0,eq).trim(),val=trimmed.slice(eq+1);
  if(!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))throw Error(t('Invalid environment variable name: {name}',{name:key}));
  out[key]=val;
 }
 if(Object.keys(out).length>40)throw Error(t('At most 40 environment variables are allowed per game.'));
 return out;
}
function formatEnvText(env){
 if(!env||typeof env!=='object')return '';
 return Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n');
}
function parseSearchOperators(rawQuery){
 const ops={text:[],status:null,source:null,tag:null,collection:null,playtime:null,hidden:null,favorite:null};
 const tokens=String(rawQuery||'').match(/(?:[^\s"]+|"[^"]*")+/g)||[];
 for(const raw of tokens){
  const match=raw.match(/^([a-z]+):(.+)$/i);
  if(!match){ops.text.push(raw.replace(/^"|"$/g,'').toLocaleLowerCase());continue;}
  const key=match[1].toLowerCase(),val=match[2].replace(/^"|"$/g,'').trim().toLocaleLowerCase();
  if(key==='status'){
   const map={playing:'playing',backlog:'backlog',completed:'completed',done:'completed',hold:'on_hold',on_hold:'on_hold',none:'none'};
   if(map[val])ops.status=map[val];else ops.text.push(raw.toLocaleLowerCase());
  }else if(key==='source'||key==='platform'){ops.source=val;}
  else if(key==='tag'){ops.tag=val;}
  else if(key==='in'||key==='collection'){ops.collection=val;}
  else if(key==='is'){
   if(val==='hidden')ops.hidden=true;
   else if(val==='fav'||val==='favorite')ops.favorite=true;
   else ops.text.push(raw.toLocaleLowerCase());
  }else if(key==='time'||key==='playtime'){
   const num=val.match(/^([<>])?(\d+(?:\.\d+)?)h?$/);
   if(val==='0'||val==='unplayed'||val==='none')ops.playtime={op:'eq',seconds:0};
   else if(num)ops.playtime={op:num[1]||'>',seconds:Number(num[2])*3600};
   else ops.text.push(raw.toLocaleLowerCase());
  }else ops.text.push(raw.toLocaleLowerCase());
 }
 return ops;
}
function matchesPlaytimeFilter(seconds,code){
 const s=Number(seconds)||0;
 if(code==='unplayed')return s===0;
 if(code==='under2')return s>0&&s<7200;
 if(code==='2to10')return s>=7200&&s<36000;
 if(code==='over10')return s>=36000;
 return true;
}
let controllerMode=null;
let didStartupAutoEnter=false;
let notifiedUpdateReadyVersion=null;
// The desktop listens for a *new* standard Menu/Options (button 9) press.
// Unlike controller mode, this watcher never polls when there is no gamepad,
// a game is running, or the window is not visible and focused.
const desktopPadEntry={ready:false,entering:false,timer:null,neutral:new Set()};
function pauseDesktopPadEntry(){
 if(desktopPadEntry.timer!==null)clearTimeout(desktopPadEntry.timer);
 desktopPadEntry.timer=null;
 desktopPadEntry.neutral.clear();
}
function canWatchDesktopPad(){
 return desktopPadEntry.ready&&!desktopPadEntry.entering&&!!el('page-slot')&&
  !document.hidden&&document.hasFocus()&&!state.modal&&!state.scanning&&!state.busy&&
  !state.runningIds.length&&!state.pendingLaunches.size&&
  !controllerMode?.active&&!controllerMode?.session;
}
function standardDesktopPads(){
 if(typeof navigator.getGamepads!=='function')return [];
 try{
  const pads=navigator.getGamepads(),result=[];
  for(let index=0;index<Math.min(pads?.length||0,16);index++){
   const pad=pads[index];
   if(pad?.connected===true&&pad.mapping==='standard'&&
    Number.isInteger(pad.index)&&pad.index>=0&&pad.index<16&&
    Number(pad.buttons?.length)>=10)result.push(pad);
  }
  return result;
 }catch{return [];}
}
function padButtonPressed(button){return typeof button==='number'?button>0.5:!!button?.pressed||Number(button?.value)>0.5;}
function padNeutral(pad){
 for(let index=0;index<Math.min(pad.buttons.length,32);index++)if(padButtonPressed(pad.buttons[index]))return false;
 for(let index=0;index<Math.min(pad.axes?.length||0,8);index++)if(Math.abs(Number(pad.axes[index]))>0.35)return false;
 return true;
}
function pollDesktopPadEntry(){
 desktopPadEntry.timer=null;
 if(!canWatchDesktopPad()){pauseDesktopPadEntry();return;}
 const pads=standardDesktopPads();
 if(!pads.length){pauseDesktopPadEntry();return;}
 const connected=new Set(pads.map(pad=>`${pad.index}:${pad.id}`));
 for(const key of desktopPadEntry.neutral)if(!connected.has(key))desktopPadEntry.neutral.delete(key);
 for(const pad of pads){
  const key=`${pad.index}:${pad.id}`;
  if(padNeutral(pad)){desktopPadEntry.neutral.add(key);continue;}
  const freshMenu=desktopPadEntry.neutral.has(key)&&padButtonPressed(pad.buttons[9]);
  desktopPadEntry.neutral.delete(key);
  if(!freshMenu)continue;
  desktopPadEntry.entering=true;
  pauseDesktopPadEntry();
  Promise.resolve().then(()=>{
   // Recheck on the microtask boundary; a modal or game may have opened.
   if(document.hidden||!document.hasFocus()||state.modal||state.scanning||state.busy||
    state.runningIds.length||state.pendingLaunches.size||controllerMode?.active||controllerMode?.session)return;
   return toggleControllerMode();
  }).catch(error=>toast(error.message,true)).finally(()=>{
   desktopPadEntry.entering=false;
   wakeDesktopPadEntry();
  });
  return;
 }
 desktopPadEntry.timer=setTimeout(pollDesktopPadEntry,110);
}
function wakeDesktopPadEntry(){
 if(!canWatchDesktopPad()){pauseDesktopPadEntry();return;}
 if(desktopPadEntry.timer!==null)return;
 const pads=standardDesktopPads();
 if(!pads.length){pauseDesktopPadEntry();return;}
 // A connected controller is the only reason to maintain a slow timer.
 desktopPadEntry.timer=setTimeout(pollDesktopPadEntry,110);
}
function startDesktopPadEntry(){
 if(desktopPadEntry.ready)return;
 desktopPadEntry.ready=true;
 window.addEventListener('gamepadconnected',()=>{pauseDesktopPadEntry();wakeDesktopPadEntry();});
 window.addEventListener('gamepaddisconnected',()=>{pauseDesktopPadEntry();wakeDesktopPadEntry();});
 window.addEventListener('blur',pauseDesktopPadEntry);
 window.addEventListener('focus',wakeDesktopPadEntry);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseDesktopPadEntry();else wakeDesktopPadEntry();});
 wakeDesktopPadEntry();
}
function pendingDiscoveryCount(){
 return state.imports.filter(item=>!item.alreadyAdded&&!isDiscoveryIgnored(item)).length;
}
function openControllerMode(returnPosition){
 pauseDesktopPadEntry();
 if(state.modal)closeModal();
 if(!controllerMode){
  if(!window.OrbitControllerMode)throw Error('Controller mode is unavailable. Restart Orbit to load the latest files.');
  controllerMode=window.OrbitControllerMode.create({api:window.orbit,
   snapshot:()=>({
    games:state.games,
    collections:state.collections,
    runningIds:state.runningIds,
    pendingLaunches:state.pendingLaunches,
    settings:state.settings,
    updateStatus:state.updateStatus,
    discoveryCount:pendingDiscoveryCount(),
   }),
   launch:performLaunch,
   favorite,
   updateGame:async (id,patch)=>{try{return await window.orbit.updateGame(id,patch);}catch(e){toast(e.message,true);throw e;}},
   setGameCollections:async (id,collectionIds)=>{try{return await window.orbit.setGameCollections(id,collectionIds);}catch(e){toast(e.message,true);throw e;}},
   saveSettings:async patch=>{try{return await saveSettings(patch);}catch(e){toast(e.message,true);throw e;}},
   installUpdate:async ()=>{try{await window.orbit.installUpdate();}catch(e){toast(e.message||t('Could not install update.'),true);throw e;}},
   reviewDiscoveries:async ()=>{await controllerMode.exit();if(state.imports.length)openModal('import');},
   notify:toast,
   onExit:()=>{refreshNavigation(true);document.querySelector('[data-action="controller-mode"]')?.focus();wakeDesktopPadEntry();}
  });
 }
 return returnPosition?controllerMode.enter(returnPosition):controllerMode.toggle();
}
function toggleControllerMode(){return openControllerMode();}
async function restoreControllerReturn(position){
 if(!position||typeof position.gameId!=='string')return;
 try{
  if(state.games.some(game=>game.id===position.gameId))await openControllerMode(position);
  else await window.orbit.saveControllerReturn?.(null);
 }catch(error){toast(error.message,true);}
}
async function maybeAutoEnterControllerMode(){
 if(didStartupAutoEnter)return;
 didStartupAutoEnter=true;
 if(state.settings?.controllerAutoEnter&&!controllerMode?.active&&!controllerMode?.session&&
  !state.runningIds.length&&!state.pendingLaunches.size&&!state.modal&&
  !document.hidden&&document.hasFocus()&&standardDesktopPads().length>0){
  await openControllerMode().catch(error=>toast(error.message,true));
 }
}
const sourceNames={steam:'Steam',epic:'Epic Games',gog:'GOG',ea:'EA app',ubisoft:'Ubisoft Connect',battlenet:'Battle.net',xbox:'Xbox / PC Game Pass',folder:'Local',manual:'Manual'};
const palette=['#8b7aff','#5bafef','#fc8ca8','#53c5b3','#f3a65c','#bf87f5'];
function artwork(token){return /^[a-f\d-]{36}\.(jpg|jpeg|png|webp)$/.test(token||'')?(window.OrbitArtworkUrl?.(token)||`orbit-art://file/${token}`):null}
// One image per card in the common case: loading the icon behind every
// valid cover doubles image work. An invalid/unavailable cover loads its icon
// only after image validation (see ensureImageFallback below).
function coverImage(g,priority=false){const cover=artwork(g.cover),icon=artwork(g.icon);const fallback=icon&&!cover?`<span class="cover-icon-frame"><img class="cover-icon" src="${icon}" loading="lazy" decoding="async" alt="" /></span>`:'';const title=`<span class="cover-placeholder-symbol">${ic('gamepad',29)}</span><span class="cover-placeholder-title">${esc(g.name)}</span>`;const poster=cover?`<img class="cover-image ${g.cover_fit==='contain'?'fit-contain':''} position-${['top','bottom'].includes(g.cover_position)?g.cover_position:'center'}" src="${cover}" data-fallback-icon="${icon||''}" loading="${priority?'eager':'lazy'}" decoding="async" ${priority?'fetchpriority="high"':''} alt="" />`:'';return fallback+title+poster;}
function timeLabel(seconds){if(!seconds)return t('Not played yet');const total=Math.max(1,Math.round(seconds/60)),hrs=Math.floor(total/60),mins=total%60;return hrs?t('{hours}h {minutes}m played',{hours:formatNumber(hrs),minutes:formatNumber(mins)}):t('{minutes}m played',{minutes:formatNumber(total)})}
function sourceLabel(game){return game.source==='folder'?t('Local'):game.source==='manual'?t('Manual'):t(sourceNames[game.source]||'Game')}
function formatDate(date){if(!date)return t('Never');const d=new Date(date);return Number.isNaN(d.getTime())?t('Unknown'):(window.OrbitI18n?.formatDate?.(d,{month:'short',day:'numeric',year:'numeric'})??new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'}).format(d))}
function accentTextColor(hex,resolved){if(resolved!=='light')return hex;const linear=c=>{const s=c/255;return s<=0.03928?s/12.92:((s+0.055)/1.055)**2.4};const lum=(r,g,b)=>0.2126*linear(r)+0.7152*linear(g)+0.0722*linear(b);const bgLum=lum(244,245,250);let r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);for(let step=0;step<24&&(bgLum+0.05)/(lum(r,g,b)+0.05)<4.8;step++){r=Math.round(r*0.86);g=Math.round(g*0.86);b=Math.round(b*0.86);}return `#${[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('')}`;}
function setupTheme(){const theme=state.settings?.theme||'dark';const resolved=theme==='system'&&window.matchMedia?.('(prefers-color-scheme: light)').matches?'light':theme==='system'?'dark':theme;document.documentElement.dataset.theme=resolved;document.documentElement.style.colorScheme=resolved;document.body.dataset.theme=resolved;document.body.dataset.reduceMotion=String(!!state.settings?.reduceMotion);document.body.dataset.density=state.settings?.libraryDensity==='compact'?'compact':'comfortable';const accent=state.settings?.accent||palette[0];document.documentElement.style.setProperty('--accent',accent);document.documentElement.style.setProperty('--accent-text',accentTextColor(accent,resolved));const n=parseInt(accent.slice(1),16);document.documentElement.style.setProperty('--accent-rgb',`${n>>16},${(n>>8)&255},${n&255}`);document.documentElement.style.setProperty('--accent-ink','#11121d')}
function totalHours(){return formatNumber(Math.round(state.games.filter(g=>!g.hidden).reduce((sum,g)=>sum+(g.total_play_seconds||0),0)/3600*10)/10)}
const sortedGames=arr=>arr.slice().sort((a,b)=>state.sort==='recent'?(Date.parse(b.last_played_at||0)||0)-(Date.parse(a.last_played_at||0)||0)||a.name.localeCompare(b.name):state.sort==='added'?(Date.parse(b.created_at||0)||0)-(Date.parse(a.created_at||0)||0):state.sort==='time'?(b.total_play_seconds||0)-(a.total_play_seconds||0):a.name.localeCompare(b.name));
let filterCache=null;
function filtered(){const key=[state.games,state.collections,state.route,state.filter,state.status,state.collection,state.playtime,state.showHidden,state.tag,state.genre,state.sort,state.query];if(filterCache&&key.every((x,i)=>filterCache.key[i]===x))return filterCache.value;
  const ops=state.query.trim()?parseSearchOperators(state.query):null;
  let a=state.games.slice();
  if(ops?.hidden)a=a.filter(g=>g.hidden);
  else if(!state.showHidden)a=a.filter(g=>!g.hidden);
  if(state.route==='favorites'||ops?.favorite)a=a.filter(g=>g.favorite);
  if(state.route==='recent')a=a.filter(g=>g.last_played_at);
  if(state.filter!=='all')a=a.filter(g=>g.source===state.filter);
  if(state.status!=='all')a=a.filter(g=>state.status==='none'?!g.play_status:g.play_status===state.status);
  if(state.collection!=='all'){
   const col=state.collections.find(c=>c.id===state.collection);
   const set=new Set(col?.game_ids||[]);
   a=a.filter(g=>set.has(g.id));
  }
  if(state.playtime!=='all')a=a.filter(g=>matchesPlaytimeFilter(g.total_play_seconds,state.playtime));
  if(state.tag!=='all')a=a.filter(g=>g.tags?.includes(state.tag));
  if(state.genre!=='all')a=a.filter(g=>g.genre===state.genre);
  if(ops){
   if(ops.status)a=a.filter(g=>ops.status==='none'?!g.play_status:g.play_status===ops.status);
   if(ops.source)a=a.filter(g=>(g.source||'').toLocaleLowerCase()===ops.source);
   if(ops.tag)a=a.filter(g=>(g.tags||[]).some(tag=>tag.toLocaleLowerCase().includes(ops.tag)));
   if(ops.collection){
    const matchedCols=state.collections.filter(c=>c.name.toLocaleLowerCase().includes(ops.collection));
    const colGameIds=new Set(matchedCols.flatMap(c=>c.game_ids||[]));
    a=a.filter(g=>colGameIds.has(g.id));
   }
   if(ops.playtime){
    a=a.filter(g=>{
     const secs=Number(g.total_play_seconds)||0;
     if(ops.playtime.op==='eq')return secs===ops.playtime.seconds;
     if(ops.playtime.op==='<')return secs<ops.playtime.seconds;
     return secs>=ops.playtime.seconds;
    });
   }
   for(const q of ops.text){a=a.filter(g=>[g.name,g.genre,g.source,statusLabel(g.play_status),...(g.tags||[])].some(v=>(v||'').toLocaleLowerCase().includes(q)));}
  }
  const result=sortedGames(a);filterCache={key,value:result};return result;
}
function card(g){const playing=state.runningIds?.includes(g.id);const selected=state.selectMode&&state.selectedGames.has(g.id);return `<article class="game-card poster-card ${playing?'is-playing':''} ${selected?'is-selected':''} ${g.hidden?'is-hidden-game':''}" data-id="${esc(g.id)}" title="${esc(g.name)}"><div class="cover cinematic-card-cover">${coverImage(g)}<span class="cover-letter">${esc(g.name.slice(0,2))}</span><button type="button" class="card-open-trigger" data-action="${state.selectMode?'toggle-select':'detail'}" data-id="${esc(g.id)}" aria-label="${tr(state.selectMode?'Select {name}':'View details for {name}',{name:g.name})}"></button>${state.selectMode?`<label class="bulk-check" aria-label="${tr('Select {name}',{name:g.name})}"><input type="checkbox" data-select-game="${esc(g.id)}" ${selected?'checked':''}/></label>`:''}${playing?`<span class="cover-live-badge"><i class="live-dot" aria-hidden="true"></i>${tr('Playing')}</span>`:''}<button type="button" class="favorite-float ${g.favorite?'active':''}" data-action="favorite" data-id="${esc(g.id)}" aria-label="${tr(g.favorite?'Remove favorite':'Add favorite')}" aria-pressed="${!!g.favorite}">${ic('heart',19)}</button><button type="button" class="game-menu card-menu-float" data-action="game-actions" data-id="${esc(g.id)}" aria-label="${tr('Actions for {name}',{name:g.name})}" aria-haspopup="menu" aria-controls="game-actions-popup" aria-expanded="false">${ic('dots',19)}</button><button type="button" class="cover-play" data-action="launch" data-id="${esc(g.id)}" aria-label="${tr('Launch {name}',{name:g.name})}">${ic('play',17)}<span>${tr('Spelen')}</span></button><div class="game-label"><div><span class="game-name" title="${esc(g.name)}">${esc(g.name)}</span><span class="game-meta">${playing?tr('● Playing now'):g.play_status?`${esc(statusLabel(g.play_status))} · ${esc(timeLabel(g.total_play_seconds))}`:esc(timeLabel(g.total_play_seconds))}</span></div></div></div></article>`}
function rowGame(g){const selected=state.selectMode&&state.selectedGames.has(g.id);const st=statusLabel(g.play_status);return `<article class="game-row ${selected?'is-selected':''} ${g.hidden?'is-hidden-game':''}" data-id="${esc(g.id)}">${state.selectMode?`<label class="bulk-row-check" aria-label="${tr('Select {name}',{name:g.name})}"><input type="checkbox" data-select-game="${esc(g.id)}" ${selected?'checked':''}/></label>`:''}<button type="button" class="row-open-trigger" data-action="${state.selectMode?'toggle-select':'detail'}" data-id="${esc(g.id)}" aria-label="${tr(state.selectMode?'Select {name}':'View {name}',{name:g.name})}">
  <div class="row-cover">${esc(g.name.slice(0,1))}${!artwork(g.cover)&&artwork(g.icon)?`<img src="${artwork(g.icon)}" alt="" loading="lazy" decoding="async" class="list-game-icon" />`:''}${artwork(g.cover)?`<img src="${artwork(g.cover)}" data-fallback-icon="${artwork(g.icon)||''}" alt="" loading="lazy" decoding="async" />`:''}</div>
  <div class="row-info"><h3>${esc(g.name)}${g.hidden?` <span class="status-pill status-hidden">${tr('Hidden')}</span>`:''}${st?` <span class="status-pill status-${esc(g.play_status)}">${esc(st)}</span>`:''}</h3><p>${esc(sourceLabel(g))}${g.tags?.length?' · '+esc(g.tags.slice(0,2).join(', ')):''}</p></div></button>
  <div class="row-right"><span class="playtime">${esc(timeLabel(g.total_play_seconds))}</span><button type="button" class="ghost-btn" data-action="favorite" data-id="${esc(g.id)}" aria-label="${tr(g.favorite?'Remove favorite':'Add favorite')}" aria-pressed="${!!g.favorite}">${ic('heart',17)}</button><button type="button" class="ghost-btn row-menu-btn" data-action="game-actions" data-id="${esc(g.id)}" aria-label="${tr('Actions for {name}',{name:g.name})}" aria-haspopup="menu" aria-controls="game-actions-popup" aria-expanded="false">${ic('dots',17)}</button><button type="button" class="ghost-btn row-play" data-action="launch" data-id="${esc(g.id)}">${ic('play',15)} ${tr('Play')}</button></div></article>`}
function sidebarCollections(){
 if(!state.collections.length)return '';
 const visibleIds=new Set(state.games.filter(g=>state.showHidden||!g.hidden).map(g=>g.id));
 return `<div class="side-divider"></div><div class="side-label side-collections-head"><span>${tr('COLLECTIONS')}</span><button type="button" class="side-col-manage" data-action="manage-collections" title="${tr('Manage collections')}" aria-label="${tr('Manage collections')}">${ic('plus',14)}</button></div><nav class="nav side-collections-nav" aria-label="${tr('Custom collections')}">${state.collections.map(col=>{
  const count=(col.game_ids||[]).filter(id=>visibleIds.has(id)).length;
  const active=state.route==='library'&&state.collection===col.id;
  return `<button type="button" class="nav-item ${active?'active':''}" data-action="open-collection" data-id="${esc(col.id)}" title="${esc(col.name)}" ${active?'aria-current="page"':''}><span class="col-nav-icon" ${col.color?`style="color:${esc(col.color)}"`:''}>${ic(col.icon||'folder',16)}</span><span>${esc(col.name)}</span><span class="count">${formatNumber(count)}</span></button>`;
 }).join('')}</nav>`;
}
function sidebar(){const links=[['home','home','Overview'],['library','library','All games'],['favorites','heart','Favorites'],['recent','clock','Recently played'],['statistics','chart','Statistics']];const visibleCount=state.games.filter(g=>!g.hidden).length;return `<aside class="sidebar">
 <div class="brand" role="img" aria-label="Orbit Launcher"><img class="orbit-brand-mark" src="../../assets/branding/orbit-generated-mark.png" alt="" /><span class="orbit-brand-word" aria-hidden="true">orbit</span></div>
 <div class="side-label">${tr('LIBRARY')}</div><nav class="nav" aria-label="${tr('Main navigation')}">${links.map(([id,icon,name])=>`<button type="button" class="nav-item ${state.route===id&&!(id==='library'&&state.collection!=='all')?'active':''}" data-action="navigate" data-route="${id}" title="${tr(name)}" ${state.route===id&&!(id==='library'&&state.collection!=='all')?'aria-current="page"':''}>${ic(icon,18)}<span>${tr(name)}</span>${id==='library'?`<span class="count">${formatNumber(visibleCount)}</span>`:''}</button>`).join('')}</nav>
 ${sidebarCollections()}
 <div class="side-divider"></div><nav class="nav" aria-label="${tr('More')}"><button type="button" class="nav-item" data-action="whats-new" title="${tr('See what\'s new')}" aria-label="${tr('See what\'s new')}">${ic('info',18)}<span>${tr("What's new")}</span></button><button type="button" class="nav-item ${state.route==='settings'?'active':''}" data-action="navigate" data-route="settings" title="${tr('Settings')}" ${state.route==='settings'?'aria-current="page"':''}>${ic('settings',18)}<span>${tr('Settings')}</span></button></nav>
 <div class="nav side-discovery-slot" id="discovery-shortcut">${discoveryShortcut()}</div>
 <div class="side-bottom"><div class="side-update-slot" id="update-shortcut">${updateShortcut()}</div><div class="side-version"><span class="status-dot"></span><span>${tr(state.scanning?'Scanning your games…':'Local library')} <span class="version-number">v${esc(state.version)}</span></span></div></div></aside>`}
function topbar(){return `<header class="topbar"><div class="breadcrumb">${state.query.trim()?tr('Search results'):''}</div>
 <div class="topbar-right"><label class="searchbox" title="${tr('Operators: status:, source:, tag:, in:, time:, is:fav, is:hidden')}">${ic('search',18)}<input id="global-search" type="search" placeholder="${tr('Search your library')}" value="${esc(state.query)}" autocomplete="off" aria-label="${tr('Search games')}" title="${tr('Operators: status:, source:, tag:, in:, time:, is:fav, is:hidden')}"/><kbd>Ctrl K</kbd></label>
 <button type="button" class="top-icon" data-action="controller-mode" title="${tr('Controller mode (F11 / Menu)')}" aria-label="${tr('Enter controller mode')}">${ic('gamepad',18)}</button>${['library','favorites','recent'].includes(state.route)?'':`<button type="button" class="top-icon" data-action="scan" title="${tr('Discover installed games')}" aria-label="${tr('Discover installed games')}">${ic('refresh',18)}</button>`}
 <button type="button" class="secondary-btn topbar-add-btn" data-action="add">${ic('plus',18)}<span>${tr('Add game')}</span></button></div></header>`}
function headline(eyebrow,title,subtitle,buttons=''){return `<div class="page-heading"><div>${eyebrow?`<div class="eyebrow"><i></i>${esc(eyebrow)}</div>`:''}<h1 class="page-title">${esc(title)}</h1>${subtitle?`<p class="page-intro">${esc(subtitle)}</p>`:''}</div>${buttons}</div>`}
function platformFilters(){
 const visible=state.showHidden?state.games:state.games.filter(g=>!g.hidden);
 const scope=state.route==='favorites'?visible.filter(g=>g.favorite):state.route==='recent'?visible.filter(g=>g.last_played_at):visible;
 const counts=new Map();for(const game of scope)counts.set(game.source,(counts.get(game.source)||0)+1);
 return `<div class="platform-filters" role="group" aria-label="${tr('Filter by platform')}"><button type="button" class="platform-chip ${state.filter==='all'?'active':''}" data-action="platform" data-source="all" aria-pressed="${state.filter==='all'}">${tr('All games')} <span>${formatNumber(scope.length)}</span></button>${Object.entries(sourceNames).filter(([key])=>counts.has(key)).map(([key,label])=>`<button type="button" class="platform-chip ${state.filter===key?'active':''}" data-action="platform" data-source="${key}" aria-pressed="${state.filter===key}"><i class="source-dot source-${key}"></i>${tr(label)} <span>${formatNumber(counts.get(key))}</span></button>`).join('')}</div>`;
}
function activeFilterSummary(){
 const colName=state.collection!=='all'?state.collections.find(c=>c.id===state.collection)?.name:'';
 const statusText=state.status==='none'?t('No status'):state.status!=='all'?statusLabel(state.status):'';
 const playText=state.playtime!=='all'&&PLAYTIME_LABELS[state.playtime]?t(PLAYTIME_LABELS[state.playtime]):'';
 const active=[state.query.trim()&&`“${state.query.trim()}”`,state.filter!=='all'&&sourceLabel({source:state.filter}),statusText,colName,playText,state.genre!=='all'&&state.genre,state.tag!=='all'&&state.tag,state.showHidden&&t('Including hidden')].filter(Boolean);
 return active.length?`<span>${tr('Showing')} ${active.map(esc).join(' · ')}</span><button type="button" class="small-link" data-action="clear-filters">${tr('Clear filters')} ${ic('close',13)}</button>`:'';
}
function continueCard(g){return `<article class="continue-card cinematic-continue-card" data-id="${esc(g.id)}"><button type="button" class="continue-open-trigger" data-action="detail" data-id="${esc(g.id)}" aria-label="${tr('View details for {name}',{name:g.name})}"><div class="continue-art">${coverImage(g)}</div><div class="continue-copy"><strong>${esc(g.name)}</strong><span>${esc(timeLabel(g.total_play_seconds))}${g.last_played_at?` · ${esc(formatDate(g.last_played_at))}`:''}</span></div></button><button type="button" class="continue-play" data-action="launch" data-id="${esc(g.id)}" aria-label="${tr('Launch {name}',{name:g.name})}">${ic('play',16)}</button></article>`}
function home(){
 const visible=state.games.filter(g=>!g.hidden);
 const played=visible.filter(g=>g.last_played_at).sort((a,b)=>(Date.parse(b.last_played_at)||0)-(Date.parse(a.last_played_at)||0));
 const feature=played[0]||visible.find(g=>artwork(g.banner))||visible[0];
 const recent=played.slice(1,4);
 const banner=feature&&artwork(feature.banner);
 const featureCover=feature&&artwork(feature.cover);
 return `<section class="page home-page">${headline('',t('Overview'),'',visible.length?`<button type="button" class="secondary-btn shuffle-btn" data-action="shuffle">${ic('sparkles',16)} ${tr('Choose for me')}</button>`:'')}
 <div class="hero cinematic-hero ${banner?'has-banner':''} ${feature?'':'hero-empty'} ${featureCover?'has-feature-cover':''}">
 <div class="hero-ambient" aria-hidden="true"><span></span><span></span></div>
 ${banner?`<img class="hero-art" src="${banner}" alt="" loading="eager" decoding="async" fetchpriority="high" />`:''}
 ${feature?`<div class="hero-portrait" aria-hidden="true"><div class="cover cinematic-hero-poster">${coverImage(feature,!banner)}</div></div>`:''}
 <div class="hero-shade"></div><div class="hero-content"><div class="hero-eyebrow-row"><span class="hero-eyebrow">${tr(feature?(played.length?'CONTINUE PLAYING':'YOUR LIBRARY'):'WELCOME TO ORBIT')}</span>${feature?`<span class="hero-caption">${ic('gamepad',14)} ${tr('IN YOUR COLLECTION')}</span>`:''}</div>
 <h2>${feature?esc(feature.name):tr('Add your first game')}</h2>
 ${feature?`<div class="hero-metadata"><span>${esc(sourceLabel(feature))}</span>${feature.genre?`<i></i><span>${esc(feature.genre)}</span>`:''}<i></i><span>${esc(timeLabel(feature.total_play_seconds))}</span></div><p>${played.length?tr('Last played {date}.',{date:formatDate(feature.last_played_at)}):''}</p>`:`<p>${tr('Bring your installed games together in a library that feels like yours. Start with your launchers or a folder you choose.')}</p>`}
 <div class="hero-buttons cinematic-hero-actions">${feature?`<button type="button" class="primary-btn" data-action="launch" data-id="${esc(feature.id)}">${ic('play',16)} ${tr('Play now')}</button><button type="button" class="secondary-btn hero-detail" data-action="detail" data-id="${esc(feature.id)}">${tr('Game details')} ${ic('arrow',16)}</button>`:`<button type="button" class="primary-btn" data-action="scan">${ic('refresh',16)} ${tr('Find my games')}</button><button type="button" class="secondary-btn" data-action="add">${ic('plus',16)} ${tr('Add a game')}</button>`}</div></div>
 <div class="hero-frame" aria-hidden="true"></div></div>
 ${visible.length?`<div class="collection-summary"><span><strong>${formatNumber(visible.length)}</strong> ${tr(visible.length===1?'game in your library':'games in your library')}</span><span><strong>${formatNumber(visible.filter(g=>g.favorite).length)}</strong> ${tr('favorites')}</span><span><strong>${tr('{hours}h',{hours:totalHours()})}</strong> ${tr('tracked play time')}</span></div>
 ${recent.length?`<div class="subheading"><h2>${tr('Continue playing')}</h2><button type="button" class="small-link" data-action="navigate" data-route="recent">${tr('Recently played')} ${ic('arrow',14)}</button></div><div class="continue-grid">${recent.map(continueCard).join('')}</div>`:''}
 <div class="subheading collection-heading"><div><h2>${tr('Your collection')}</h2></div><button type="button" class="small-link" data-action="navigate" data-route="library">${tr('View all {count}',{count:formatNumber(visible.length)})} ${ic('arrow',14)}</button></div>
 <div id="platform-filter-slot">${platformFilters()}</div>
 <div id="active-filters" class="active-filters">${activeFilterSummary()}</div>
 <div id="virtual-games"></div>`:''}</section>`;
}
const nonnegativeSeconds=value=>Number.isFinite(value)&&value>=0?Math.floor(value):0;
function statisticsTime(value){const seconds=nonnegativeSeconds(value),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60);return seconds>0&&minutes===0?t('Less than 1 minute'):hours?t('{hours}h {minutes}m',{hours:formatNumber(hours),minutes:formatNumber(minutes%60)}):t('{minutes}m',{minutes:formatNumber(minutes)});}
function statisticsDate(date){
 if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return t('Unknown date');
 const parsed=new Date(`${date}T12:00:00`);
 return Number.isNaN(parsed.getTime())?t('Unknown date'):(window.OrbitI18n?.formatDate?.(parsed,{month:'short',day:'numeric'})??new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric'}).format(parsed));
}
function statisticsContent(){
 const stats=state.statistics;
 if(stats.status==='loading')return `<div class="statistics-state" role="status"><span class="statistics-state-icon">${ic('refresh',22)}</span> <h2 class="statistics-state-title">${tr('Reading your play sessions…')}</h2><p class="statistics-state-description">${tr('Calculating the past 30 local calendar days.')}</p></div>`;
 if(stats.status==='error')return `<div class="statistics-state" role="status"><span class="statistics-state-icon">${ic('info',24)}</span> <h2 class="statistics-state-title">${tr('Statistics unavailable')}</h2><p class="statistics-state-description">${tr(stats.error||'Could not retrieve session history.')}</p><p class="statistics-state-description">${tr('Library and play controls are still available.')}</p></div>`;
 if(stats.status!=='ready'||!stats.data)return `<div class="statistics-state" role="status"><p class="statistics-state-description">${tr('Open statistics to load your recorded sessions.')}</p></div>`;
 const result=stats.data,totals=result.totals||{},meta=result.meta||{};
 const daily=Array.isArray(result.daily)?result.daily.filter(day=>typeof day?.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day.date)).slice(-30):[];
 const hasDailyTime=daily.some(day=>nonnegativeSeconds(day.seconds)>0);
 const peak=Math.max(1,...daily.map(day=>nonnegativeSeconds(day.seconds)));
 const today=daily.length?daily[daily.length-1].seconds:0;
 const from=daily.length?statisticsDate(daily[0].date):t('Unknown');
 const to=daily.length?statisticsDate(daily[daily.length-1].date):t('Unknown');
 const summary=[['Today',today,'Recorded today'],['Last 7 days',totals.week,'Rolling 7 local days'],['Last 30 days',totals.month,'Rolling 30 local days'],['All recorded time',totals.allTime,'Finished sessions only']];
 const rows=Array.isArray(result.recentGames)?result.recentGames.slice(0,8):[];
 const best=daily.reduce((winner,day)=>nonnegativeSeconds(day.seconds)>nonnegativeSeconds(winner?.seconds)?day:winner,null);
 const lastSeven=daily.slice(-7).reduce((total,day)=>total+nonnegativeSeconds(day.seconds),0);
 const previousSeven=daily.slice(-14,-7).reduce((total,day)=>total+nonnegativeSeconds(day.seconds),0);
 const trend=daily.length>=14?(lastSeven>previousSeven?t('{time} more than the previous 7 days',{time:statisticsTime(lastSeven-previousSeven)}):lastSeven<previousSeven?t('{time} less than the previous 7 days',{time:statisticsTime(previousSeven-lastSeven)}):t('Same recorded time as the previous 7 days')):t('Needs at least 14 dated entries');
 const note=nonnegativeSeconds(meta.overlapSeconds)>0?t('Overlapping same-game session time excluded from charts: {time}. ',{time:statisticsTime(meta.overlapSeconds)}):'';
 const adjusted=nonnegativeSeconds(meta.adjustedSeconds)>0?t('Inconsistent session durations adjusted by {time}. ',{time:statisticsTime(meta.adjustedSeconds)}):'';
 const integrity=nonnegativeSeconds(meta.invalidSessions)>0||meta.truncated?t('Some session records were excluded or the available history was limited. '):'';
 const inProgress=nonnegativeSeconds(meta.openSessions)>0?t('{count} in-progress session(s) excluded until completed. ',{count:formatNumber(meta.openSessions)}):'';
 return `<div class="statistics-loaded"><div class="statistics-metrics">${summary.map(([label,value,caption],index)=>`<article class="statistics-metric ${index===1?'featured':''}"><span class="statistics-metric-label">${tr(label)}</span><strong class="statistics-metric-value">${esc(statisticsTime(value))}</strong><small class="statistics-metric-caption">${tr(caption)}</small></article>`).join('')}</div>
  <div class="statistics-insights"><div class="statistics-insight"><span class="statistics-insight-icon">${ic('trophy',19)}</span> <div class="statistics-insight-body"><span class="statistics-insight-label">${tr('Best day · last 30 days')}</span><strong class="statistics-insight-value">${best&&nonnegativeSeconds(best.seconds)?esc(statisticsTime(best.seconds)):tr('No recorded playtime')} </strong><small class="statistics-insight-caption">${best&&nonnegativeSeconds(best.seconds)?esc(statisticsDate(best.date)):tr('No daily record yet')}</small></div></div><div class="statistics-insight"><span class="statistics-insight-icon">${ic('chart',19)}</span> <div class="statistics-insight-body"><span class="statistics-insight-label">${tr('7-day trend')}</span><strong class="statistics-insight-value">${esc(statisticsTime(lastSeven))} ${tr('this week')}</strong><small class="statistics-insight-caption">${esc(trend)}</small></div></div></div>
  <section class="statistics-panel" aria-labelledby="statistics-chart-title"><div class="statistics-panel-head"><div><span class="statistics-kicker">${tr('PLAYTIME HISTORY')}</span><h2 class="statistics-panel-title" id="statistics-chart-title">${tr('Your last 30 days')}</h2><p class="statistics-panel-subtitle">${esc(from)} – ${esc(to)} · ${tr('local calendar dates')}</p></div><span class="statistics-legend"><i></i> ${tr('Recorded play time')}</span></div>
   ${hasDailyTime?`<div class="statistics-graph" role="img" aria-label="${tr('Recorded daily playtime from {from} to {to}',{from,to})}"><div class="statistics-bars">${daily.map(day=>`<span class="statistics-bar-slot" title="${esc(statisticsDate(day.date))}: ${esc(statisticsTime(day.seconds))}"><span class="statistics-bar ${nonnegativeSeconds(day.seconds)?'has-time':''}" style="height:${Math.max(3,Math.round(nonnegativeSeconds(day.seconds)/peak*100))}%"></span></span>`).join('')}</div><div class="statistics-axis"><span>${esc(from)}</span><span>${esc(to)}</span></div></div><ul class="statistics-visually-hidden" aria-label="${tr('Daily recorded playtime')}">${daily.map(day=>`<li>${esc(day.date)}: ${esc(statisticsTime(day.seconds))}</li>`).join('')}</ul>`:`<p class="statistics-empty">${tr(daily.length?'No recorded playtime':'No dated sessions are available for this period.')}</p>`}
  </section>
  <section class="statistics-panel" aria-labelledby="statistics-recent-title"><div class="statistics-panel-head"><div><span class="statistics-kicker">${tr('SESSION RECORDS')}</span><h2 class="statistics-panel-title" id="statistics-recent-title">${tr('Recently played games')}</h2><p class="statistics-panel-subtitle">${tr('Latest games with completed sessions')}</p></div></div>
   ${rows.length?`<div class="statistics-recent-list">${rows.map(game=>{const art=artwork(game.cover)||artwork(game.icon);return `<div class="statistics-recent-row">${art?`<img src="${art}" loading="lazy" decoding="async" alt="" />`:`<div class="statistics-recent-placeholder" aria-hidden="true">${ic('gamepad',18)}</div>`}<div class="statistics-recent-name"><strong class="statistics-recent-title">${esc(game.name||t('Unknown game'))}</strong><span class="statistics-recent-source">${tr(sourceNames[game.source]||'Recorded game')} · ${esc(formatDate(game.lastPlayedAt))}</span></div><span class="statistics-recent-duration">${esc(statisticsTime(game.seconds))}</span></div>`}).join('')}</div>`:`<p class="statistics-empty">${tr('No completed game sessions have been recorded yet.')}</p>`}
  </section>
  <p class="statistics-disclaimer"><span class="statistics-info-icon">${ic('info',15)}</span> ${tr('Based on recorded sessions.')} ${esc(note+adjusted+integrity+inProgress)}${tr('Older records may include duplicates or incomplete tracking, and these figures can differ from game library lifetime totals.')}</p>
 </div>`;
}
function statisticsView(){return `<section class="page statistics-page">${headline(t('ACTIVITY OVERVIEW'),t('Gaming statistics'),t('See how your time is recorded across games. Data stays on your device.'),`<button class="secondary-btn" data-action="refresh-statistics" ${state.statistics.status==='loading'?'disabled aria-busy="true"':''}>${ic('refresh',16)} ${tr('Refresh')}</button>`)}
  <div id="statistics-content" aria-live="polite" aria-atomic="false">${statisticsContent()}</div></section>`;}
function refreshStatisticsContent(){
 if(state.route!=='statistics')return;
 const content=el('statistics-content');if(content)content.innerHTML=statisticsContent();
 const refresh=document.querySelector('[data-action="refresh-statistics"]');
 if(refresh){refresh.disabled=state.statistics.status==='loading';refresh.setAttribute('aria-busy',String(state.statistics.status==='loading'));}
}
let statisticsRequestId=0;
async function loadStatistics(){
 const request=++statisticsRequestId;
 state.statistics={status:'loading',data:null,error:''};refreshStatisticsContent();
 if(typeof window.orbit?.getStatistics!=='function'){
  state.statistics={status:'error',data:null,error:t('Update Orbit to a version that supports recorded-session statistics.')};
  refreshStatisticsContent();return;
 }
 try{
  const result=await window.orbit.getStatistics({days:30});
  if(request!==statisticsRequestId)return;
  if(!result||typeof result!=='object'||!result.totals||!Array.isArray(result.daily)||!Array.isArray(result.recentGames))throw Error(t('The statistics response was incomplete.'));
  state.statistics={status:'ready',data:result,error:''};
 }catch(error){
  if(request!==statisticsRequestId)return;
  state.statistics={status:'error',data:null,error:error?.message||t('Could not retrieve recorded sessions.')};
 }
 refreshStatisticsContent();
}
function emptyState(title,body,extra=''){return `<div class="empty-state"><div class="empty-illustration">${ic('gamepad',47)}</div><h2>${esc(title)}</h2><p>${esc(body)}</p><div class="empty-actions">${extra||`<button class="primary-btn" data-action="scan">${ic('refresh',16)} ${tr('Discover games')}</button><button class="secondary-btn" data-action="add">${ic('plus',16)} ${tr('Add game')}</button>`}</div></div>`}
function bulkActionDock(){
 if(!state.selectMode)return '';
 const count=state.selectedGames.size;
 const selectedList=[...state.selectedGames].map(id=>state.games.find(g=>g.id===id)).filter(Boolean);
 const allHidden=selectedList.length>0&&selectedList.every(g=>g.hidden);
 const allFav=selectedList.length>0&&selectedList.every(g=>g.favorite);
 return `<div id="bulk-action-dock" class="bulk-dock" role="region" aria-label="${tr('Bulk library actions')}">
  <div class="bulk-dock-meta"><strong>${tr('{count} selected',{count:formatNumber(count)})}</strong>
   <button type="button" class="small-link" data-action="bulk-select-all">${tr('Select all')}</button>
   ${count?`<button type="button" class="small-link" data-action="bulk-clear">${tr('Clear')}</button>`:''}
  </div>
  <div class="bulk-dock-actions">
   <div class="select-wrap bulk-status-wrap"><select id="bulk-status-select" aria-label="${tr('Set status for selected games')}" ${count?'':'disabled'}><option value="">${tr('Set status…')}</option>${PLAY_STATUSES.map(([code,label])=>`<option value="${code}">${tr(label)}</option>`).join('')}<option value="__clear__">${tr('Clear status')}</option></select></div>
   <button type="button" class="secondary-btn" data-action="bulk-favorite" data-favorite="${allFav?'false':'true'}" ${count?'':'disabled'}>${ic('heart',15)} ${tr(allFav?'Unfavorite':'Favorite')}</button>
   <button type="button" class="secondary-btn" data-action="bulk-collections" ${count?'':'disabled'}>${ic('folder',15)} ${tr('Collections')}</button>
   <button type="button" class="secondary-btn" data-action="bulk-tags" ${count?'':'disabled'}>${ic('sparkles',15)} ${tr('Tags')}</button>
   <button type="button" class="secondary-btn" data-action="bulk-hide" data-hidden="${allHidden?'false':'true'}" ${count?'':'disabled'}>${ic(allHidden?'check':'close',15)} ${tr(allHidden?'Unhide':'Hide')}</button>
   <button type="button" class="danger-btn" data-action="bulk-remove-confirm" ${count?'':'disabled'}>${ic('trash',15)} ${tr('Remove')}</button>
   <button type="button" class="ghost-btn" data-action="toggle-select-mode" aria-label="${tr('Exit selection mode')}">${ic('close',16)}</button>
  </div></div>`;
}
function extraFilterCount(){
 return [state.playtime!=='all',state.collection!=='all',state.genre!=='all',state.tag!=='all',state.showHidden].filter(Boolean).length;
}
function libraryFiltersPopover(genres,tags){
 const hiddenCount=state.games.filter(g=>g.hidden).length;
 const activeExtra=extraFilterCount();
 return `<details id="filters-popover" class="filters-popover ${activeExtra?'has-active':''}"><summary class="filters-popover-summary" aria-label="${tr('More filters')}">${ic('sort',14)} <span>${tr('Filters')}</span><span id="filters-popover-badge" class="filters-badge" ${activeExtra?'':'hidden'}>${activeExtra?formatNumber(activeExtra):''}</span></summary>
  <div class="filters-popover-panel">
   <div class="filters-popover-field"><label for="playtime-filter">${tr('Play time')}</label><div class="select-wrap"><select id="playtime-filter" aria-label="${tr('Filter by playtime')}"><option value="all" ${state.playtime==='all'?'selected':''}>${tr('Any playtime')}</option>${PLAYTIME_FILTERS.map(([code,label])=>`<option value="${code}" ${state.playtime===code?'selected':''}>${tr(label)}</option>`).join('')}</select></div></div>
   <div class="filters-popover-field" id="collection-filter-field" ${state.collections.length?'':'hidden'}><label for="collection-filter">${tr('Collections')}</label><div class="select-wrap"><select id="collection-filter" aria-label="${tr('Filter by collection')}"><option value="all" ${state.collection==='all'?'selected':''}>${tr('All collections')}</option>${state.collections.map(c=>`<option value="${esc(c.id)}" ${state.collection===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div></div>
   <div class="filters-popover-field"><label for="genre-filter">${tr('Genre')}</label><div class="select-wrap"><select id="genre-filter" aria-label="${tr('Filter by genre')}"><option value="all" ${state.genre==='all'?'selected':''}>${tr('All genres')}</option>${genres.map(g=>`<option value="${esc(g)}" ${state.genre===g?'selected':''}>${esc(g)}</option>`).join('')}</select></div></div>
   <div class="filters-popover-field"><label for="tag-filter">${tr('Tags')}</label><div class="select-wrap"><select id="tag-filter" aria-label="${tr('Filter by tag')}"><option value="all" ${state.tag==='all'?'selected':''}>${tr('All tags')}</option>${tags.map(tag=>`<option value="${esc(tag)}" ${state.tag===tag?'selected':''}>${esc(tag)}</option>`).join('')}</select></div></div>
   <div class="filters-popover-footer" id="filters-popover-footer" ${(hiddenCount||state.showHidden||activeExtra)?'':'hidden'}>
    ${hiddenCount||state.showHidden?`<button type="button" class="platform-chip ${state.showHidden?'active':''}" data-action="toggle-hidden-filter" aria-pressed="${state.showHidden}">${tr('Hidden')} <span>${formatNumber(hiddenCount)}</span></button>`:'<span></span>'}
    ${activeExtra?`<button type="button" class="small-link" data-action="clear-filters">${tr('Clear filters')}</button>`:''}
   </div>
  </div></details>`;
}
function libraryView(){const subtitle={library:'',favorites:'',recent:''};const activeCol=state.route==='library'&&state.collection!=='all'?state.collections.find(c=>c.id===state.collection):null;const title={library:activeCol?activeCol.name:t('Your game library'),favorites:t('Your favorites'),recent:t('Recently played')};const tags=[...new Set(state.games.flatMap(g=>g.tags||[]))].sort((a,b)=>a.localeCompare(b)).slice(0,100);const genres=[...new Set(state.games.map(g=>g.genre).filter(Boolean))].sort((a,b)=>a.localeCompare(b)).slice(0,100);const initialCount=filtered().length;
 return `<section class="page library-page ${state.selectMode?'in-select-mode':''}">${headline('',title[state.route],subtitle[state.route],`<button class="secondary-btn" data-action="scan">${ic('refresh',15)} ${tr('Scan for games')}</button>`)}
 <div class="library-bar-top"><div id="platform-filter-slot">${platformFilters()}</div><div class="library-facets-actions"><button type="button" class="secondary-btn facet-btn" data-action="manage-collections">${ic('folder',15)} ${tr('Collections')}</button><button type="button" class="secondary-btn facet-btn ${state.selectMode?'is-active':''}" data-action="toggle-select-mode" aria-pressed="${state.selectMode}">${ic('check',15)} ${tr(state.selectMode?'Done selecting':'Select')}</button></div></div>
 <div class="library-controls"><div class="control-left"><span class="library-count" id="game-result-count">${formatNumber(initialCount)} ${tr(initialCount===1?'game':'games')}</span>
 <div class="select-wrap"><select id="status-filter" aria-label="${tr('Filter by status')}"><option value="all" ${state.status==='all'?'selected':''}>${tr('All statuses')}</option>${PLAY_STATUSES.map(([code,label])=>`<option value="${code}" ${state.status===code?'selected':''}>${tr(label)}</option>`).join('')}<option value="none" ${state.status==='none'?'selected':''}>${tr('No status')}</option></select></div>
 ${libraryFiltersPopover(genres,tags)}</div>
 <div class="control-right"><div class="select-wrap"><select id="sort-by" aria-label="${tr('Sort games')}"><option value="name" ${state.sort==='name'?'selected':''}>${tr('Name A–Z')}</option><option value="recent" ${state.sort==='recent'?'selected':''}>${tr('Recently played')}</option><option value="added" ${state.sort==='added'?'selected':''}>${tr('Recently added')}</option><option value="time" ${state.sort==='time'?'selected':''}>${tr('Play time')}</option></select></div>
 <div class="view-switch" aria-label="${tr('Library display')}"><button data-action="view" data-view="grid" class="${state.view==='grid'?'selected':''}" aria-label="${tr('Grid view')}" aria-pressed="${state.view==='grid'}">${ic('grid',16)}</button><button data-action="view" data-view="list" class="${state.view==='list'?'selected':''}" aria-label="${tr('List view')}" aria-pressed="${state.view==='list'}">${ic('list',16)}</button></div></div></div>
 <div id="active-filters" class="active-filters" aria-live="polite">${activeFilterSummary()}</div><div id="library-area" class="virtual-area">${state.games.length?'<div id="virtual-games"></div>':emptyState(t(state.route==='favorites'?'No favorites yet':state.route==='recent'?'No games played yet':'No games yet'),t(state.route==='favorites'?'Mark games with the heart icon to see them here.':state.route==='recent'?'Launch a game and it will appear here.':'Scan your installed launchers or add a game manually.'))}</div><div id="bulk-dock-slot">${bulkActionDock()}</div></section>`;
}
let virtualRangeKey=null,virtualGamesRef=null,virtualRunningRef=null,virtualItems=new Map();
function captureGameFocus(host){
 const active=document.activeElement;
 if(!active||!host?.contains(active))return null;
 const item=active.closest('.game-card,.game-row,.continue-card');
 if(!item)return null;
 const isOpenTrigger=active.classList.contains('card-open-trigger')||active.classList.contains('row-open-trigger')||active.classList.contains('continue-open-trigger');
 return {id:item.dataset.id,action:active.dataset.action,openTrigger:isOpenTrigger,index:[...item.parentElement.children].indexOf(item)};
}
function restoreGameFocus(host,focus){
 if(!focus||!host)return;
 const items=[...host.querySelectorAll('.game-card,.game-row,.continue-card')];
 const item=items.find(node=>node.dataset.id===focus.id)||items[Math.min(focus.index,items.length-1)];
 const target=item?(focus.openTrigger?item.querySelector('.card-open-trigger,.row-open-trigger,.continue-open-trigger'):[...item.querySelectorAll('[data-action]')].find(node=>node.dataset.action===focus.action))||item.querySelector('.card-open-trigger,.row-open-trigger,.continue-open-trigger,button'):host.querySelector('button');
 if(target&&document.activeElement!==target)target.focus({preventScroll:true});
}
function renderVirtual(){
 if(gameActionsTrigger&&!gameActionsTrigger.isConnected)closeGameActions();
 const host=el('virtual-games');if(!host)return;
 const games=filtered();state.viewGames=games;
 const count=el('game-result-count'),label=`${formatNumber(games.length)} ${t(games.length===1?'game':'games')}`;
 if(count&&count.textContent!==label)count.textContent=label;
 const summary=el('active-filters'),filterSummary=activeFilterSummary();if(summary&&summary.innerHTML!==filterSummary)summary.innerHTML=filterSummary;
 const focus=captureGameFocus(host);
 if(!games.length){
  if(virtualRangeKey==='empty'&&virtualGamesRef===games)return;
  virtualRangeKey='empty';virtualGamesRef=games;virtualItems=new Map();
  host.innerHTML=emptyState(t(state.query?'No matching games':state.route==='favorites'?'No favorites yet':state.route==='recent'?'No games played yet':'Nothing here yet'),t(state.query?'Try another search or clear filters.':state.route==='favorites'?'Mark games with the heart icon to see them here.':state.route==='recent'?'Launch a game and it will appear here.':'Try changing the platform or tag filters.'),(state.query||state.filter!=='all'||state.status!=='all'||state.collection!=='all'||state.playtime!=='all'||state.showHidden||state.tag!=='all'||state.genre!=='all')?`<button class="secondary-btn" data-action="clear-filters">${tr('Clear filters')}</button>`:`<button class="secondary-btn" data-action="navigate" data-route="library">${tr('Browse library')} ${ic('arrow',15)}</button>`);
  restoreGameFocus(host,focus);return;
 }
 const scroll=el('main-scroll');if(!scroll)return;
 const view=state.route==='home'?'grid':state.view;
 const isGrid=view==='grid',layout=getComputedStyle(host);
 const gap=parseFloat(layout.getPropertyValue(isGrid?'--grid-gap':'--list-gap'))||0;
 const minimum=parseFloat(layout.getPropertyValue('--card-min'));
 const cols=isGrid?Math.max(1,Math.floor((host.clientWidth+gap)/(minimum+gap))):1;
 const width=(host.clientWidth-gap*(cols-1))/cols;
 // Chromium lays out grid tracks at 1/64 CSS-pixel precision. Use the same
 // quantization for spacers so fractional cover widths cannot accumulate drift.
 const rowHeight=Math.floor((isGrid?width*1.5+parseFloat(layout.getPropertyValue('--card-label-height'))+gap:parseFloat(layout.getPropertyValue('--list-row-height'))+gap)*64)/64;
 const listTop=host.getBoundingClientRect().top-scroll.getBoundingClientRect().top+scroll.scrollTop;
 const totalRows=Math.ceil(games.length/cols),visible=Math.ceil(scroll.clientHeight/rowHeight)+7;
 let first=Math.min(Math.max(0,totalRows-visible),Math.max(0,Math.floor(Math.max(0,scroll.scrollTop-listTop)/rowHeight)-3));
 let extra=0;
 // Chromium serializes CSS lengths using 6 significant digits (%.6g), which can round
 // fractional/large spacer heights by up to 0.5px. Pick a nearby row start with minimal drift.
 while(first>0&&extra<8&&Math.abs(Number((first*rowHeight).toPrecision(6))-first*rowHeight)>rowHeight*0.001){first-=1;extra+=1;}
 const last=Math.min(totalRows,first+visible+extra),key=`${view}:${cols}:${rowHeight}:${first}:${last}:${state.selectMode?1:0}`;
 if(virtualGamesRef===games&&virtualRangeKey===key&&virtualRunningRef===state.runningIds&&!state.selectMode)return;
 virtualGamesRef=games;virtualRangeKey=key;virtualRunningRef=state.runningIds;
 let container=host.querySelector('[data-virtual-items]');
 if(!container||container.dataset.view!==view){
  host.innerHTML='<div data-virtual-before></div><div data-virtual-items></div><div data-virtual-after></div>';
  container=host.querySelector('[data-virtual-items]');container.dataset.view=view;virtualItems=new Map();
 }
 container.className=isGrid?(state.route==='home'?'games-grid home-games':'games-grid'):'game-list';
 container.style.gridTemplateColumns=isGrid?`repeat(${cols},minmax(0,1fr))`:'';
 container.style.gridAutoRows=isGrid?`${rowHeight-gap}px`:'';
 host.firstElementChild.style.height=`${first*rowHeight}px`;
 host.lastElementChild.style.height=`${Math.max(0,(totalRows-last)*rowHeight)}px`;
 const slice=games.slice(first*cols,last*cols),nextItems=new Map(),running=new Set(state.runningIds);
 for(let index=0;index<slice.length;index++){
  const game=slice[index],playing=running.has(game.id),selected=state.selectMode&&state.selectedGames.has(game.id),previous=virtualItems.get(game.id);
  let node=previous?.node;
  if(!node||previous.game!==game||previous.playing!==playing||previous.selected!==selected||previous.selectMode!==state.selectMode){
   const template=document.createElement('template');template.innerHTML=(isGrid?card:rowGame)(game);
   const replacement=template.content.firstElementChild;
   if(node?.parentElement===container)node.replaceWith(replacement);
   node=replacement;
  }
  if(container.children[index]!==node)container.insertBefore(node,container.children[index]||null);
  nextItems.set(game.id,{node,game,playing,selected,selectMode:state.selectMode});
 }
 for(const node of [...container.children])if(!nextItems.has(node.dataset.id))node.remove();
 virtualItems=nextItems;syncActivity();restoreGameFocus(host,focus);
}
function settingsView(){const s=state.settings,folders=s.libraryFolders||[];return `<section class="page">${headline('',t('Settings'),'')}
 <div class="settings-layout"><div class="settings-stack">
 <div class="settings-card"><h2>${tr('Appearance')}</h2>
 <div class="setting-row"><div><div class="setting-name">${tr('Language')}</div><div class="setting-help">${tr('Choose the language used throughout Orbit.')}</div></div><div class="select-wrap setting-control"><select id="language-select" aria-label="${tr('Language')}">${[['system',t('System (automatic)')],['en','English'],['nl','Nederlands'],['de','Deutsch'],['fr','Français'],['es','Español']].map(([code,label])=>`<option value="${code}" ${(s.language||'system')===code?'selected':''}>${esc(label)}</option>`).join('')}</select></div></div>
 <div class="setting-row"><div><div class="setting-name">${tr('Theme')}</div><div class="setting-help">${tr('Choose a color mode for the launcher.')}</div></div><div class="select-wrap setting-control"><select id="theme-select" aria-label="${tr('Theme')}"><option value="dark" ${s.theme==='dark'?'selected':''}>${tr('Dark')}</option><option value="light" ${s.theme==='light'?'selected':''}>${tr('Light')}</option><option value="system" ${s.theme==='system'?'selected':''}>${tr('System')}</option></select></div></div>
 <div class="setting-row"><div><div class="setting-name">${tr('Accent color')}</div></div><div class="accent-swatches setting-control">${palette.map(c=>`<button class="swatch ${s.accent.toLowerCase()===c?'chosen':''}" style="--sw:${c}" data-action="accent" data-color="${c}" aria-label="${tr('Set accent color {color}',{color:c})}"></button>`).join('')}</div></div>
 <div class="setting-row"><div><div class="setting-name">${tr('Reduce motion')}</div><div class="setting-help">${tr('Limit animation and transitions.')}</div></div><button class="switch ${s.reduceMotion?'on':''}" data-action="setting-toggle" data-key="reduceMotion" role="switch" aria-checked="${s.reduceMotion}" aria-label="${tr('Reduce motion')}"></button></div>
 <div class="setting-row"><div><div class="setting-name">${tr('Library density')}</div><div class="setting-help">${tr('Choose comfortable or compact game cards.')}</div></div><div class="select-wrap setting-control"><select id="density-select" aria-label="${tr('Library density')}"><option value="comfortable" ${s.libraryDensity!=='compact'?'selected':''}>${tr('Comfortable')}</option><option value="compact" ${s.libraryDensity==='compact'?'selected':''}>${tr('Compact')}</option></select></div></div></div>
 <div class="settings-card"><h2>${tr('Performance & updates')}</h2><p>${tr('Keep game performance first. Orbit remains available in the tray for playtime tracking.')}</p>
 <div class="setting-row"><div><div class="setting-name">${tr('Performance Guard')}</div><div class="setting-help">${tr("Hide Orbit's window after a confirmed game start on Windows, keeping your edits open.")}</div></div><button class="switch ${s.performanceGuard?'on':''}" data-action="setting-toggle" data-key="performanceGuard" role="switch" aria-checked="${!!s.performanceGuard}" aria-label="${tr('Performance Guard')}"></button></div>
 <div class="setting-row"><div><div class="setting-name">${tr('Automatic updates')}</div><div class="setting-help">${tr('Check and download signed Orbit updates in the background.')}</div></div><button type="button" class="switch ${s.autoUpdates?'on':''}" data-action="setting-toggle" data-key="autoUpdates" role="switch" aria-checked="${!!s.autoUpdates}" aria-label="${tr('Automatic updates')}" ${!state.updateStatus||state.updateStatus.state==='unsupported'?'disabled aria-disabled="true"':''}></button></div>
 <div class="setting-row update-panel-row"><div class="update-panel-info"><div class="update-panel-head"><span id="update-state-dot" class="${updateDotClass(state.updateStatus)}" aria-hidden="true"></span><span class="setting-name">${tr('Update status')}</span>${state.version?`<span class="update-version-chip">v${esc(state.version)}</span>`:''}</div><div class="setting-help" id="update-status" role="status" aria-live="polite">${esc(formatUpdateStatus(state.updateStatus))}</div><div id="update-progress-slot">${updateProgressMarkup(state.updateStatus)}</div></div><div class="setting-control update-panel-actions" id="update-action-slot">${updateActionButtons(state.updateStatus)}</div></div>
 <div class="setting-row"><div><div class="setting-name">${tr("What's new")}</div><div class="setting-help">${tr('Release highlights appear once per version and can be reopened in Settings.')}</div></div><button class="secondary-btn" data-action="whats-new">${ic('sparkles',15)} ${tr("See what's new")}</button></div></div>
 <div class="settings-card"><h2>${tr('Controller mode')}</h2><p>${tr('Customize your couch and handheld controller experience.')}</p>
 <div class="setting-row"><div><div class="setting-name">${tr('Auto-enter with controller')}</div><div class="setting-help">${tr('Start directly in Controller Mode when a standard gamepad is connected.')}</div></div><button type="button" class="switch ${s.controllerAutoEnter?'on':''}" data-action="setting-toggle" data-key="controllerAutoEnter" role="switch" aria-checked="${!!s.controllerAutoEnter}" aria-label="${tr('Auto-enter with controller')}"></button></div>
 <div class="setting-row"><div><div class="setting-name">${tr('Navigation sounds')}</div><div class="setting-help">${tr('Play subtle audio cues in Controller Mode. Muted automatically while a game is running.')}</div></div><button type="button" class="switch ${s.controllerAudio?'on':''}" data-action="setting-toggle" data-key="controllerAudio" role="switch" aria-checked="${!!s.controllerAudio}" aria-label="${tr('Navigation sounds')}"></button></div>
 <div class="setting-row"><div><div class="setting-name">${tr('Launch vibration')}</div><div class="setting-help">${tr('Send a short haptic pulse to the active gamepad when launching a game.')}</div></div><button type="button" class="switch ${s.controllerHaptics?'on':''}" data-action="setting-toggle" data-key="controllerHaptics" role="switch" aria-checked="${!!s.controllerHaptics}" aria-label="${tr('Launch vibration')}"></button></div></div>
 <div class="settings-card"><h2>${tr('Library discovery')}</h2><p>${tr('Orbit searches installed game stores and folders you select. Downloads is never scanned automatically.')}</p>
 <div class="setting-row"><div><div class="setting-name">${tr('Scan at startup')}</div><div class="setting-help">${tr('Look for new games whenever Orbit starts.')}</div></div><button class="switch ${s.autoScan?'on':''}" data-action="setting-toggle" data-key="autoScan" role="switch" aria-checked="${s.autoScan}" aria-label="${tr('Scan at startup')}"></button></div>
 <div class="setting-row"><div><div class="setting-name">${tr('Online artwork')}</div><div class="setting-help">${tr('Find covers using Steam and Epic Games when online.')}</div></div><button class="switch ${s.useSteamArtwork?'on':''}" data-action="setting-toggle" data-key="useSteamArtwork" role="switch" aria-checked="${s.useSteamArtwork}" aria-label="${tr('Online artwork downloads')}"></button></div>
 <div class="setting-row"><div><div class="setting-name">${tr('Missing or incorrect covers')}</div><div class="setting-help">${tr('Find portrait artwork, and use installed game EXE icons when no cover is available. Valid portrait covers are preserved.')}</div></div><button class="secondary-btn" data-action="repair-artwork">${ic('refresh',14)} ${tr('Repair library covers')}</button></div>
 <div class="setting-row"><div><div class="setting-name">${tr('Custom library locations')}</div><div class="setting-help">${tr('Optional folders to scan for game executables and GOG info files.')}</div></div><button class="secondary-btn" data-action="add-folder">${ic('plus',14)} ${tr('Add folder')}</button></div>
 <div class="folder-list">${folders.length?folders.map((f,index)=>`<div class="folder-item">${ic('folder',15)}<span title="${esc(f)}">${esc(f)}</span><button data-action="remove-folder" data-index="${index}" aria-label="${tr('Remove folder')}">${ic('close',15)}</button></div>`).join(''):`<span class="setting-help">${tr('No custom folders yet. Steam, Epic and GOG discovery works independently.')}</span>`}</div><div style="margin-top:16px"><button class="secondary-btn" data-action="scan">${ic('refresh',15)} ${tr('Scan now')}</button></div></div>
 <div class="settings-card"><h2>${tr('Data & privacy')}</h2><p>${tr('Your collection lives in a local SQLite database. Orbit does not require an account.')}</p>
 <div class="setting-row"><div><div class="setting-name">${tr('Application data')}</div><div class="setting-help">${tr('Browse your database, artwork cache, and preferences.')}</div></div><button class="secondary-btn" data-action="open-data">${ic('folder',15)} ${tr('Open folder')}</button></div>
 <div class="setting-row"><div><div class="setting-name">${tr('Library backup')}</div><div class="setting-help">${tr('Portable .orbit backups include artwork and metadata. JSON exports contain metadata only.')}</div></div><div class="setting-control" style="display:flex;gap:7px"><button class="secondary-btn" data-action="export">${ic('download',15)} ${tr('Export')}</button><button class="secondary-btn" data-action="restore">${ic('upload',15)} ${tr('Restore')}</button></div></div></div>
 </div></div></section>`;
}
function renderShell(){el('app').innerHTML=`<div class="app-shell"><div id="side-slot">${sidebar()}</div><div class="workspace"><div id="top-slot">${topbar()}</div><main class="content-scroll" id="main-scroll" tabindex="-1"><div id="page-slot"></div></main></div></div>`;el('main-scroll').addEventListener('scroll',()=>{if(el('virtual-games')&&!scrollFrame){scrollFrame=requestAnimationFrame(()=>{scrollFrame=null;renderVirtual()})}},{passive:true});renderPage()}
let scrollFrame=null,previousRenderedRoute=null;
function renderPage({keepScroll=false}={}){closeGameActions();const slot=el('page-slot'),scroller=el('main-scroll');if(!slot)return;const old=keepScroll?scroller.scrollTop:0;
 virtualRangeKey=null;virtualGamesRef=null;virtualRunningRef=null;virtualItems=new Map();
 slot.innerHTML=state.route==='home'?home():state.route==='settings'?settingsView():state.route==='statistics'?statisticsView():libraryView();
 if(previousRenderedRoute!==state.route)slot.firstElementChild?.classList.add('page-enter');
 previousRenderedRoute=state.route;
 scroller.scrollTop=0;
 renderVirtual();
 if(old){scroller.scrollTop=old;renderVirtual();}
 syncActivity();}
function refreshNavigation(keepScroll=false){el('side-slot').innerHTML=sidebar();el('top-slot').innerHTML=topbar();renderPage({keepScroll});}
function navigate(route,collectionId='all'){if(!['home','library','favorites','recent','statistics','settings'].includes(route))return;state.route=route;state.query='';state.filter='all';state.status='all';state.collection=route==='library'?collectionId:'all';state.playtime='all';state.showHidden=false;state.selectMode=false;state.selectedGames.clear();state.lastSelectedId=null;state.tag='all';state.genre='all';refreshNavigation();if(route==='statistics')void loadStatistics();}
function toast(message,error=false,action=null){const item=document.createElement('div');item.className=`toast ${error?'error':''}`;item.innerHTML=`${ic(error?'alert':'check',19)}<p>${tr(message)}</p>${action?`<button type="button" class="toast-action-btn">${esc(action.label)}</button>`:''}<button type="button" class="toast-close" aria-label="${tr('Dismiss notification')}">${ic('close',14)}</button>`;let timer=null;const dismiss=()=>{if(timer!==null){clearTimeout(timer);timer=null;}item.remove();};const startTimer=(delay)=>{if(timer!==null)clearTimeout(timer);timer=setTimeout(dismiss,delay);};item.querySelector('.toast-action-btn')?.addEventListener('click',()=>{dismiss();Promise.resolve(action.onClick?.()).catch(e=>toast(e.message||t('Action failed.'),true));});item.querySelector('.toast-close')?.addEventListener('click',dismiss);item.addEventListener('mouseenter',()=>{if(timer!==null){clearTimeout(timer);timer=null;}});item.addEventListener('focusin',()=>{if(timer!==null){clearTimeout(timer);timer=null;}});item.addEventListener('mouseleave',()=>startTimer(2400));item.addEventListener('focusout',()=>startTimer(2400));const root=el('toast-root');root.appendChild(item);while(root.children.length>3)root.firstElementChild.remove();startTimer(action?6500:4600)}
let libraryUpdates=null;
async function loadLibrarySnapshot(){
 if(typeof window.orbit.librarySnapshot==='function')return window.orbit.librarySnapshot();
 const [games,runningIds]=await Promise.all([window.orbit.listGames(),typeof window.orbit.runningGames==='function'?window.orbit.runningGames():[]]);
 return {games,runningIds};
}
function refreshFilterOptions(id,values,label,active){
 const select=el(id);if(!select)return;
 const choices=[...new Set(values.filter(Boolean))].sort((a,b)=>a.localeCompare(b)).slice(0,100);
 if(active!=='all'&&!choices.includes(active))choices.push(active);
 const options=[['all',label],...choices.map(value=>[value,value])];
 const previous=[...select.options].map(option=>[option.value,option.textContent]);
 if(JSON.stringify(previous)!==JSON.stringify(options)){
  select.replaceChildren(...options.map(([value,text])=>{const option=document.createElement('option');option.value=value;option.textContent=text;return option;}));
 }
 select.value=active;
}
function refreshCollectionFilterOptions(){
 const field=el('collection-filter-field'),select=el('collection-filter');
 if(!field||!select)return;
 field.hidden=!state.collections.length;
 const options=[['all',t('All collections')],...state.collections.map(c=>[c.id,c.name])];
 const previous=[...select.options].map(option=>[option.value,option.textContent]);
 if(JSON.stringify(previous)!==JSON.stringify(options)){
  select.replaceChildren(...options.map(([value,text])=>{const option=document.createElement('option');option.value=value;option.textContent=text;return option;}));
 }
 select.value=state.collection;
}
function syncLibraryFiltersUi({updateSidebar=false}={}){
 const popover=el('filters-popover'),badge=el('filters-popover-badge'),footer=el('filters-popover-footer');
 const activeExtra=extraFilterCount();
 const hiddenCount=state.games.filter(g=>g.hidden).length;
 if(popover)popover.classList.toggle('has-active',activeExtra>0);
 if(badge){badge.hidden=activeExtra===0;badge.textContent=activeExtra?formatNumber(activeExtra):'';}
 if(footer){
  footer.hidden=!(hiddenCount||state.showHidden||activeExtra);
  footer.innerHTML=`${hiddenCount||state.showHidden?`<button type="button" class="platform-chip ${state.showHidden?'active':''}" data-action="toggle-hidden-filter" aria-pressed="${state.showHidden}">${tr('Hidden')} <span>${formatNumber(hiddenCount)}</span></button>`:'<span></span>'}${activeExtra?`<button type="button" class="small-link" data-action="clear-filters">${tr('Clear filters')}</button>`:''}`;
 }
 refreshCollectionFilterOptions();
 if(state.route==='library'){
  const activeCol=state.collection!=='all'?state.collections.find(c=>c.id===state.collection):null;
  const heading=document.querySelector('.library-page .page-title');
  if(heading)heading.textContent=activeCol?activeCol.name:t('Your game library');
 }
 if(updateSidebar){const side=el('side-slot');if(side)side.innerHTML=sidebar();}
}
function syncBulkDock(){const slot=el('bulk-dock-slot');if(slot)slot.innerHTML=bulkActionDock();}
function applyLibraryUpdate(change){
 const runningChanged=state.runningIds!==change.runningIds;
 state.games=change.games;state.runningIds=change.runningIds;
 for(const id of change.removedIds||[])state.selectedGames.delete(id);
 for(const id of [...change.runningIds,...change.removedIds])clearLaunchPending(id);
 wakeDesktopPadEntry();
 if(controllerMode?.active){controllerMode.update();return;}
 const visibleCount=state.games.filter(g=>!g.hidden).length;
 const count=el('side-slot')?.querySelector('[data-route="library"] .count');
 if(count&&count.textContent!==formatNumber(visibleCount))count.textContent=formatNumber(visibleCount);
 if(['library','favorites','recent'].includes(state.route)){
  if(change.reset||!el('virtual-games')||!state.games.length){
   const focus=captureGameFocus(el('page-slot'));renderPage({keepScroll:true});restoreGameFocus(el('page-slot'),focus);
  }else{
   refreshFilterOptions('genre-filter',state.games.map(game=>game.genre),t('All genres'),state.genre);
   refreshFilterOptions('tag-filter',state.games.flatMap(game=>game.tags||[]),t('All tags'),state.tag);
   const platforms=el('platform-filter-slot');if(platforms)platforms.innerHTML=platformFilters();
   syncLibraryFiltersUi();
   syncBulkDock();
   renderVirtual();
  }
 }else if(state.route==='home'){
  const focus=captureGameFocus(el('page-slot'));renderPage({keepScroll:true});restoreGameFocus(el('page-slot'),focus);
 }
 syncActivity();
 syncUpdateUi();
 if(state.modal?.type==='detail'&&(change.reset||runningChanged||change.changedIds.includes(state.modal.id)||change.removedIds.includes(state.modal.id)))renderModal();
}
function handleOrbitEvent(event){
 if(event.type==='gamesChanged')libraryUpdates.receive(event);
 if(event.type==='collectionsChanged'&&Array.isArray(event.collections)){
  state.collections=event.collections;
  if(state.collection!=='all'&&!state.collections.some(c=>c.id===state.collection))state.collection='all';
  if(controllerMode?.active){controllerMode.update();return;}
  const side=el('side-slot');if(side)side.innerHTML=sidebar();
  syncLibraryFiltersUi();
  renderVirtual();
  if(['detail','collections','game-collections','bulk-collections'].includes(state.modal?.type))renderModal();
 }
 if(event.type==='launchPending')waitForLaunchConfirmation(event.id,event.waitMs);
 if(event.type==='settingsChanged'){
  const oldLanguage=state.settings?.language||'system';
  state.settings=event.settings;setupTheme();
  if((event.settings?.language||'system')!==oldLanguage){applyLanguage(event.settings.language);if(!window.OrbitI18n)redrawForLanguage();}
  controllerMode?.update();
 }
 if(event.type==='updateStatus'){state.updateStatus=event.status;syncUpdateUi();controllerMode?.update();if(event.status?.state==='ready'&&event.status.version&&notifiedUpdateReadyVersion!==event.status.version){notifiedUpdateReadyVersion=event.status.version;toast(t('Update v{version} is ready to install.',{version:event.status.version}));}}
 if(event.type==='windowState')controllerMode?.windowState(event);
 if(event.type==='toggleControllerMode')Promise.resolve().then(toggleControllerMode).catch(error=>toast(error.message,true));
 if(event.type==='error')toast(event.message,true);
}
async function saveSettings(patch){
 const previousLanguage=state.settings?.language||'system';
 state.settings=await window.orbit.saveSettings(patch);setupTheme();
 if((state.settings?.language||'system')!==previousLanguage||Object.hasOwn(patch,'language')){
  applyLanguage(state.settings?.language);
  if(!window.OrbitI18n)redrawForLanguage();
 }else if(state.route==='settings')renderPage({keepScroll:true});
}
// Redrawing translated surfaces replaces their DOM nodes. Keep the keyboard
// target and in-progress game editor fields across a language switch.
function captureLocaleFocus(){
 const active=document.activeElement;
 if(!active||active===document.body||active===document.documentElement)return null;
 if(!['side-slot','top-slot','page-slot','modal-root'].some(id=>el(id)?.contains(active)))return null;
 const focus={id:active.id,action:active.dataset?.action,route:active.dataset?.route,gameId:active.dataset?.id,key:active.dataset?.key,page:active.dataset?.page,importIndex:active.dataset?.importIndex};
 if(active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement){
  try{focus.selection=[active.selectionStart,active.selectionEnd,active.selectionDirection]}catch{/* Non-text inputs have no selection range. */}
 }
 return focus;
}
function restoreLocaleFocus(focus){
 if(!focus)return;
 let target=focus.id?el(focus.id):null;
 if(!target&&focus.importIndex!==undefined){
  target=[...el('modal-root')?.querySelectorAll('[data-import-index]')||[]].find(node=>node.dataset.importIndex===focus.importIndex);
 }
 if(!target&&focus.action){
  target=[...document.querySelectorAll('[data-action]')].find(node=>node.dataset.action===focus.action
   &&node.dataset.route===focus.route&&node.dataset.id===focus.gameId&&node.dataset.key===focus.key&&node.dataset.page===focus.page);
 }
 if(!target?.isConnected||target.disabled)return;
 target.focus({preventScroll:true});
 if(focus.selection&&typeof target.setSelectionRange==='function'&&focus.selection[0]!==null){
  try{target.setSelectionRange(...focus.selection)}catch{/* Text selection may not apply to replacement input. */}
 }
}
function captureGameEditorDraft(){
 if(state.modal?.type!=='game')return null;
 const form=el('game-form');if(!form)return null;
 return {
  fields:[...form.elements].filter(field=>field.id).map(field=>({
   id:field.id,value:field.value,checked:field.checked,detectedName:field.dataset?.detectedName
  })),
  previews:['cover','banner','icon'].map(kind=>[kind,el(`preview-${kind}`)?.cloneNode(true)]),
  scroll:[...el('modal-root').querySelectorAll('.dialog,.dialog-body')].map(node=>[node.scrollTop,node.scrollLeft]),
  detection:el('game-detection-status')?.textContent,
  search:el('cover-search-status')?.textContent
 };
}
function restoreGameEditorDraft(draft){
 if(!draft)return;
 for(const field of draft.fields){
  const node=el(field.id);if(!node)continue;
  node.value=field.value;
  if(typeof field.checked==='boolean')node.checked=field.checked;
  if(field.detectedName!==undefined)node.dataset.detectedName=field.detectedName;
 }
 for(const [kind,preview] of draft.previews){
  const target=el(`preview-${kind}`);
  if(target&&preview)target.replaceChildren(...[...preview.childNodes].map(node=>node.cloneNode(true)));
 }
 if(draft.detection!==undefined&&el('game-detection-status'))el('game-detection-status').textContent=draft.detection;
 if(draft.search!==undefined&&el('cover-search-status'))el('cover-search-status').textContent=draft.search;
 [...el('modal-root').querySelectorAll('.dialog,.dialog-body')].forEach((node,index)=>{
  if(!draft.scroll[index])return;
  [node.scrollTop,node.scrollLeft]=draft.scroll[index];
 });
}
const localeRenderKey=()=>window.OrbitI18n?`${window.OrbitI18n.getLanguage?.()}:${window.OrbitI18n.getPreference?.()}`:`plain:${state.settings?.language||'system'}`;
let lastRenderedLocale=null;
// Settings events and saveSettings may both apply the same preference; render
// once per effective language/preference change, including external OS changes.
function redrawForLanguage(){
 if(!el('page-slot'))return;
 const locale=localeRenderKey();
 if(locale===lastRenderedLocale)return;
 lastRenderedLocale=locale;
 const focus=captureLocaleFocus(),draft=captureGameEditorDraft();
 refreshNavigation(true);
 if(state.modal){renderModal();restoreGameEditorDraft(draft);}
 restoreLocaleFocus(focus);
 controllerMode?.update();
}
window.addEventListener('orbit:languagechange',redrawForLanguage);
let modalReturnFocus=null,modalReturnFocusAction=null;
let gameActionsTrigger=null,gameActionsAnchor=null;
function closeGameActions(restoreFocus=false){
 const trigger=gameActionsTrigger;
 el('game-actions-popup')?.remove();
 if(trigger?.isConnected&&trigger.hasAttribute('aria-expanded'))trigger.setAttribute('aria-expanded','false');
 gameActionsTrigger=null;
 gameActionsAnchor=null;
 if(restoreFocus&&trigger?.isConnected)trigger.focus({preventScroll:true});
}
function openGameActions(trigger,point=null){
 if(!point&&gameActionsTrigger===trigger){closeGameActions(true);return;}
 closeGameActions();
 const gameId=point?.id||trigger?.dataset.id;
 const game=state.games.find(item=>item.id===gameId);
 if(!game)return;
 gameActionsTrigger=trigger||null;
 if(trigger?.hasAttribute?.('aria-expanded'))trigger.setAttribute('aria-expanded','true');
 const id=esc(game.id);
 const item=(action,icon,label,extra='',attrs='')=>`<button type="button" role="menuitem" class="game-actions-item ${extra}" data-action="${action}" data-id="${id}" ${attrs}>${ic(icon,16)}<span>${label}</span></button>`;
 const profiles=Array.isArray(game.launch_profiles)?game.launch_profiles:[];
 const profileItems=profiles.map(p=>item('launch-profile','lightning',tr('Launch: {profile}',{profile:p.name}),'game-actions-profile',`data-profile="${esc(p.id)}"`)).join('');
 const statusGroup=`<div class="game-actions-status-group" role="group" aria-label="${tr('Play status')}">${PLAY_STATUSES.map(([code,label])=>`<button type="button" role="menuitemradio" aria-checked="${game.play_status===code}" class="game-actions-item game-actions-status ${game.play_status===code?'is-checked':''}" data-action="set-status" data-id="${id}" data-status="${code}"><span class="menu-check-dot" aria-hidden="true">${game.play_status===code?ic('check',13):''}</span><span>${tr(label)}</span></button>`).join('')}</div>`;
 const menu=document.createElement('div');
 menu.id='game-actions-popup';menu.className='game-actions-popup';menu.setAttribute('role','menu');
 menu.setAttribute('aria-label',t('Actions for {name}',{name:game.name}));
 menu.innerHTML=item('launch','play',tr('Play game'))+profileItems+item('favorite','heart',tr(game.favorite?'Remove favorite':'Add to favorites'))+
  '<hr class="game-actions-divider" />'+statusGroup+
  '<hr class="game-actions-divider" />'+
  item('game-collections','folder',tr('Collections'))+item('detail','info',tr('View details'))+item('edit','edit',tr('Edit game'))+item('open-folder','folder',tr('Open game location'))+
  '<hr class="game-actions-divider" />'+
  item('toggle-hide',game.hidden?'check':'close',tr(game.hidden?'Unhide game':'Hide from library'))+
  item('remove-confirm','trash',tr('Remove from library'),'danger');
 document.body.appendChild(menu);
 const rect=trigger?.getBoundingClientRect?.()||{x:point?.x||8,y:point?.y||8,right:(point?.x||8),bottom:(point?.y||8),top:(point?.y||8)};
 gameActionsAnchor={x:rect.x,y:rect.y,scrollTop:el('main-scroll')?.scrollTop||0};
 const menuRect=menu.getBoundingClientRect();
 const contentLeft=Math.max(8,(el('main-scroll')?.getBoundingClientRect?.().left||0)+8);
 const maxLeft=Math.max(8,document.documentElement.clientWidth-menuRect.width-8);
 const preferredLeft=point?point.x:(rect.right-menuRect.width>=contentLeft?rect.right-menuRect.width:rect.left);
 const minLeft=contentLeft<=maxLeft?contentLeft:8;
 const left=Math.max(minLeft,Math.min(preferredLeft,maxLeft));
 const top=point?Math.max(8,Math.min(point.y,window.innerHeight-menuRect.height-8)):(rect.bottom+8+menuRect.height<=window.innerHeight-8?rect.bottom+8:Math.max(8,rect.top-menuRect.height-8));
 menu.style.left=`${left}px`;menu.style.top=`${top}px`;
 menu.querySelector('[role=menuitem],[role=menuitemradio]')?.focus({preventScroll:true});
}
function openModal(type,meta={}){pauseDesktopPadEntry();closeGameActions();if(!state.modal){modalReturnFocus=document.activeElement;modalReturnFocusAction=modalReturnFocus?.dataset.action?{action:modalReturnFocus.dataset.action,id:modalReturnFocus.dataset.id,kind:['card-open-trigger','row-open-trigger','continue-open-trigger','game-menu','hero-detail'].find(name=>modalReturnFocus.classList.contains(name))}:null;}state.modal={type,...meta};renderModal()}
const WHATS_NEW_VERSION='0.5.2';
const WHATS_NEW_KEY='orbit.whatsNew.lastAcknowledgedVersion';
let whatsNewPending=false;
function markWhatsNewSeen(){
 try{window.localStorage?.setItem(WHATS_NEW_KEY,WHATS_NEW_VERSION)}catch{/* Denied storage must not break the launcher. */}
}
function showWhatsNewAfterBoot(){
 // Brand-new empty installs see the welcome hero instead of a changelog modal.
 if(!state.games.length)return;
 // Only show the notes for a corresponding packaged app. Windows packaging
 // may append build metadata or a fourth zero segment.
 const reported=String(state.version||'');
 const suffix=reported.startsWith(WHATS_NEW_VERSION)?reported.slice(WHATS_NEW_VERSION.length):null;
 if(suffix===null||(suffix&&!/^(?:\.0)?(?:[.+-].*)?$/.test(suffix)))return;
 try{if(window.localStorage?.getItem(WHATS_NEW_KEY)===WHATS_NEW_VERSION)return}catch{/* Show once per running session if storage is denied. */}
 // A startup scan/other modal must not swallow the update notes forever.
 if(state.modal){whatsNewPending=true;return;}
 whatsNewPending=false;
 openModal('whats-new',{automatic:true});
}
function whatsNewDialog(){
 const points=(items)=>items.map(item=>`<li>${tr(item)}</li>`).join('');
 return `<div class="dialog-scrim" data-action="scrim"><section class="dialog wide whats-new-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="whats-new-intro">
 <div class="whats-new-header"><span class="whats-new-eyebrow">${ic('sparkles',15)} ORBIT · v${WHATS_NEW_VERSION}</span><button class="ghost-btn whats-new-close" data-action="close-modal" aria-label="${tr('Close release notes')}">${ic('close',20)}</button>
 <h2 id="dialog-title">${tr("What's new in Orbit")}</h2><p id="whats-new-intro">${tr('Highlights from 0.2.7 through 0.5.2')}</p></div>
 <div class="whats-new-content">
 <section class="whats-new-version"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.5.2 — New')}</span><h3>${tr('Refined UI polish, streamlined Library & Game Details, and Controller Mode upgrades')}</h3></div>
 <ul>${points(['Collapsed the Library toolbar into two clean rows with focus-preserving filters, unified select controls, a scrollable custom-collections sidebar, List View menus, and Bulk Favorite/Remove actions.','Streamlined Game Details into two action tiers with an inline play-status picker and More menu, added inline accessible form validation with unsaved-changes protection, and guarded destructive actions.','Synced Controller Mode with your accent color and desktop status badge colors, added Xbox/PlayStation button prompts, A–Z quick jumping, auto-dismissing notices, and polished card action menus.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.5.1 — New')}</span><h3>${tr('Faster updates, sharper controller artwork and polished favorites')}</h3></div>
 <ul>${points(['Automatic updates now check much faster on startup, reopen, window focus, and every 15 minutes with cache-bypass headers and smoother progress updates.','Controller Mode now displays library covers in true 2:3 poster proportions with adaptive portrait/landscape framing and soft ambient backdrops for custom artwork.','Upgraded favorite buttons across desktop cards, list rows, game details, and Controller Mode with frosted glass styling, crisp SVG hearts, and a dedicated controller card badge.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.5.0 — New')}</span><h3>${tr('Console Experience: Controller Mode 2.0')}</h3></div>
 <ul>${points(['Browse custom collections, play statuses, hidden games, and alternative launch profiles directly inside Controller Mode.','Use the new couch Browse drawer (R3 / F2), Game Options sheet, and gamepad Quick Search keyboard (L3 / F3) without needing a mouse or physical keyboard.','Added zero idle gamepad polling, opt-in startup auto-entry, subtle navigation audio and launch vibration, automatic post-session return, and actionable update notices.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.4.1 — New')}</span><h3>${tr('Docked update controls and automatic checks on reopen')}</h3></div>
 <ul>${points(['Moved the update button into the sidebar footer above the app version with live downloading, ready-to-install, and icon-rail indicator states.','Orbit now checks for signed updates automatically when reopening from the tray or restoring from minimized, while staying quiet during active games.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.4.0 — New')}</span><h3>${tr('Your Gaming Library: statuses, collections, bulk actions and launch profiles')}</h3></div>
 <ul>${points(['Organize games with play statuses (Currently Playing, Backlog, Completed, On Hold), hidden state, and custom SQLite collections synced across backups.','Combine multi-filters, smart search operators (status:, source:, tag:, in:, time:, is:hidden), and multi-select bulk actions.','Configure per-game environment variables, alternative launch profiles, and native Windows AppsFolder launching for Xbox titles.'])}</ul></section>
 <details class="whats-new-older"><summary class="whats-new-older-summary">${tr('Earlier releases (0.3.6 – 0.2.7)')}</summary><div class="whats-new-older-body">
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.3.6 — New')}</span><h3>${tr('Signed automatic updates and release hardening')}</h3></div>
 <ul>${points(['Orbit checks for signed updates automatically in the background and installs verified releases directly from Settings or the sidebar.','Updates pause automatically while a game is running and verify Ed25519 release signatures before restarting.','Release executables strip local build paths and enforce a restrictive Tauri security policy.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.3.5 — New')}</span><h3>${tr('Refined Overview, poster cards and accessibility')}</h3></div>
 <ul>${points(['Overview aligns hero artwork cleanly, filters platforms in place, and translates all library and playtime counts.','Poster cards align corner controls, show a live Playing badge, and support arrow-key navigation and right-click menus.','Game details include quick management actions, launch arguments accept plain CLI flags, and play sessions edit in hours and minutes.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.3.4 — New')}</span><h3>${tr('Rust is now the only Orbit desktop edition')}</h3></div>
 <ul>${points(['Removed the legacy Electron edition and promoted the native Rust + Tauri desktop app as the main Orbit Launcher.','First launch automatically copies existing Rust Preview or legacy Electron libraries and artwork without modifying old files.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.3.3 — New')}</span><h3>${tr('Stronger Rust recovery, tray and artwork checks')}</h3></div>
 <ul>${points(['Interrupted playtime recovers from the last saved checkpoint without distorting statistics, and backups decode before locking the library.','Automatic cover scans stop starving later titles, keep larger custom covers intact, and skip idle process checks.','Tray menu updates and window placement restoration stay responsive while Orbit shuts down or minimizes cleanly.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.3.2 — New')}</span><h3>${tr('More reliable playtime and backups')}</h3></div>
 <ul>${points(['Orbit handles games that close during startup and reports playtime tracking problems.','JSON backups take less memory to restore, and Xbox artwork uses one verified manifest.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.3.1 — New')}</span><h3>${tr('A clearer Play button')}</h3></div>
 <ul>${points(['The Play button keeps its accent color above the poster shading.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.3.0 — New')}</span><h3>${tr('A smoother game library')}</h3></div>
 <ul>${points(['Browse your full collection in Overview and review newly discovered games.','Orbit waits for supported games to start and restores your place in controller mode.','View or correct recorded play sessions, and launch favorites and recent games from the tray.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.2.11 — New')}</span><h3>${tr('A cleaner interface')}</h3></div>
 <ul>${points(["The What's New dialog no longer has a purple border around the whole window.",'The close button is aligned with the header and remains keyboard accessible.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.2.10 — New')}</span><h3>${tr('A cleaner interface')}</h3></div>
 <ul>${points(['Selected favorite hearts remain visible; other hearts appear on hover or keyboard focus.','The release notes scrollbar is slim, rounded and uses your accent color.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.2.9 — New')}</span><h3>${tr('Your Orbit is ready')}</h3></div>
 <ul>${points(['Favorite hearts stay top-left and align with the actions menu on the right. Outlines and selected fills are purple.','Rocket League no longer stays Playing because of a leftover EAC helper process.','Xbox and Game Pass local game logos appear when a portrait cover is unavailable.','Release notes are always available from the sidebar and Settings.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.2.8 — New')}</span><h3>${tr('Rust is now the primary Windows edition')}</h3></div>
 <ul>${points(['Fully purple favorite hearts','Show what\'s new after installing or updating.','Electron remains available as a fallback.'])}</ul></section>
 <section class="whats-new-version whats-new-history"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.2.7 — Included improvements')}</span><h3>${tr('A cleaner library')}</h3></div>
 <ul>${points(['Poster cards, purple Play buttons and responsive layouts.'])}</ul>
 <h3>${tr('Controller experience')}</h3><ul>${points(['Standard gamepads: Menu/Options entry, safer focus, triggers and right-stick scrolling.'])}</ul>
 <h3>${tr('Language and accessibility')}</h3><ul>${points(['English, Nederlands, Deutsch, Français and Español with automatic language selection.'])}</ul>
 <h3>${tr('Data safety and performance')}</h3><ul>${points(['Safer portable backups, completed play-session history and first-run library migration.','Stronger artwork handling, offline cover repair and session recovery.'])}</ul></section>
 </div></details>
 <p class="whats-new-warning">${ic('info',15)} ${tr('Existing Rust Preview and Electron libraries are imported automatically once on first launch; back up before upgrading if needed.')} ${tr('In-app updates verify Ed25519 release signatures before installing; Windows SmartScreen may still prompt for manual installers.')}</p>
 </div><div class="whats-new-footer"><span>${tr('You can reopen this screen in Settings.')}</span><button class="primary-btn" data-action="close-modal">${tr('Continue to your library')} ${ic('arrow',16)}</button></div></section></div>`;
}
function closeModal(){if(state.modal?.type==='whats-new')markWhatsNewSeen();state.modal=null;el('modal-root').innerHTML='';if(el('app'))el('app').inert=false;const candidates=modalReturnFocusAction?[...document.querySelectorAll('[data-action]')].filter(node=>node.dataset.action===modalReturnFocusAction.action&&node.dataset.id===modalReturnFocusAction.id):[];const target=modalReturnFocus?.isConnected?modalReturnFocus:candidates.find(node=>modalReturnFocusAction.kind&&node.classList.contains(modalReturnFocusAction.kind))||candidates[0];target?.focus({preventScroll:true});modalReturnFocus=null;modalReturnFocusAction=null;wakeDesktopPadEntry();if(whatsNewPending){whatsNewPending=false;Promise.resolve().then(showWhatsNewAfterBoot);}}
function requestCloseModal(){
 const form=state.modal?.type==='game'?el('game-form'):null;
 if(form?.dataset.dirty==='true'){
  let bar=el('dirty-guard-bar');
  if(!bar){
   const footer=form.querySelector('.dialog-footer');
   if(footer){
    bar=document.createElement('div');
    bar.id='dirty-guard-bar';
    bar.className='dirty-guard-bar';
    bar.setAttribute('role','alert');
    bar.innerHTML=`<span>${tr('You have unsaved changes.')}</span><div class="dirty-guard-actions"><button type="button" class="secondary-btn" data-action="keep-editing">${tr('Keep editing')}</button><button type="button" class="danger-btn" data-action="force-close-modal">${tr('Discard changes')}</button></div>`;
    footer.prepend(bar);
   }
  }
  bar?.querySelector('[data-action="keep-editing"]')?.focus();
  return;
 }
 closeModal();
}
function dialogFrame(title,description,body,footer='',wide=false){return `<div class="dialog-scrim" data-action="scrim"><section class="dialog ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-header"><div><h2 id="dialog-title">${esc(title)}</h2><p>${esc(description)}</p></div><button class="ghost-btn" data-action="close-modal" aria-label="${tr('Close dialog')}">${ic('close',21)}</button></div>${body}${footer}</section></div>`}
function formatLaunchArgsInput(args){if(!Array.isArray(args)||!args.length)return '';return args.map(arg=>/[\s"']/.test(arg)?`"${String(arg).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`:String(arg)).join(' ');}
function parseLaunchArgsInput(raw){const text=String(raw||'').trim();if(!text)return [];if(text.startsWith('[')){const parsed=JSON.parse(text);if(!Array.isArray(parsed)||parsed.some(item=>typeof item!=='string'))throw Error();return parsed;}const tokens=[];let current='',quote=null,hasToken=false;for(let index=0;index<text.length;index++){const ch=text[index];if(ch==='\\'&&quote==='"'&&index+1<text.length&&(text[index+1]==='"'||text[index+1]==='\\')){current+=text[++index];hasToken=true;continue;}if(quote){if(ch===quote)quote=null;else current+=ch;continue;}if(ch==='"'||ch==="'"){quote=ch;hasToken=true;continue;}if(/\s/.test(ch)){if(hasToken){tokens.push(current);current='';hasToken=false;}continue;}current+=ch;hasToken=true;}if(quote)throw Error();if(hasToken)tokens.push(current);return tokens;}
function launchProfileRow(profile={},index=0){
 const uid=esc(profile.id||'');
 const args=formatLaunchArgsInput(profile.launch_args);
 const env=formatEnvText(profile.launch_env);
 return `<div class="profile-editor-card" data-profile-row data-profile-id="${uid}">
  <div class="profile-editor-head"><strong>${tr('Profile {index}',{index:formatNumber(index+1)})}</strong><button type="button" class="small-link" data-action="remove-launch-profile" aria-label="${tr('Remove profile')}">${ic('trash',14)} ${tr('Remove')}</button></div>
  <div class="field-grid">
   <div class="field"><label>${tr('Profile name')}</label><input type="text" data-profile-field="name" maxlength="80" value="${esc(profile.name||'')}" placeholder="${tr('Mod loader, DirectX 11, Safe mode…')}" /></div>
   <div class="field"><label>${tr('Launch arguments')}</label><input type="text" data-profile-field="launch_args" value="${esc(args)}" placeholder="--dx11 --skip-intro" /></div>
  </div>
  <div class="field"><label>${tr('Executable override (optional)')}</label><div class="file-field"><input type="text" data-profile-field="executable" value="${esc(profile.executable||'')}" placeholder="${tr('Defaults to main game executable')}" /><button type="button" class="secondary-btn" data-action="choose-profile-exe">${ic('folder',15)} ${tr('Browse .exe')}</button></div></div>
  <div class="field-grid">
   <div class="field"><label>${tr('Launcher URI override (optional)')}</label><input type="text" data-profile-field="launch_uri" value="${esc(profile.launch_uri||'')}" placeholder="shell:AppsFolder\\..." /></div>
   <div class="field"><label>${tr('Working directory override')}</label><input type="text" data-profile-field="working_dir" value="${esc(profile.working_dir||'')}" placeholder="${tr('Defaults to game working directory')}" /></div>
  </div>
  <div class="field"><label>${tr('Profile environment variables')}</label><textarea class="env-textarea" data-profile-field="launch_env" rows="2" placeholder="KEY=VALUE">${esc(env)}</textarea></div>
 </div>`;
}
let formAnnouncer=null,formAnnounceTimer=null,formAnnouncedField=null;
const formFlaggedFields=new WeakSet(),formAnnouncedFields=new WeakSet();
function ensureFormAnnouncer(){
 if(formAnnouncer?.isConnected)return formAnnouncer;
 formAnnouncer=document.createElement('div');
 formAnnouncer.setAttribute('aria-live','polite');
 formAnnouncer.className='visually-hidden';
 document.body.append(formAnnouncer);
 return formAnnouncer;
}
function linkFieldError(node,shown){
 const errorId=node?.dataset?.error;
 if(!errorId)return;
 const ids=(node.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!==errorId);
 if(shown)ids.push(errorId);
 if(ids.length)node.setAttribute('aria-describedby',ids.join(' '));
 else node.removeAttribute('aria-describedby');
}
function announceFieldError(node){
 const err=node?.dataset?.error?el(node.dataset.error):null;
 if(!err?.textContent.trim())return;
 const label=node.labels?.[0]?`${node.labels[0].textContent.trim()}: `:'';
 const region=ensureFormAnnouncer();
 clearTimeout(formAnnounceTimer);
 region.textContent='';
 formAnnouncedField=node;
 formAnnounceTimer=setTimeout(()=>{region.textContent=label+err.textContent.trim();},500);
}
function clearFieldError(node){
 if(!node?.matches?.('input,select,textarea'))return;
 node.setAttribute('aria-invalid','false');
 linkFieldError(node,false);
 const err=node.dataset.error?el(node.dataset.error):null;
 if(err)err.classList.remove('is-visible');
 formFlaggedFields.delete(node);
 formAnnouncedFields.delete(node);
 if(formAnnouncedField===node){clearTimeout(formAnnounceTimer);if(formAnnouncer)formAnnouncer.textContent='';}
}
function setFieldError(node,message){
 if(!node)return;
 const parentDetails=node.closest('details.editor-section');
 if(parentDetails)parentDetails.open=true;
 const err=node.dataset.error?el(node.dataset.error):null;
 if(err){err.textContent=message;err.classList.add('is-visible');}
 node.setAttribute('aria-invalid','true');
 linkFieldError(node,true);
 formFlaggedFields.add(node);
 formAnnouncedFields.add(node);
 node.scrollIntoView({block:'nearest',behavior:'auto'});
 node.focus();
}
function syncFieldAria(node,announce=false){
 if(!node?.matches?.('input,select,textarea')||!node.closest('#game-form'))return;
 let invalid=false;
 try{invalid=node.matches(':user-invalid');}catch{invalid=!node.validity?.valid;}
 if(invalid){
  if(announce&&!formAnnouncedFields.has(node)){announceFieldError(node);formAnnouncedFields.add(node);}
  node.setAttribute('aria-invalid','true');
  linkFieldError(node,true);
  formFlaggedFields.add(node);
 }else if(formFlaggedFields.has(node)||node.getAttribute('aria-invalid')!=='true'){
  clearFieldError(node);
 }
}
function editor(g){const isEdit=!!g;const title=t(isEdit?'Edit game':'Add a game');const params=formatLaunchArgsInput(g?.launch_args);const envText=formatEnvText(g?.launch_env);const profiles=Array.isArray(g?.launch_profiles)?g.launch_profiles:[];const hasAdvanced=!!(g?.launch_uri||g?.working_dir||(Array.isArray(g?.launch_args)&&g.launch_args.length)||envText||profiles.length);
 const imgSection=(key,label)=>`<div class="image-upload"><div id="preview-${key}">${artwork(g?.[key])?`<img src="${artwork(g[key])}" alt="${tr('{label} preview',{label:t(label)})}" />`:key==='cover'&&artwork(g?.icon)?`<div class="auto-icon-preview"><img src="${artwork(g.icon)}" alt="${tr('Icon fallback')}" /></div>`:`<div class="image-placeholder">${ic('image',21)}</div>`}</div><div style="flex:1"><p>${tr(label)}</p><small>${tr(key==='icon'?'Used when no cover exists':'PNG, JPEG or WebP')}</small></div><button type="button" class="secondary-btn" data-action="choose-art" data-key="${key}">${tr('Choose')}</button><button type="button" class="small-link" data-action="clear-art" data-key="${key}" aria-label="${tr('Clear {label}',{label:t(label)})}">${tr('Clear')}</button></div>`;
 return dialogFrame(title,t(isEdit?'Update this game without changing its installation.':'Select any locally installed game executable. Orbit recognizes known game filenames and looks for cover art or an icon.'),`<form id="game-form" data-form="game" data-id="${esc(g?.id||'')}" novalidate><div class="dialog-body">
  <div class="field"><label for="game-name">${tr('Game title *')}</label><input id="game-name" name="name" type="text" maxlength="140" value="${esc(g?.name||'')}" placeholder="${tr('For example, Hollow Knight')}" required aria-invalid="false" data-error="game-name-error" /><span id="game-name-error" class="field-error">${tr('Enter a game title.')}</span></div>
  <div class="field"><label for="game-executable">${tr('Executable')}</label><div class="file-field"><input id="game-executable" name="executable" type="text" value="${esc(g?.executable||'')}" placeholder="${tr('Select the game executable')}" aria-invalid="false" data-error="game-executable-error" /><button type="button" class="secondary-btn" data-action="choose-exe">${ic('folder',16)} ${tr('Browse .exe')}</button></div><span id="game-executable-error" class="field-error">${tr('Choose an executable or enter a supported game-launch URI.')}</span><div class="file-extras"><button type="button" class="small-link" data-action="find-art">${ic('sparkles',14)} ${tr('Detect game & icon')}</button><span id="game-detection-status" role="status" aria-live="polite"></span></div></div>
  <div class="field-grid"><div class="field"><label for="game-genre">${tr('Genre')}</label><input id="game-genre" name="genre" type="text" maxlength="100" value="${esc(g?.genre||'')}" placeholder="${tr('Adventure, RPG, Strategy…')}" aria-invalid="false" /></div><div class="field"><label for="game-play-status">${tr('Play status')}</label><div class="select-wrap"><select id="game-play-status" name="play_status" aria-invalid="false"><option value="" ${!g?.play_status?'selected':''}>${tr('No status')}</option>${PLAY_STATUSES.map(([code,label])=>`<option value="${code}" ${g?.play_status===code?'selected':''}>${tr(label)}</option>`).join('')}</select></div></div></div>
  <div class="field"><label for="game-tags">${tr('Tags')}</label><input id="game-tags" name="tags" value="${esc((g?.tags||[]).join(', '))}" type="text" placeholder="${tr('Co-op, Story, Competitive')}" aria-invalid="false" /><small>${tr('Separate multiple tags with commas.')}</small></div>
  <details class="editor-section" open><summary>${tr('Artwork & cover appearance')}</summary><div class="editor-section-body">
   <div class="image-fields">${imgSection('cover','Cover artwork')}${imgSection('banner','Banner artwork')}${imgSection('icon','Game icon')}</div>
   <div class="field cover-search"><label for="cover-search-title">${tr('Find a cover online')}</label><div class="file-field"><input id="cover-search-title" type="text" maxlength="140" placeholder="${tr('Use game title, or enter a different title')}" autocomplete="off" aria-invalid="false" /><button type="button" class="secondary-btn" data-action="find-online-art">${ic('search',14)} ${tr('Search')}</button></div><small>${tr('Search Steam and Epic Games. The preview changes only when a cover is found; save to apply it.')}</small><span id="cover-search-status" role="status" aria-live="polite"></span></div>
   <div class="field-grid"><div class="field"><label for="game-cover-fit">${tr('Cover presentation')}</label><div class="select-wrap"><select id="game-cover-fit" name="cover_fit" aria-invalid="false"><option value="cover" ${g?.cover_fit!=='contain'?'selected':''}>${tr('Fill frame')}</option><option value="contain" ${g?.cover_fit==='contain'?'selected':''}>${tr('Fit entire artwork')}</option></select></div></div><div class="field"><label for="game-cover-position">${tr('Cover position')}</label><div class="select-wrap"><select id="game-cover-position" name="cover_position" aria-invalid="false"><option value="center" ${!['top','bottom'].includes(g?.cover_position)?'selected':''}>${tr('Center')}</option><option value="top" ${g?.cover_position==='top'?'selected':''}>${tr('Top')}</option><option value="bottom" ${g?.cover_position==='bottom'?'selected':''}>${tr('Bottom')}</option></select></div></div></div>
  </div></details>
  <details class="editor-section" ${hasAdvanced?'open':''}><summary>${tr('Advanced launch options')}</summary><div class="editor-section-body">
   <div class="field"><label for="game-uri">${tr('Launcher URI (optional)')}</label><input id="game-uri" name="launch_uri" value="${esc(g?.launch_uri||'')}" type="text" placeholder="steam://rungameid/12345 · shell:AppsFolder\\..." aria-invalid="false" /><small>${tr('Orbit launches through the associated game launcher or Windows AppsFolder URI. Add the game executable for direct playtime tracking.')}</small></div>
   <div class="field"><label for="game-workdir">${tr('Working directory')}</label><div class="file-field"><input id="game-workdir" name="working_dir" type="text" value="${esc(g?.working_dir||'')}" placeholder="${tr('Defaults to executable folder')}" aria-invalid="false" /><button type="button" class="secondary-btn" data-action="choose-workdir">${ic('folder',15)} ${tr('Browse folder')}</button></div></div>
   <div class="field"><label for="game-args">${tr('Launch arguments')}</label><input id="game-args" name="launch_args" type="text" value="${esc(params)}" placeholder="--fullscreen --windowed" aria-invalid="false" data-error="game-args-error" /><span id="game-args-error" class="field-error">${tr('Check unmatched quotes or invalid JSON in launch arguments.')}</span><small>${tr('Optional command-line flags, e.g. --fullscreen --skip-intro.')}</small></div>
   <div class="field"><label for="game-env">${tr('Environment variables')}</label><textarea id="game-env" name="launch_env" class="env-textarea" rows="3" placeholder="DXVK_HUD=fps&#10;MANGOHUD=1" aria-invalid="false" data-error="game-env-error">${esc(envText)}</textarea><span id="game-env-error" class="field-error">${tr('Use KEY=VALUE format (one per line) for environment variables.')}</span><small>${tr('Optional KEY=VALUE pairs (one per line) applied when launching this game.')}</small></div>
   <div class="profiles-editor-block"><div class="profiles-editor-head"><div><strong>${tr('Alternative launch profiles')}</strong><small>${tr('Create quick-launch presets for mod loaders, DirectX modes, or custom arguments.')}</small></div><button type="button" class="secondary-btn" data-action="add-launch-profile">${ic('plus',14)} ${tr('Add profile')}</button></div><div id="launch-profiles-list" class="profiles-editor-list">${profiles.map((p,i)=>launchProfileRow(p,i)).join('')}</div></div>
  </div></details>
  <input type="hidden" id="game-cover" name="cover" value="${esc(g?.cover||'')}"/><input type="hidden" id="game-banner" name="banner" value="${esc(g?.banner||'')}"/><input type="hidden" id="game-icon" name="icon" value="${esc(g?.icon||'')}"/>
  </div><div class="dialog-footer"><button type="button" class="secondary-btn" data-action="close-modal">${tr('Cancel')}</button><button type="submit" class="primary-btn">${ic('check',16)} ${tr(isEdit?'Save changes':'Add to library')}</button></div></form>`, '',true);
}
function detail(g){if(!g)return dialogFrame(t('Game unavailable'),t('This game no longer exists.'),`<div class="dialog-body">${tr('Please refresh the library.')}</div>`);
 const tags=(g.tags||[]).map(tag=>`<span class="detail-tag">${esc(tag)}</span>`).join('');
 const cols=state.collections.filter(c=>Array.isArray(c.game_ids)&&c.game_ids.includes(g.id));
 const colBadges=cols.map(c=>`<span class="detail-tag detail-col-tag" ${c.color?`style="--col-dot:${esc(c.color)}"`:''}>${ic(c.icon||'folder',12)} ${esc(c.name)}</span>`).join('');
 const statusBadge=g.play_status?`<span class="detail-tag status-pill status-${esc(g.play_status)}">${esc(statusLabel(g.play_status))}</span>`:'';
 const hiddenBadge=g.hidden?`<span class="detail-tag status-pill status-hidden">${tr('Hidden')}</span>`:'';
 const profiles=Array.isArray(g.launch_profiles)?g.launch_profiles:[];
 const playing=state.runningIds.includes(g.id);
 const banner=artwork(g.banner),cover=artwork(g.cover);
 const backdrop=banner||cover;
 const isAppsFolder=/^shell:appsfolder\\/i.test(String(g.launch_uri||''));
 const launchNote=isAppsFolder?t('Launched via Windows AppsFolder (Xbox / Microsoft Store). Orbit tracks playtime after the game process starts.'):g.source==='xbox'?t('Some PC Game Pass titles require the Xbox app to launch and may not start from a direct EXE.'):g.launch_uri?t('Launched through {source}. Playtime is confirmed after Orbit detects the game process.',{source:sourceLabel(g)}):g.executable?t('Playtime updates after your session ends while Orbit is running.'):t('Choose an executable or launcher URI in Edit details to play.');
 return `<div class="dialog-scrim showcase-scrim" data-action="scrim"><section class="dialog detail-showcase" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="showcase-summary">
  <div class="showcase-hero ${banner?'has-banner':cover?'has-cover-backdrop':'no-artwork'}">
   ${backdrop?`<img class="showcase-hero-art ${banner?'showcase-hero-banner':'showcase-hero-cover'}" src="${backdrop}" alt="" decoding="async" />`:''}
   <div class="showcase-hero-shade" aria-hidden="true"></div>
   <div class="showcase-topline"><span class="showcase-eyebrow">${ic('sparkles',13)} ${tr('ORBIT SHOWCASE')}</span><button type="button" class="showcase-close" data-action="close-modal" aria-label="${tr('Close game details')}">${ic('close',20)}</button></div>
   <div class="showcase-hero-copy"><span class="showcase-source">${esc(sourceLabel(g))}${playing?` · ${tr('Playing now')}`:''}</span><h2 id="dialog-title">${esc(g.name)}</h2><p id="showcase-summary">${tr('In your library since {date}',{date:formatDate(g.created_at)})}</p></div>
  </div>
  <div class="showcase-content"><div class="showcase-poster"><div class="cover">${coverImage(g,true)}<span class="cover-letter">${esc(g.name.slice(0,2))}</span></div></div>
   <div class="showcase-information"><div class="showcase-tags">${statusBadge}${hiddenBadge}${g.genre?`<span class="detail-tag">${esc(g.genre)}</span>`:''}${colBadges}${tags||(!statusBadge&&!colBadges?`<span class="detail-tag">${tr('In your collection')}</span>`:'')}</div>
    <div class="showcase-stats"><div class="detail-playtime"><div class="detail-playtime-label">${ic('clock',15)} ${tr('PLAYTIME')}${playing?`<span class="detail-live">${tr('● Playing now')}</span>`:''}</div><strong class="detail-playtime-value">${esc(playing&&!g.total_play_seconds?t('First session in progress'):timeLabel(g.total_play_seconds))}</strong><span class="detail-playtime-caption">${tr(playing?'Session time will be added when the game closes':'Recorded game time')}</span></div>
     <div class="showcase-last-played"><span class="showcase-stat-label">${ic('clock',15)} ${tr('LAST PLAYED')}</span><strong>${esc(formatDate(g.last_played_at))}</strong><span>${tr(g.last_played_at?'Last recorded session':'Ready for your first session')}</span></div></div>
    <div class="showcase-actions"><button type="button" class="primary-btn showcase-play" data-action="launch" data-id="${esc(g.id)}">${ic('play',20)} <span>${tr('Play game')}</span>${ic('arrow',19)}</button><button type="button" class="secondary-btn showcase-favorite ${g.favorite?'is-favorite':''}" data-action="favorite" data-id="${esc(g.id)}" aria-pressed="${!!g.favorite}">${ic('heart',18)} ${tr(g.favorite?'Favorited':'Add to favorites')}</button><div class="select-wrap showcase-status-wrap"><select id="detail-status-select" data-id="${esc(g.id)}" aria-label="${tr('Play status')}"><option value="" ${!g.play_status?'selected':''}>${tr('No status')}</option>${PLAY_STATUSES.map(([code,label])=>`<option value="${code}" ${g.play_status===code?'selected':''}>${tr(label)}</option>`).join('')}</select></div></div>
    ${profiles.length?`<div class="showcase-profiles" role="group" aria-label="${tr('Alternative launch profiles')}">${profiles.map(p=>`<button type="button" class="secondary-btn showcase-profile-btn" data-action="launch-profile" data-id="${esc(g.id)}" data-profile="${esc(p.id)}">${ic('lightning',14)} ${esc(p.name)}</button>`).join('')}</div>`:''}
    <div class="showcase-manage"><button type="button" class="secondary-btn" data-action="game-collections" data-id="${esc(g.id)}">${ic('folder',15)} ${tr('Collections')}${cols.length?` (${formatNumber(cols.length)})`:''}</button><button type="button" class="secondary-btn" data-action="edit" data-id="${esc(g.id)}">${ic('edit',15)} ${tr('Edit game')}</button><details class="showcase-more-menu"><summary class="showcase-more-summary">${ic('dots',15)} ${tr('More')}</summary><div class="showcase-more-panel">${(g.install_path||g.executable)?`<button type="button" class="showcase-more-item" data-action="open-folder" data-id="${esc(g.id)}">${ic('folder',15)} ${tr('Open game location')}</button>`:''}<button type="button" class="showcase-more-item" data-action="session-history" data-id="${esc(g.id)}">${ic('clock',15)} ${tr('Play sessions')}</button><button type="button" class="showcase-more-item" data-action="toggle-hide" data-id="${esc(g.id)}">${ic(g.hidden?'check':'close',15)} ${tr(g.hidden?'Unhide':'Hide')}</button></div></details><button type="button" class="danger-btn showcase-remove" data-action="remove-confirm" data-id="${esc(g.id)}">${ic('trash',15)} ${tr('Remove')}</button></div>
    <p class="showcase-note">${esc(launchNote)}</p>
    <div class="showcase-foot"><span title="${esc(g.install_path||g.executable||g.launch_uri||'')}">${ic('folder',14)} ${esc(g.install_path||g.executable||g.launch_uri||t('Location unavailable'))}</span></div>
   </div></div>
 </section></div>`;
}
function sessionDate(value){
 const date=new Date(value);
 if(!value||Number.isNaN(date.getTime()))return t('Unknown date');
 const options={dateStyle:'medium',timeStyle:'short'};
 return window.OrbitI18n?.formatDate?.(date,options)??new Intl.DateTimeFormat(undefined,options).format(date);
}
function sessionLimit(row){
 const elapsed=Math.floor((Date.parse(row.finished_at)-Date.parse(row.started_at))/1000);
 return Math.min(7*86400,elapsed);
}
function sessionHistoryDialog(modal){
 const game=state.games.find(game=>game.id===modal.id);
 const rows=modal.result?.rows||[];
 const editing=rows.find(row=>row.id===modal.editId);
 const maxSeconds=editing?Math.max(0,sessionLimit(editing)):0;
 const editHours=editing?Math.floor(editing.seconds/3600):0;
 const editMinutes=editing?Math.floor((editing.seconds%3600)/60):0;
 const body=editing?`<form id="session-correction-form" class="dialog-body">
  <p>${tr('Started {date}',{date:sessionDate(editing.started_at)})} · ${tr('Ended {date}',{date:sessionDate(editing.finished_at)})}</p>
  <div class="field-grid">
   <div class="field"><label for="session-hours">${tr('Hours')}</label><input id="session-hours" name="hours" type="number" min="0" max="${Math.floor(maxSeconds/3600)}" step="1" value="${editHours}" required /></div>
   <div class="field"><label for="session-minutes">${tr('Minutes')}</label><input id="session-minutes" name="minutes" type="number" min="0" max="59" step="1" value="${editMinutes}" required /></div>
  </div>
  <p class="setting-help">${tr('Enter up to {duration}. The original start and end times are kept.',{duration:statisticsTime(maxSeconds)})}</p>
  <div class="file-field"><button type="button" class="secondary-btn" data-action="session-cancel">${tr('Cancel')}</button><button type="submit" class="primary-btn">${tr('Save changes')}</button></div>
 </form>`: `<div class="dialog-body">
  ${modal.error?`<p role="alert">${esc(modal.error)}</p>`:!modal.result?`<p role="status">${tr('Reading your play sessions…')}</p>`:!rows.length?`<p>${tr('No completed game sessions have been recorded yet.')}</p>`:`<div class="import-list">${rows.map(row=>`<div class="import-item">
   <span style="flex:1;min-width:0"><strong>${esc(statisticsTime(row.seconds))}</strong><small>${tr('Started {date}',{date:sessionDate(row.started_at)})} · ${tr('Ended {date}',{date:sessionDate(row.finished_at)})}</small></span>
   ${sessionLimit(row)>=0?`<button type="button" class="secondary-btn" data-action="session-edit" data-id="${esc(row.id)}">${tr('Correct duration')}</button>`:''}
  </div>`).join('')}</div>`}
  ${modal.result&&(modal.page>0||modal.result.hasMore)?`<div class="import-toolbar"><button type="button" class="secondary-btn" data-action="session-page" data-id="previous" ${modal.page===0?'disabled':''}>${tr('Previous')}</button><button type="button" class="secondary-btn" data-action="session-page" data-id="next" ${modal.result.hasMore?'':'disabled'}>${tr('Next')}</button></div>`:''}
 </div>`;
 return dialogFrame(t('Play sessions'),game?.name||'',body,`<div class="dialog-footer"><button type="button" class="secondary-btn" data-action="detail" data-id="${esc(modal.id)}">${tr('Game details')}</button></div>`,true);
}
async function showSessionHistory(id,page=0){
 openModal('sessions',{id,page});
 const modal=state.modal;
 try{modal.result=await window.orbit.listSessions(id,page);}
 catch(error){modal.error=error.message||t('Could not retrieve recorded sessions.');}
 if(state.modal===modal)renderModal();
}
async function saveSessionCorrection(form){
 const modal=state.modal;
 if(modal?.type!=='sessions'||!modal.editId)return;
 const button=form.querySelector('[type=submit]');
 if(button.disabled)return;
 const sessionId=modal.editId;
 const editing=modal.result?.rows?.find(row=>row.id===sessionId);
 const maxSeconds=editing?Math.max(0,sessionLimit(editing)):0;
 const hours=form.elements.hours.valueAsNumber;
 const minutes=form.elements.minutes.valueAsNumber;
 if(!Number.isInteger(hours)||!Number.isInteger(minutes)||hours<0||minutes<0||minutes>59){
  toast(t('Enter up to {duration}. The original start and end times are kept.',{duration:statisticsTime(maxSeconds)}),true);
  return;
 }
 const seconds=hours*3600+minutes*60;
 if(seconds>maxSeconds){
  toast(t('Duration cannot exceed {duration}.',{duration:statisticsTime(maxSeconds)}),true);
  return;
 }
 button.disabled=true;
 try{
  await window.orbit.correctSession(modal.id,sessionId,seconds);
  if(state.modal===modal){
   modal.result.rows.find(row=>row.id===sessionId).seconds=seconds;
   if(modal.editId===sessionId)modal.editId=null;
   if(!modal.editId)renderModal();
  }
  if(state.route==='statistics')void loadStatistics();
 }catch(error){toast(error.message||t('Could not correct the session.'),true);button.disabled=false;}
}
const IMPORT_PAGE_SIZE=100;
const MAX_IMPORT_SELECTION=10000;
let discoveryView='available',hiddenDiscoveries=new Set(),savingDiscoveryIgnore=false,importingDiscovery=false;
function discoveryGroups(){
 const ignored=new Set(state.settings?.discoveryIgnored||[]);
 const groups={available:[],hidden:[],ignored:[]};
 for(const [index,game] of state.imports.entries()){
  const view=!game.alreadyAdded&&ignored.has(game.discoveryKey)?'ignored':hiddenDiscoveries.has(index)?'hidden':'available';
  groups[view].push({game,index});
 }
 return groups;
}
function importableDiscoveryIndices(){
 return discoveryGroups().available.filter(({game})=>!game.alreadyAdded).map(({index})=>index);
}
function discoveryShortcut(){
 if(!state.imports.some(game=>!game.alreadyAdded))return '';
 return `<button class="nav-item" data-action="review-discoveries" title="${tr('Review discoveries')}" aria-label="${tr('Review discoveries')}">${ic('refresh',18)}<span>${tr('Review discoveries')}</span></button>`;
}
function updateDiscoveryShortcut(){
 const slot=el('discovery-shortcut');if(slot)slot.innerHTML=discoveryShortcut();
}
function formatUpdateStatus(status){
 if(!status)return t('Checking availability…');
 const busy=!!(state.runningIds?.length||state.pendingLaunches?.size);
 if(status.state==='downloading'){
  if(Number.isFinite(status.progressPercent)&&status.version)return t('Downloading v{version} ({percent}%)…',{version:status.version,percent:formatNumber(status.progressPercent)});
  if(status.version)return t('Downloading v{version}…',{version:status.version});
 }
 if(status.state==='ready'&&status.version){
  return busy?t('Update v{version} is ready. Finish running games to install.',{version:status.version}):t('Update v{version} is ready to install.',{version:status.version});
 }
 if(status.state==='installing'&&status.version)return t('Installing v{version}…',{version:status.version});
 return t(status.message||'Checking availability…');
}
function updateDotClass(status){
 const kind=status?.state||'idle';
 if(kind==='ready')return 'update-state-dot is-ready';
 if(kind==='downloading'||kind==='checking'||kind==='installing')return 'update-state-dot is-active';
 if(kind==='error')return 'update-state-dot is-error';
 if(kind==='up-to-date')return 'update-state-dot is-ok';
 return 'update-state-dot';
}
function updateProgressMarkup(status,compact=false){
 if(status?.state!=='downloading')return '';
 const hasPct=Number.isFinite(status.progressPercent);
 const pct=hasPct?Math.max(0,Math.min(100,status.progressPercent)):0;
 return `<div class="update-progress-wrap ${compact?'is-compact':''}"><progress class="update-progress" max="100" ${hasPct?`value="${pct}"`:''} aria-label="${tr('Update download progress')}"></progress></div>`;
}
function updateActionButtons(status){
 const busy=!!(state.runningIds?.length||state.pendingLaunches?.size);
 const checking=['checking','downloading','installing'].includes(status?.state);
 const checkLabel=status?.state==='checking'?tr('Checking…'):tr('Check now');
 const checkBtn=`<button type="button" class="secondary-btn update-check-btn ${checking?'is-busy':''}" data-action="check-update" ${checking?'disabled aria-busy="true"':''}>${ic('refresh',15)}<span>${checkLabel}</span></button>`;
 if(status?.state==='ready'){
  const installBtn=`<button type="button" class="primary-btn update-install-btn" data-action="install-update" ${busy?'disabled aria-disabled="true"':''} title="${busy?tr('Finish running games before installing an update.'):tr('Install verified update and restart Orbit')}">${ic(busy?'clock':'download',15)}<span>${tr(busy?'Game running…':'Install & restart')}</span></button>`;
  return `${installBtn}${checkBtn}`;
 }
 return checkBtn;
}
function updateShortcut(){
 const status=state.updateStatus;
 if(!status||!['downloading','ready','installing'].includes(status.state))return '';
 const busy=!!(state.runningIds?.length||state.pendingLaunches?.size);
 if(status.state==='downloading'){
  const hasPct=Number.isFinite(status.progressPercent);
  const title=status.version?tr('Downloading v{version}',{version:status.version}):tr('Downloading update');
  const meta=hasPct?`${formatNumber(status.progressPercent)}%`:tr('In background');
  return `<button type="button" class="side-update-btn is-downloading" data-action="navigate" data-route="settings" title="${esc(formatUpdateStatus(status))}" aria-label="${esc(formatUpdateStatus(status))}"><span class="side-update-icon is-spinning">${ic('refresh',16)}</span><span class="side-update-copy"><span class="side-update-title">${title}</span><span class="side-update-sub">${esc(meta)}</span>${updateProgressMarkup(status,true)}</span></button>`;
 }
 if(status.state==='installing'){
  const title=status.version?tr('Installing v{version}…',{version:status.version}):tr('Installing update…');
  return `<button type="button" class="side-update-btn is-installing" disabled aria-busy="true" title="${title}" aria-label="${title}"><span class="side-update-icon is-spinning">${ic('refresh',16)}</span><span class="side-update-copy"><span class="side-update-title">${title}</span><span class="side-update-sub">${tr('Restarting Orbit')}</span></span></button>`;
 }
 const title=status.version?tr('Update to v{version}',{version:status.version}):tr('Install update');
 const sub=busy?tr('Finish game to install'):tr('Restart to install');
 const tip=busy?tr('Finish running games before installing an update.'):tr('Install verified update and restart Orbit');
 return `<button type="button" class="side-update-btn is-ready ${busy?'is-busy':''}" data-action="install-update" ${busy?'disabled aria-disabled="true"':''} title="${tip}" aria-label="${title} — ${sub}"><span class="side-update-icon">${ic(busy?'clock':'download',16)}<span class="side-update-dot" aria-hidden="true"></span></span><span class="side-update-copy"><span class="side-update-title">${title}</span><span class="side-update-sub">${sub}</span></span></button>`;
}
function syncUpdateUi(){
 const status=state.updateStatus;
 const shortcut=el('update-shortcut');if(shortcut)shortcut.innerHTML=updateShortcut();
 const dot=el('update-state-dot');if(dot)dot.className=updateDotClass(status);
 const statusEl=el('update-status');if(statusEl)statusEl.textContent=formatUpdateStatus(status);
 const progressEl=el('update-progress-slot');if(progressEl)progressEl.innerHTML=updateProgressMarkup(status);
 const actionsEl=el('update-action-slot');if(actionsEl)actionsEl.innerHTML=updateActionButtons(status);
 const toggle=document.querySelector('[data-action="setting-toggle"][data-key="autoUpdates"]');
 if(toggle){const locked=!status||status.state==='unsupported';toggle.disabled=locked;toggle.setAttribute('aria-disabled',String(locked));}
}
async function changeDiscoveryIgnore(index){
 const game=state.imports[index];
 if(savingDiscoveryIgnore||importingDiscovery||!game||game.alreadyAdded||!game.discoveryKey)return;
 const ignored=new Set(state.settings?.discoveryIgnored||[]);
 if(ignored.has(game.discoveryKey))ignored.delete(game.discoveryKey);else ignored.add(game.discoveryKey);
 if(ignored.size>1000){toast(t('The ignored entries list is full.'),true);return;}
 const review=state.imports;
 savingDiscoveryIgnore=true;
 try{
  await saveSettings({discoveryIgnored:[...ignored]});
  if(state.imports===review){
   for(const [i,candidate] of review.entries())if(candidate.discoveryKey===game.discoveryKey){
    state.selectedImports.delete(i);hiddenDiscoveries.delete(i);
   }
  }
 }finally{savingDiscoveryIgnore=false;if(state.modal?.type==='import')renderModal();}
}
function importDialog(){
 const groups=discoveryGroups(),games=groups[discoveryView],addable=groups.available.filter(({game})=>!game.alreadyAdded),selected=state.selectedImports.size;
 const pageCount=Math.max(1,Math.ceil(games.length/IMPORT_PAGE_SIZE));
 state.importPage=Math.min(state.importPage,pageCount-1);
 const first=state.importPage*IMPORT_PAGE_SIZE;
 const description=t('Found {total} installed games. {new} new entries can be imported.',{total:formatNumber(state.imports.length),new:formatNumber(addable.length)});
 const diagnostics=scanDiagnostics();
 const warnings=state.scanWarnings.length?`<div class="warning-line">${ic('alert',15)} ${esc(state.scanWarnings.slice(0,3).join(' • '))}${state.scanWarnings.length>3?` · ${tr('{count} more warnings',{count:formatNumber(state.scanWarnings.length-3)})}`:''}</div>`:'';
 const xboxNotice=games.some(({game})=>game.source==='xbox')?`<div class="warning-line">${ic('info',15)} ${tr('Some PC Game Pass games require the Xbox app to start, even when an installed executable is found.')}</div>`:'';
 const views=`<div class="import-toolbar import-review-controls" role="group" aria-label="${tr('Discovery results')}">${[['available','Available to review'],['hidden','Hidden this scan'],['ignored','Ignored discoveries']].map(([view,label])=>view==='available'||groups[view].length||discoveryView===view?`<button type="button" class="secondary-btn" data-action="discovery-view" data-id="${view}" data-view="${view}" aria-pressed="${discoveryView===view}">${tr(label)} (${formatNumber(groups[view].length)})</button>`:'').join('')}</div>`;
 const rows=games.slice(first,first+IMPORT_PAGE_SIZE).map(({game:g,index:i})=>{
  const action=(kind,label)=>`<button type="button" class="small-link" data-action="${kind}" data-id="${i}" aria-label="${esc(t('{action}: {name}',{action:t(label),name:g.name}))}">${tr(label)}</button>`;
  const hide=discoveryView==='ignored'?'':action('hide-discovery',discoveryView==='hidden'?'Show game':'Hide this scan');
  const ignore=g.discoveryKey?action('ignore-discovery',discoveryView==='ignored'?'Stop ignoring':'Ignore in future scans'):'';
  return `<div class="import-item import-review-item ${g.alreadyAdded?'added':''}"><label class="import-review-label">${discoveryView==='available'?`<input type="checkbox" data-import-index="${i}" ${state.selectedImports.has(i)?'checked':''} ${g.alreadyAdded?'disabled':''}/>`:''}<span class="icon-box">${ic(g.source==='steam'?'gamepad':'folder',18)}</span><span style="min-width:0;flex:1"><strong>${esc(g.name)}</strong><small>${esc(sourceLabel(g))} · ${esc(g.install_path||g.executable||t('Launcher entry'))}${g.alreadyAdded?` · ${tr('Already in library')}`:''}</small></span></label>${g.alreadyAdded?'':`<div class="import-review-actions">${hide}${ignore}</div>`}</div>`;
 }).join('');
 const paging=pageCount>1?`<div class="import-toolbar" aria-label="${tr('Import result pages')}"><span class="muted" style="font-size:12px">${tr('Showing {first}–{last} of {total} (page {page} of {pages})',{first:formatNumber(first+1),last:formatNumber(Math.min(games.length,first+IMPORT_PAGE_SIZE)),total:formatNumber(games.length),page:formatNumber(state.importPage+1),pages:formatNumber(pageCount)})}</span><div style="display:flex;gap:8px"><button class="secondary-btn" data-action="import-page" data-page="prev" ${state.importPage===0?'disabled':''}>${tr('Previous')}</button><button class="secondary-btn" data-action="import-page" data-page="next" ${state.importPage===pageCount-1?'disabled':''}>${tr('Next')}</button></div></div>`:'';
 const selectionHint=addable.length>MAX_IMPORT_SELECTION?`<p class="setting-help">${tr('Each import supports up to {limit} games. Import the selected games, then rescan to import the remaining titles.',{limit:formatNumber(MAX_IMPORT_SELECTION)})}</p>`:'';
 const empty=state.imports.length?emptyState(t('No games in this view'),t('Choose another discovery view to review the remaining games.')):emptyState(t('No installed games found'),t('Add your preferred library folders in Settings or add an executable manually.'),`<button class="secondary-btn" data-action="add">${ic('plus',15)} ${tr('Add manually')}</button>`);
 return dialogFrame(t('Discover installed games'),description,`<div class="dialog-body">${warnings}${xboxNotice}${diagnostics}${views}<div class="import-toolbar"><span class="muted" style="font-size:12px">${tr('{count} selected across all pages',{count:formatNumber(selected)})}</span>${discoveryView==='available'?`<button class="small-link" data-action="toggle-all-import">${tr(selected?'Deselect all':'Select all new')}</button>`:''}</div>${games.length?`<div class="import-list">${rows}</div>${paging}${selectionHint}`:empty}</div>`,`<div class="dialog-footer"><button class="secondary-btn" data-action="close-modal">${tr('Cancel')}</button><button class="primary-btn" data-action="import" ${selected?'':'disabled'}>${ic('download',16)} ${tr('Import')} ${formatNumber(selected)} ${tr(selected===1?'game':'games')}</button></div>`,true);
}
function collectionsDialog(modal){
 const editing=modal.editId?state.collections.find(c=>c.id===modal.editId):null;
 const colorRadios=(selected,name='color')=>`<div class="col-picker-row" role="radiogroup" aria-label="${tr('Collection color')}">${palette.map(c=>`<label class="col-swatch-opt" style="--sw:${c}" title="${c}"><input type="radio" name="${name}" value="${c}" ${selected.toLowerCase()===c?'checked':''}/><span aria-hidden="true"></span></label>`).join('')}</div>`;
 const iconRadios=(selected,name='icon')=>`<div class="col-picker-row" role="radiogroup" aria-label="${tr('Collection icon')}">${COLLECTION_ICONS.map(icon=>`<label class="col-icon-opt" title="${icon}"><input type="radio" name="${name}" value="${icon}" ${selected===icon?'checked':''}/>${ic(icon,16)}</label>`).join('')}</div>`;
 const list=state.collections.length?`<div class="collections-manage-list">${state.collections.map(col=>{
  if(editing&&editing.id===col.id){
   return `<form id="collection-edit-form" data-id="${esc(col.id)}" class="collection-edit-card">
    <div class="field"><label for="edit-col-name">${tr('Collection name')}</label><input id="edit-col-name" name="name" type="text" maxlength="60" value="${esc(col.name)}" required /></div>
    ${colorRadios(col.color||palette[0])}
    ${iconRadios(col.icon||'folder')}
    <div class="collection-edit-actions"><button type="button" class="secondary-btn" data-action="cancel-edit-collection">${tr('Cancel')}</button><button type="submit" class="primary-btn">${tr('Save changes')}</button></div>
   </form>`;
  }
  const count=(col.game_ids||[]).length;
  const confirming=modal.confirmDeleteId===col.id;
  return `<div class="collection-manage-row"><span class="col-nav-icon" ${col.color?`style="color:${esc(col.color)}"`:''}>${ic(col.icon||'folder',18)}</span><div class="collection-manage-meta"><strong>${esc(col.name)}</strong><small>${formatNumber(count)} ${tr(count===1?'game':'games')}</small></div><div class="collection-manage-actions">${confirming?`<span class="collection-confirm-text">${tr('Delete?')}</span><button type="button" class="secondary-btn" data-action="cancel-delete-collection">${tr('Cancel')}</button><button type="button" class="danger-btn" data-action="confirm-delete-collection" data-id="${esc(col.id)}">${tr('Delete')}</button>`:`<button type="button" class="secondary-btn" data-action="edit-collection" data-id="${esc(col.id)}">${ic('edit',14)} ${tr('Edit')}</button><button type="button" class="danger-btn" data-action="delete-collection" data-id="${esc(col.id)}" aria-label="${tr('Delete {name}',{name:col.name})}">${ic('trash',14)}</button>`}</div></div>`;
 }).join('')}</div>`:`<p class="setting-help">${tr('No custom collections yet. Create one below to group games across storefronts.')}</p>`;
 return dialogFrame(t('Custom collections'),t('Organize games into shelves that stay synced across backups.'),`<div class="dialog-body">${list}
  <form id="collection-create-form" class="collection-create-card">
   <h3>${tr('New collection')}</h3>
   <div class="field"><label for="new-col-name">${tr('Collection name')}</label><input id="new-col-name" name="name" type="text" maxlength="60" placeholder="${tr('Co-op Night, Steam Deck, Weekend…')}" required /></div>
   ${colorRadios(state.settings?.accent||palette[0])}
   ${iconRadios('folder')}
   <div><button type="submit" class="primary-btn">${ic('plus',15)} ${tr('Create collection')}</button></div>
  </form></div>`,`<div class="dialog-footer"><button type="button" class="secondary-btn" data-action="close-modal">${tr('Done')}</button></div>`,true);
}
function gameCollectionsDialog(modal){
 const game=state.games.find(g=>g.id===modal.id);
 if(!game)return dialogFrame(t('Game unavailable'),t('This game no longer exists.'),`<div class="dialog-body"></div>`);
 const assigned=new Set(gameCollectionIds(game.id));
 const list=state.collections.length?`<div class="collection-checklist">${state.collections.map(col=>`<label class="collection-check-item"><input type="checkbox" data-game-col-id="${esc(col.id)}" data-game-id="${esc(game.id)}" ${assigned.has(col.id)?'checked':''}/><span class="col-nav-icon" ${col.color?`style="color:${esc(col.color)}"`:''}>${ic(col.icon||'folder',16)}</span><span class="collection-check-name">${esc(col.name)}</span><span class="muted">${formatNumber((col.game_ids||[]).length)}</span></label>`).join('')}</div>`:`<p class="setting-help">${tr('No custom collections yet. Create one below.')}</p>`;
 return dialogFrame(t('Collections'),game.name,`<div class="dialog-body">${list}
  <form id="quick-collection-form" data-game-id="${esc(game.id)}" class="quick-collection-form"><div class="file-field"><input type="text" name="name" maxlength="60" placeholder="${tr('New collection name…')}" required aria-label="${tr('New collection name…')}" /><button type="submit" class="secondary-btn">${ic('plus',15)} ${tr('Create & add')}</button></div></form></div>`,
  `<div class="dialog-footer"><button type="button" class="secondary-btn" data-action="manage-collections">${tr('Manage collections')}</button><button type="button" class="primary-btn" data-action="close-modal">${tr('Done')}</button></div>`);
}
function bulkCollectionsDialog(){
 const count=state.selectedGames.size;
 const list=state.collections.length?`<div class="collections-manage-list">${state.collections.map(col=>`<div class="collection-manage-row"><span class="col-nav-icon" ${col.color?`style="color:${esc(col.color)}"`:''}>${ic(col.icon||'folder',18)}</span><div class="collection-manage-meta"><strong>${esc(col.name)}</strong><small>${formatNumber((col.game_ids||[]).length)} ${tr((col.game_ids||[]).length===1?'game':'games')}</small></div><div class="collection-manage-actions"><button type="button" class="secondary-btn" data-action="bulk-add-collection" data-id="${esc(col.id)}">${ic('plus',14)} ${tr('Add')}</button><button type="button" class="secondary-btn" data-action="bulk-remove-collection" data-id="${esc(col.id)}">${ic('close',14)} ${tr('Remove')}</button></div></div>`).join('')}</div>`:`<p class="setting-help">${tr('No custom collections yet. Create one below.')}</p>`;
 return dialogFrame(t('Bulk collections'),t('Update collections for {count} selected games.',{count:formatNumber(count)}),`<div class="dialog-body">${list}
  <form id="quick-collection-form" data-bulk="true" class="quick-collection-form"><div class="file-field"><input type="text" name="name" maxlength="60" placeholder="${tr('New collection name…')}" required aria-label="${tr('New collection name…')}" /><button type="submit" class="secondary-btn">${ic('plus',15)} ${tr('Create & add')}</button></div></form></div>`,
  `<div class="dialog-footer"><button type="button" class="secondary-btn" data-action="close-modal">${tr('Done')}</button></div>`);
}
function bulkTagsDialog(){
 const count=state.selectedGames.size;
 return dialogFrame(t('Bulk edit tags'),t('Add or remove comma-separated tags for {count} selected games.',{count:formatNumber(count)}),`<form id="bulk-tags-form"><div class="dialog-body">
  <div class="field"><label for="bulk-add-tags">${tr('Add tags')}</label><input id="bulk-add-tags" name="add_tags" type="text" placeholder="${tr('Co-op, Story, Indie')}" /></div>
  <div class="field"><label for="bulk-remove-tags">${tr('Remove tags')}</label><input id="bulk-remove-tags" name="remove_tags" type="text" placeholder="${tr('Backlog, Unfinished')}" /></div>
 </div><div class="dialog-footer"><button type="button" class="secondary-btn" data-action="close-modal">${tr('Cancel')}</button><button type="submit" class="primary-btn">${ic('check',15)} ${tr('Apply tags')}</button></div></form>`);
}
function renderModal(){const modal=state.modal;if(!modal){el('modal-root').innerHTML='';return}let html='';
 if(modal.type==='game')html=editor(modal.id?state.games.find(g=>g.id===modal.id):null);
 else if(modal.type==='detail')html=detail(state.games.find(g=>g.id===modal.id));
 else if(modal.type==='sessions')html=sessionHistoryDialog(modal);
 else if(modal.type==='collections')html=collectionsDialog(modal);
 else if(modal.type==='game-collections')html=gameCollectionsDialog(modal);
 else if(modal.type==='bulk-collections')html=bulkCollectionsDialog();
 else if(modal.type==='bulk-tags')html=bulkTagsDialog();
 else if(modal.type==='scan')html=dialogFrame(t('Scanning your games'),t('Looking through installed launchers and selected library folders.'),`<div class="dialog-body" style="display:grid;place-items:center;min-height:200px;text-align:center;color:var(--muted)"><div>${ic('refresh',42)}<p>${tr('Scanning local manifests and folders…')}</p></div></div>`);
 else if(modal.type==='import')html=importDialog();
 else if(modal.type==='whats-new')html=whatsNewDialog();
 else if(modal.type==='bulk-remove'){const count=state.selectedGames.size;html=dialogFrame(t('Remove {count} games?',{count:formatNumber(count)}),t('Remove the selected games from Orbit. Installed files will remain untouched.'),`<div class="dialog-body"><p style="color:var(--muted)">${tr('This removes the selected library entries, custom metadata and tracked play time. It does not uninstall any games.')}</p></div>`,`<div class="dialog-footer"><button type="button" class="secondary-btn" data-action="close-modal">${tr('Cancel')}</button><button type="button" class="danger-btn" data-action="bulk-remove">${ic('trash',15)} ${tr('Remove {count} games',{count:formatNumber(count)})}</button></div>`);}
 else if(modal.type==='restore-confirm'){html=dialogFrame(t('Restore from backup?'),t('Import games, collections, artwork and play history from a backup file.'),`<div class="dialog-body"><p style="color:var(--muted)">${tr('Restore merges the backup into your current library. Existing games are kept and matching entries are skipped.')}</p></div>`,`<div class="dialog-footer"><button type="button" class="secondary-btn" data-action="close-modal">${tr('Cancel')}</button><button type="button" class="primary-btn" data-action="restore-confirmed">${ic('upload',15)} ${tr('Choose backup file')}</button></div>`);}
 else if(modal.type==='remove'){const g=state.games.find(x=>x.id===modal.id);html=dialogFrame(t('Remove from library?'),t('Remove {name} from Orbit. Installed files will remain untouched.',{name:g?.name||t('this game')}),`<div class="dialog-body"><p style="color:var(--muted)">${tr('This removes the library entry, custom metadata and tracked play time. It does not uninstall the game.')}</p></div>`,`<div class="dialog-footer"><button class="secondary-btn" data-action="close-modal">${tr('Keep game')}</button><button class="danger-btn" data-action="remove" data-id="${esc(modal.id)}">${ic('trash',15)} ${tr('Remove game')}</button></div>`)}
 const root=el('modal-root'),active=document.activeElement;
 const previousFocus=root.contains(active)?{action:active.dataset.action,id:active.dataset.id}:null;
 if(el('app'))el('app').inert=true;
 root.innerHTML=html;
 syncActivity();
 const dialog=root.querySelector('.dialog');if(dialog){dialog.setAttribute('tabindex','-1');const keepFocus=previousFocus?.action?[...dialog.querySelectorAll('[data-action]')].find(node=>node.dataset.action===previousFocus.action&&node.dataset.id===previousFocus.id):null;(keepFocus||dialog).focus({preventScroll:true});}
}
async function performScan(background=false){
 if(importingDiscovery||savingDiscoveryIgnore)return;
 if(!background)openModal('scan');
 if(state.scanning)return;
 state.scanning=true;syncActivity();
 try{
  const results=await window.orbit.discoverGames(background);
  if(!results)return;
  state.imports=results.games;state.importPage=0;state.scanWarnings=results.warnings||[];state.scanDiagnostics=results.diagnostics||[];
  discoveryView='available';hiddenDiscoveries=new Set();
  state.selectedImports=new Set(importableDiscoveryIndices().slice(0,MAX_IMPORT_SELECTION));
  updateDiscoveryShortcut();
  if(state.modal?.type==='scan')openModal('import');
 }catch(e){
  if(state.modal?.type==='scan'){closeModal();toast(e.message||t('Scan failed'),true);}
 }finally{state.scanning=false;syncActivity();}
}
async function performImport(){
 if(savingDiscoveryIgnore||importingDiscovery)return;
 const available=new Set(importableDiscoveryIndices());
 const entries=new Set([...state.selectedImports].filter(i=>available.has(i)));
 const games=[...entries].map(i=>state.imports[i]).map(({alreadyAdded,discoveryKey,...rest})=>rest);if(!games.length)return;
 const button=el('modal-root').querySelector('[data-action=import]');if(button)button.disabled=true;
 const review=state.imports,modal=state.modal;
 importingDiscovery=true;
 try{
  const result=await window.orbit.importGames(games);
  if(state.imports===review&&!result.errors.length){
   state.imports=review.map((game,index)=>entries.has(index)?{...game,alreadyAdded:true}:game);
   state.selectedImports.clear();updateDiscoveryShortcut();
  }
  if(state.modal===modal)closeModal();
  toast(t('Imported {count} games.{skipped}',{count:formatNumber(result.imported),skipped:result.skipped?' '+t('{count} already in library.',{count:formatNumber(result.skipped)}):''}));
  if(result.errors.length)toast(result.errors.slice(0,3).join(' · '),true);
 }
 catch(e){toast(e.message||t('Import failed.'),true);if(button)button.disabled=false}
 finally{importingDiscovery=false;}
}
function scanDiagnostics(){
 if(!state.scanDiagnostics.length)return '';
 const names={...sourceNames,'gog-registry':'GOG registry',heroic:'Heroic',legendary:'Legendary','windows-stores':'Windows launchers',folder:'Selected folders'};
 return `<details class="scan-diagnostics"><summary>${tr('Scan report')} <span>${formatNumber(state.scanDiagnostics.length)} ${tr('locations checked')}</span></summary><div class="diagnostics-list">${state.scanDiagnostics.map(d=>`<div class="diagnostic ${['ok','warning','error'].includes(d.status)?d.status:'warning'}"><div><span class="diagnostic-status">${ic(d.status==='ok'?'check':d.status==='error'?'close':'alert',14)}</span><strong>${tr(names[d.provider]||d.provider)}</strong><span>${formatNumber(Number(d.games)||0)} ${tr('games')} · ${formatNumber(Math.max(0,Math.round(Number(d.durationMs)||0)))} ms</span></div>${d.path?`<p title="${esc(d.path)}">${esc(d.path)}</p>`:''}${(Array.isArray(d.warnings)?d.warnings:[]).map(w=>`<p>${esc(w)}</p>`).join('')}</div>`).join('')}</div></details>`;
}
function syncActivity(){
 document.body.dataset.gameActive=String(state.runningIds.length>0);
 for(const button of document.querySelectorAll('[data-action="launch"]')){
  const pending=state.pendingLaunches.has(button.dataset.id),running=state.runningIds.includes(button.dataset.id);
  button.classList.toggle('launch-pending',pending);
  button.classList.toggle('launch-running',running);
  if(pending||running){if(!button.dataset.restHtml)button.dataset.restHtml=button.innerHTML;button.innerHTML=ic(pending?'refresh':'check',16)+(button.matches('.continue-play')?'':pending?' '+tr('Starting…'):' '+tr('Playing'));button.disabled=true;button.setAttribute('aria-busy',String(pending));button.setAttribute('title',t(pending?'Starting game…':'Game is running'));}
  else if(button.dataset.restHtml){button.innerHTML=button.dataset.restHtml;delete button.dataset.restHtml;button.disabled=false;button.removeAttribute('aria-busy');button.removeAttribute('title');}
 }
 for(const button of document.querySelectorAll('[data-action="shuffle"]'))button.disabled=state.games.length===0;
 for(const button of document.querySelectorAll('[data-action="scan"]')){button.setAttribute('aria-busy',String(state.scanning));button.classList.toggle('is-scanning',state.scanning);button.title=t(state.scanning?'Scanning installed games…':'Find installed games');}
 const status=document.querySelector('.side-version>span:last-child');if(status)status.innerHTML=state.scanning?tr('Scanning your games…'):`${tr('Local library')} <span class="version-number">v${esc(state.version)}</span>`;
 controllerMode?.update();
 wakeDesktopPadEntry();
}
const launchTimers=new Map();
function clearLaunchPending(id){
 const timer=launchTimers.get(id);
 if(timer!==undefined)clearTimeout(timer);
 launchTimers.delete(id);
 state.pendingLaunches.delete(id);
}
function waitForLaunchConfirmation(id,waitMs,reportTimeout=true){
 if(typeof id!=='string'||!Number.isFinite(waitMs)||waitMs<=0||state.runningIds.includes(id))return;
 clearLaunchPending(id);
 state.pendingLaunches.add(id);
 launchTimers.set(id,setTimeout(()=>{
  clearLaunchPending(id);
  syncActivity();
  if(reportTimeout&&!state.runningIds.includes(id))toast(t('Orbit could not confirm the game started. Check your game launcher before retrying.'),true);
 },Math.min(waitMs,90000)));
 syncActivity();
}
async function performLaunch(id,profileId=null){
 const game=state.games.find(g=>g.id===id);
 if(!game||state.pendingLaunches.has(id)||state.runningIds.includes(id))return;
 const started=performance.now();
 state.pendingLaunches.add(id);
 try{
  const launch=profileId?window.orbit.launchGame(id,profileId):window.orbit.launchGame(id);syncActivity();
  const result=await launch;
  if(result.confirmationTimeoutMs>0){
   if(!launchTimers.has(id))waitForLaunchConfirmation(id,result.confirmationTimeoutMs);
  }else{
   toast(result.message||t('Launched {name}',{name:game.name}));
   waitForLaunchConfirmation(id,Math.max(1,650-(performance.now()-started)),false);
  }
  return result;
 }catch(e){
  clearLaunchPending(id);syncActivity();
  toast(e.message||t('Could not launch {name}',{name:game.name}),true);
 }
}
async function favorite(id){try{await window.orbit.favoriteGame(id)}catch(e){toast(e.message,true)}}
function collectLaunchProfiles(form){
 const rows=[...form.querySelectorAll('[data-profile-row]')];
 const profiles=[];
 for(const row of rows){
  const get=name=>row.querySelector(`[data-profile-field="${name}"]`)?.value||'';
  const name=get('name').trim(),executable=get('executable').trim(),launch_uri=get('launch_uri').trim(),working_dir=get('working_dir').trim(),argsRaw=get('launch_args').trim(),envRaw=get('launch_env').trim();
  if(!name&&!executable&&!launch_uri&&!working_dir&&!argsRaw&&!envRaw)continue;
  if(!name)throw Error(t('Each launch profile requires a name.'));
  let launch_args;
  try{launch_args=parseLaunchArgsInput(argsRaw);}catch{throw Error(t('Check unmatched quotes or invalid JSON in launch arguments.'));}
  const launch_env=parseEnvText(envRaw);
  profiles.push({id:row.dataset.profileId||'',name,executable,launch_uri,launch_args,working_dir,launch_env});
 }
 return profiles;
}
async function storeGame(form){
 for(const field of form.querySelectorAll('input,select,textarea'))clearFieldError(field);
 const data=Object.fromEntries(new FormData(form));data.tags=String(data.tags||'').split(',').map(tag=>tag.trim()).filter(Boolean);
 if(!String(data.name||'').trim()){setFieldError(el('game-name'),t('Enter a game title.'));return;}
 if(!data.executable?.trim()&&!data.launch_uri?.trim()){setFieldError(el('game-executable'),t('Choose an executable or enter a supported game-launch URI.'));return;}
 try{data.launch_args=parseLaunchArgsInput(data.launch_args);}catch{setFieldError(el('game-args'),t('Check unmatched quotes or invalid JSON in launch arguments.'));return}
 try{data.launch_env=parseEnvText(data.launch_env);}catch(e){setFieldError(el('game-env'),e.message);return}
 try{data.launch_profiles=collectLaunchProfiles(form);}catch(e){
  const list=el('launch-profiles-list');
  const firstEmpty=list?.querySelector('[data-profile-field="name"]')||el('game-args');
  const parentDetails=firstEmpty?.closest('details.editor-section');
  if(parentDetails)parentDetails.open=true;
  firstEmpty?.focus();
  toast(e.message,true);return;
 }
 const button=form.querySelector('[type=submit]');button.disabled=true;
 try{if(form.dataset.id)await window.orbit.updateGame(form.dataset.id,data);else await window.orbit.addGame({...data,source:'manual'});closeModal();toast(t(form.dataset.id?'Game updated.':'Game added to your library.'));}
 catch(e){toast(e.message||t('Could not save game.'),true)}finally{button.disabled=false}
}
async function detectGameFile(file){
 const modal=state.modal;
 const status=el('game-detection-status');
 if(!status || modal?.type!=='game')return;
 status.textContent=t('Looking for local artwork and executable icon…');
 try{
  const found=await window.orbit.inspectGameFile(file);
  if(state.modal!==modal || !el('game-form') || el('game-executable')?.value!==file)return;
  const title=el('game-name');
  // Preserve names edited by the user. Replace only an empty title, a prior
  // automatic suggestion, or an unrecognized raw executable name.
  if(title&&(!title.value.trim()||title.value===title.dataset.detectedName||title.value.trim().toLowerCase()===String(found.suggested_name||'').toLowerCase())){
   title.value=found.name;title.dataset.detectedName=found.name;
  }
  const workdir=el('game-workdir');
  if(workdir&&!workdir.value.trim())workdir.value=found.working_dir;
  let artworkFound=false;
  for(const kind of ['cover','icon']){
   const token=found[kind];
   const input=el(`game-${kind}`);
   if(!artwork(token)||!input||input.value)continue;
   input.value=token;
   const preview=el(`preview-${kind}`);
   if(preview)preview.innerHTML=`<img src="${artwork(token)}" alt="${tr('Detected {kind} preview',{kind})}"/>`;
   artworkFound=true;
  }
  const nameMessage=found.recognized?t('Recognized as {name}. ',{name:found.name}):'';
  const artMessage=t(found.cover_source==='steam'?'Cover downloaded from Steam.':found.cover?'Cover found in game folder.':found.icon?'Game icon detected.':'No artwork found; you can add your own.');
  status.textContent=nameMessage+artMessage;
  if(artworkFound&&!found.cover&&found.icon){
   const preview=el('preview-cover');
   if(preview&&!el('game-cover').value)preview.innerHTML=`<div class="auto-icon-preview"><img src="${artwork(found.icon)}" alt="${tr('Icon fallback')}" /></div>`;
  }
 }catch(e){if(state.modal===modal){status.textContent=t('Artwork detection unavailable.');toast(e.message||t('Could not inspect this executable.'),true)}}
}
function toggleGameSelection(id,shiftKey=false){
 if(!id)return;
 if(shiftKey&&state.lastSelectedId&&state.viewGames.length){
  const list=state.viewGames.map(g=>g.id);
  const a=list.indexOf(state.lastSelectedId),b=list.indexOf(id);
  if(a!==-1&&b!==-1){
   const [start,end]=a<b?[a,b]:[b,a];
   for(let i=start;i<=end;i++)state.selectedGames.add(list[i]);
   state.lastSelectedId=id;syncBulkDock();renderVirtual();return;
  }
 }
 if(state.selectedGames.has(id))state.selectedGames.delete(id);else state.selectedGames.add(id);
 state.lastSelectedId=id;syncBulkDock();renderVirtual();
}
async function applyBulkUpdate(patch,message){
 const ids=[...state.selectedGames];
 if(!ids.length)return;
 const result=await window.orbit.bulkUpdateGames(ids,patch);
 toast(message||t('Updated {count} games.',{count:formatNumber(result?.updatedCount??result?.updated??ids.length)}));
 syncBulkDock();
}
async function handleAction(button,event=null){const action=button.dataset.action,id=button.dataset.id;
 switch(action){
  case 'game-actions':openGameActions(button);break;
  case 'controller-mode':await toggleControllerMode();break;
  case 'whats-new':openModal('whats-new',{automatic:false});break;
  case 'check-update':{const status=await window.orbit.checkForUpdates();state.updateStatus=status;syncUpdateUi();break;}
  case 'install-update':try{await window.orbit.installUpdate()}catch(error){toast(error.message||t('Could not install update.'),true)}break;
  case 'navigate':navigate(button.dataset.route);break;
  case 'open-collection':navigate('library',id);break;
  case 'manage-collections':openModal('collections');break;
  case 'edit-collection':if(state.modal?.type==='collections'){state.modal.editId=id;state.modal.confirmDeleteId=null;renderModal();}break;
  case 'cancel-edit-collection':if(state.modal?.type==='collections'){state.modal.editId=null;renderModal();}break;
  case 'delete-collection':if(state.modal?.type==='collections'){state.modal.confirmDeleteId=id;state.modal.editId=null;renderModal();}break;
  case 'cancel-delete-collection':if(state.modal?.type==='collections'){state.modal.confirmDeleteId=null;renderModal();}break;
  case 'confirm-delete-collection':try{if(state.modal?.type==='collections')state.modal.confirmDeleteId=null;await window.orbit.deleteCollection(id);toast(t('Collection deleted.'));}catch(e){toast(e.message,true)}break;
  case 'game-collections':openModal('game-collections',{id});break;
  case 'launch-profile':await performLaunch(id,button.dataset.profile);break;
  case 'set-status':{
   const game=state.games.find(g=>g.id===id);if(!game)break;
   const next=game.play_status===button.dataset.status?'':button.dataset.status;
   try{await window.orbit.updateGame(id,{play_status:next});toast(next?t('Status set to {status}.',{status:statusLabel(next)}):t('Play status cleared.'));}catch(e){toast(e.message,true)}
   break;
  }
  case 'toggle-hide':{
   const game=state.games.find(g=>g.id===id);if(!game)break;
   try{await window.orbit.updateGame(id,{hidden:!game.hidden});toast(t(game.hidden?'Game restored to library.':'Game hidden from library.'));}catch(e){toast(e.message,true)}
   break;
  }
  case 'toggle-hidden-filter':{state.showHidden=!state.showHidden;const platforms=el('platform-filter-slot');if(platforms)platforms.innerHTML=platformFilters();syncLibraryFiltersUi();renderVirtual();break;}
  case 'toggle-select-mode':{state.selectMode=!state.selectMode;if(!state.selectMode){state.selectedGames.clear();state.lastSelectedId=null;}renderPage({keepScroll:true});break;}
  case 'toggle-select':toggleGameSelection(id,!!event?.shiftKey);break;
  case 'bulk-select-all':{for(const g of state.viewGames)state.selectedGames.add(g.id);syncBulkDock();renderVirtual();break;}
  case 'bulk-clear':{state.selectedGames.clear();state.lastSelectedId=null;syncBulkDock();renderVirtual();break;}
  case 'bulk-favorite':{
   const wantFav=button.dataset.favorite==='true';
   const ids=[...state.selectedGames].filter(gid=>{const g=state.games.find(x=>x.id===gid);return g&&!!g.favorite!==wantFav;});
   button.disabled=true;
   try{
    for(const gid of ids)await window.orbit.favoriteGame(gid);
    toast(t(wantFav?'Favorited {count} games.':'Removed {count} games from favorites.',{count:formatNumber(ids.length)}));
    syncBulkDock();
   }catch(e){toast(e.message,true)}finally{button.disabled=false}
   break;
  }
  case 'bulk-collections':if(state.selectedGames.size)openModal('bulk-collections');break;
  case 'bulk-tags':if(state.selectedGames.size)openModal('bulk-tags');break;
  case 'bulk-hide':{const hidden=button.dataset.hidden==='true';try{await applyBulkUpdate({hidden},t(hidden?'Hidden {count} games.':'Restored {count} games.',{count:formatNumber(state.selectedGames.size)}));}catch(e){toast(e.message,true)}break;}
  case 'bulk-remove-confirm':if(state.selectedGames.size)openModal('bulk-remove');break;
  case 'bulk-remove':{
   const ids=[...state.selectedGames];
   button.disabled=true;
   let removed=0;
   try{
    for(const gid of ids){await window.orbit.removeGame(gid);state.selectedGames.delete(gid);removed++;}
    closeModal();
    state.selectMode=false;state.lastSelectedId=null;
    toast(t('Removed {count} games from your library.',{count:formatNumber(removed)}));
    syncBulkDock();
   }catch(e){toast(e.message,true)}finally{button.disabled=false}
   break;
  }
  case 'bulk-add-collection':try{await applyBulkUpdate({add_collection_id:id},t('Added {count} games to collection.',{count:formatNumber(state.selectedGames.size)}));closeModal();}catch(e){toast(e.message,true)}break;
  case 'bulk-remove-collection':try{await applyBulkUpdate({remove_collection_id:id},t('Removed {count} games from collection.',{count:formatNumber(state.selectedGames.size)}));closeModal();}catch(e){toast(e.message,true)}break;
  case 'refresh-statistics':await loadStatistics();break;
  case 'shuffle':{const visible=state.games.filter(g=>!g.hidden);if(visible.length){const game=visible[Math.floor(Math.random()*visible.length)];openModal('detail',{id:game.id});}else toast(t('Add a game to your library first.'));break;}
  case 'platform':{state.filter=button.dataset.source;const slot=el('platform-filter-slot');if(slot){slot.innerHTML=platformFilters();slot.querySelector(`[data-action="platform"][data-source="${CSS.escape(state.filter)}"]`)?.focus({preventScroll:true});}renderVirtual();break;}
  case 'add':openModal('game');break;
  case 'edit':openModal('game',{id});break;
  case 'detail':openModal('detail',{id});break;
  case 'session-history':await showSessionHistory(id);break;
  case 'session-page':if(state.modal?.type==='sessions')await showSessionHistory(state.modal.id,state.modal.page+(id==='next'?1:-1));break;
  case 'session-edit':if(state.modal?.type==='sessions'){state.modal.editId=id;renderModal();el('session-hours')?.focus();}break;
  case 'session-cancel':if(state.modal?.type==='sessions'){state.modal.editId=null;renderModal();}break;
  case 'keep-editing':el('dirty-guard-bar')?.remove();el('game-name')?.focus();break;
  case 'force-close-modal':closeModal();break;
  case 'close-modal':requestCloseModal();break;
  case 'scrim':if(button.classList.contains('dialog-scrim'))requestCloseModal();break;
  case 'launch':await performLaunch(id);break;
  case 'favorite':await favorite(id);break;
  case 'remove-confirm':openModal('remove',{id});break;
  case 'remove':try{await window.orbit.removeGame(id);closeModal();toast(t('Game removed from your library.'))}catch(e){toast(e.message,true)}break;
  case 'scan':await performScan();break;
  case 'repair-artwork':{button.disabled=true;try{const result=await window.orbit.repairSteamArtwork();const note=result.onlineEnabled===false?t(' Online artwork is off in Settings.'):result.paused?t(' Online artwork was paused by Performance Guard during repair.'):'';toast(t('Updated {covers} portrait covers and {icons} game icons across {games} games.{note}',{covers:formatNumber(result.found),icons:formatNumber(result.icons||0),games:formatNumber(result.attempted),note}))}catch(e){toast(e.message||t('Cover repair failed.'),true)}finally{button.disabled=false}break;}
  case 'import':await performImport();break;
  case 'review-discoveries':if(state.imports.length)openModal('import');break;
  case 'toggle-all-import':{const allowed=importableDiscoveryIndices().slice(0,MAX_IMPORT_SELECTION);state.selectedImports=state.selectedImports.size?new Set():new Set(allowed);renderModal();break;}
  case 'discovery-view':discoveryView=button.dataset.view;state.importPage=0;renderModal();break;
  case 'hide-discovery':{
   const index=Number(id),game=state.imports[index];
   if(importingDiscovery||savingDiscoveryIgnore||!game||game.alreadyAdded)break;
   if(hiddenDiscoveries.has(index))hiddenDiscoveries.delete(index);else hiddenDiscoveries.add(index);
   state.selectedImports.delete(index);renderModal();break;
  }
  case 'ignore-discovery':await changeDiscoveryIgnore(Number(id));break;
  case 'reset-discovery-ignore':await saveSettings({discoveryIgnored:[]});break;
  case 'import-page':{
   const direction=button.dataset.page;
   state.importPage=Math.max(0,Math.min(Math.ceil(discoveryGroups()[discoveryView].length/IMPORT_PAGE_SIZE)-1,state.importPage+(direction==='next'?1:-1)));
   renderModal();
   const root=el('modal-root');
   const target=root.querySelector(`[data-action="import-page"][data-page="${direction}"]:not([disabled])`)
    ||root.querySelector('[data-action="import-page"]:not([disabled])')
    ||root.querySelector('[data-import-index]:not([disabled])')
    ||root.querySelector('.dialog [data-action="close-modal"]');
   target?.focus({preventScroll:true});
   break;
  }
  case 'choose-exe':{try{const file=await window.orbit.chooseExecutable();if(file){el('game-executable').value=file;const f=el('game-form');if(f)f.dataset.dirty='true';clearFieldError(el('game-executable'));await detectGameFile(file);}}catch(e){toast(e.message,true)}break;}
  case 'choose-workdir':{try{const dir=await window.orbit.chooseFolder();if(dir&&el('game-workdir')){el('game-workdir').value=dir;const f=el('game-form');if(f)f.dataset.dirty='true';}}catch(e){toast(e.message,true)}break;}
  case 'add-launch-profile':{
   const list=el('launch-profiles-list');if(!list)break;
   const existing=list.querySelectorAll('[data-profile-row]').length;
   if(existing>=12){toast(t('At most 12 launch profiles are allowed per game.'),true);break;}
   const tpl=document.createElement('template');tpl.innerHTML=launchProfileRow({},existing);
   const node=tpl.content.firstElementChild;list.appendChild(node);
   const f=el('game-form');if(f)f.dataset.dirty='true';
   node.querySelector('[data-profile-field="name"]')?.focus();
   break;
  }
  case 'remove-launch-profile':{const f=el('game-form');if(f)f.dataset.dirty='true';button.closest('[data-profile-row]')?.remove();break;}
  case 'choose-profile-exe':{try{const file=await window.orbit.chooseExecutable();const input=button.closest('[data-profile-row]')?.querySelector('[data-profile-field="executable"]');if(file&&input){input.value=file;const f=el('game-form');if(f)f.dataset.dirty='true';}}catch(e){toast(e.message,true)}break;}
  case 'find-art':{const file=el('game-executable')?.value?.trim();if(!file){toast(t('Choose a game executable first.'),true);break;}await detectGameFile(file);break;}
  case 'find-online-art':{
   const entered=el('cover-search-title')?.value?.trim()||'',gameTitle=el('game-name')?.value?.trim()||'';
   const name=entered||gameTitle;
   if(!name){toast(t('Enter the complete game title to search for its cover.'),true);break;}
   const modal=state.modal,status=el('cover-search-status'),oldCover=el('game-cover')?.value;
   if(status)status.textContent=t('Searching for an exact game title…');
   button.disabled=true;
   try{
    const found=await window.orbit.findOnlineCover(name);
    if(state.modal!==modal)return;
    if((el('cover-search-title')?.value.trim()||'')!==entered||(!entered&&el('game-name')?.value.trim()!==gameTitle)){if(status)status.textContent=t('Title changed. Search again.');return;}
    if(found.cover&&el('game-cover')?.value===oldCover){
     el('game-cover').value=found.cover;
     el('preview-cover').innerHTML=`<img src="${artwork(found.cover)}" alt="${tr('Cover found online')}"/>`;
     const f=el('game-form');if(f)f.dataset.dirty='true';
    }
    if(status)status.textContent=found.cover&&el('game-cover')?.value!==found.cover?t('Cover changed while searching; your selection was kept.'):found.message||t('No cover found.');
   }catch(e){if(status)status.textContent=e.message||t('Online artwork search unavailable.');toast(e.message,true)}
   finally{button.disabled=false}
   break;
  }
  case 'choose-art':{try{const file=await window.orbit.chooseArtwork();if(file){const key=button.dataset.key;el(`game-${key}`).value=file;el(`preview-${key}`).innerHTML=`<img src="${artwork(file)}" alt="${tr('Artwork preview')}"/>`;const f=el('game-form');if(f)f.dataset.dirty='true';}}catch(e){toast(e.message,true)}break;}
  case 'clear-art':{const key=button.dataset.key;const input=el(`game-${key}`),preview=el(`preview-${key}`);if(!input||!preview)break;input.value='';const fallback=key==='cover'?artwork(el('game-icon')?.value):null;preview.innerHTML=fallback?`<div class="auto-icon-preview"><img src="${fallback}" alt="${tr('Icon fallback')}" /></div>`:`<div class="image-placeholder">${ic('image',21)}</div>`;const f=el('game-form');if(f)f.dataset.dirty='true';break;}

  case 'open-folder':try{await window.orbit.openGameFolder(id)}catch(e){toast(e.message,true)}break;
  case 'open-data':try{await window.orbit.openAppData()}catch(e){toast(e.message,true)}break;
  case 'boot-retry':window.location.reload();break;
  case 'clear-filters':{state.query='';state.filter='all';state.status='all';state.collection='all';state.playtime='all';state.showHidden=false;state.tag='all';state.genre='all';const search=el('global-search');if(search)search.value='';const side=el('side-slot');if(side)side.innerHTML=sidebar();renderPage();break;}
  case 'view':state.view=button.dataset.view;await saveSettings({view:state.view});renderPage({keepScroll:true});break;
  case 'accent':await saveSettings({accent:button.dataset.color});break;
  case 'setting-toggle':{const key=button.dataset.key;await saveSettings({[key]:!state.settings[key]});break;}
  case 'add-folder':{try{const dir=await window.orbit.chooseFolder();if(dir){const folders=[...new Set([...state.settings.libraryFolders,dir])];await saveSettings({libraryFolders:folders});toast(t('Scan location added.'))}}catch(e){toast(e.message,true)}break;}
  case 'remove-folder':{
   const index=Number(button.dataset.index);
   const removed=state.settings.libraryFolders[index];
   const folders=state.settings.libraryFolders.filter((_,i)=>i!==index);
   await saveSettings({libraryFolders:folders});
   if(removed){
    toast(t('Scan location removed.'),false,{label:t('Undo'),onClick:async()=>{
     const next=[...new Set([...(state.settings?.libraryFolders||[]),removed])];
     await saveSettings({libraryFolders:next});
     toast(t('Scan location restored.'));
    }});
   }
   break;
  }
  case 'export':{
   if(button.disabled)break;
   button.disabled=true;button.setAttribute('aria-busy','true');
   try{const res=await window.orbit.exportLibrary();if(res?.path){toast(t(res.portable?'Portable library, artwork and completed play history exported.':'Library and completed play history exported as JSON (artwork not embedded).'));if(res.missingArtwork)toast(t('{count} missing or invalid artwork file(s) were not included.',{count:formatNumber(res.missingArtwork)}),true)}}catch(e){toast(e.message,true)}finally{button.disabled=false;button.removeAttribute('aria-busy');}
   break;
  }
  case 'restore':openModal('restore-confirm');break;
  case 'restore-confirmed':{
   if(button.disabled)break;
   button.disabled=true;button.setAttribute('aria-busy','true');
   try{
    const res=await window.orbit.restoreLibrary();
    closeModal();
    if(res){const history=Number.isInteger(res.sessionsImported)?t(' {count} play sessions added{skipped}.',{count:formatNumber(res.sessionsImported),skipped:res.sessionsSkipped?t('; {count} existing sessions skipped',{count:formatNumber(res.sessionsSkipped)}):''}):'';toast(t('Restored {imported} games; skipped {skipped}.{history}',{imported:formatNumber(res.imported),skipped:formatNumber(res.skipped),history}));if(res.errors?.length)toast(res.errors.slice(0,2).join(' · '),true)}
   }catch(e){toast(e.message,true);button.disabled=false;button.removeAttribute('aria-busy');}
   break;
  }
 }
}
document.addEventListener('click',event=>{
 const openFilters=el('filters-popover');
 if(openFilters?.open&&!openFilters.contains(event.target))openFilters.open=false;
 for(const menu of document.querySelectorAll('.showcase-more-menu[open]'))if(!menu.contains(event.target))menu.open=false;
 const button=event.target.closest('[data-action]');
 if(gameActionsTrigger&&button?.dataset.action!=='game-actions')closeGameActions(!!button?.closest('.game-actions-popup'));
 if(!button||button.disabled)return;
 if(button.dataset.action==='scrim'&&event.target!==button)return;
 event.preventDefault();handleAction(button,event).catch(e=>toast(e.message||t('Action failed.'),true));});
document.addEventListener('change',async event=>{const target=event.target;
 if(target.closest?.('#game-form')){el('game-form').dataset.dirty='true';syncFieldAria(target,true);}
 if(target.matches('[data-select-game]')){toggleGameSelection(target.dataset.selectGame,false);return;}
 if(target.matches('[data-game-col-id]')){
  const gameId=target.dataset.gameId;
  const ids=[...el('modal-root').querySelectorAll(`[data-game-col-id][data-game-id="${CSS.escape(gameId)}"]:checked`)].map(node=>node.dataset.gameColId);
  try{await window.orbit.setGameCollections(gameId,ids);}catch(e){toast(e.message,true);renderModal();}
  return;
 }
 if(target.matches('[data-import-index]')){
  const i=Number(target.dataset.importIndex);
  if(target.checked){if(state.selectedImports.size>=MAX_IMPORT_SELECTION){target.checked=false;toast(t('Select up to {count} games per import.',{count:formatNumber(MAX_IMPORT_SELECTION)}),true);return;}state.selectedImports.add(i)}else state.selectedImports.delete(i);
  const count=state.selectedImports.size,modal=el('modal-root');
  const summary=modal.querySelector('.import-toolbar .muted');if(summary)summary.textContent=t('{count} selected',{count:formatNumber(count)});
  const toggle=modal.querySelector('[data-action="toggle-all-import"]');if(toggle)toggle.textContent=t(count?'Deselect all':'Select all new');
  const submit=modal.querySelector('[data-action="import"]');
  if(submit){submit.disabled=count===0;submit.innerHTML=`${ic('download',16)} ${tr('Import')} ${formatNumber(count)} ${tr(count===1?'game':'games')}`;}
  return;
 }
 if(target.id==='status-filter'){state.status=target.value;syncLibraryFiltersUi();renderVirtual();return}
 if(target.id==='playtime-filter'){state.playtime=target.value;syncLibraryFiltersUi();renderVirtual();return}
 if(target.id==='collection-filter'){state.collection=target.value;syncLibraryFiltersUi({updateSidebar:true});renderVirtual();return}
 if(target.id==='detail-status-select'){
  try{await window.orbit.updateGame(target.dataset.id,{play_status:target.value});toast(target.value?t('Status set to {status}.',{status:statusLabel(target.value)}):t('Play status cleared.'));}catch(e){toast(e.message,true)}
  return;
 }
 if(target.id==='bulk-status-select'){
  const value=target.value;target.value='';if(!value)return;
  const status=value==='__clear__'?'':value;
  try{await applyBulkUpdate({play_status:status},status?t('Status set for {count} games.',{count:formatNumber(state.selectedGames.size)}):t('Cleared status for {count} games.',{count:formatNumber(state.selectedGames.size)}));}catch(e){toast(e.message,true)}
  return;
 }
 if(target.id==='tag-filter'){state.tag=target.value;syncLibraryFiltersUi();renderVirtual();return}
 if(target.id==='genre-filter'){state.genre=target.value;syncLibraryFiltersUi();renderVirtual();return}
 if(target.id==='sort-by'){state.sort=target.value;try{await saveSettings({sort:state.sort})}catch(e){toast(e.message,true)}renderVirtual();return}
 if(target.id==='theme-select'){try{await saveSettings({theme:target.value})}catch(e){toast(e.message,true)}}
 if(target.id==='language-select'){
  const language=target.value;
  try{await saveSettings({language})}catch(e){target.value=state.settings?.language||'system';toast(e.message||t('Could not save language preference.'),true)}
  return;
 }
 if(target.id==='density-select'){try{await saveSettings({libraryDensity:target.value});renderPage({keepScroll:true})}catch(e){toast(e.message,true)}}
});
document.addEventListener('blur',event=>{syncFieldAria(event.target,true);},true);
let searchTimer;document.addEventListener('input',event=>{
 if(event.target.closest?.('#game-form')){
  el('game-form').dataset.dirty='true';
  if(event.target.getAttribute('aria-invalid')==='true'){clearFieldError(event.target);}
  else if(event.target.hasAttribute('aria-invalid'))syncFieldAria(event.target);
  return;
 }
 if(event.target.id!=='global-search')return;
 state.query=event.target.value;
 const topSlot=el('top-slot'),crumb=topSlot?.querySelector('.breadcrumb'),scanBtn=topSlot?.querySelector('[data-action="scan"]');
 if(crumb)crumb.textContent=state.query.trim()?t('Search results'):'';
 if(!['library','favorites','recent'].includes(state.route)){state.route='library';el('side-slot').innerHTML=sidebar();scanBtn?.remove();renderPage();}
 clearTimeout(searchTimer);searchTimer=setTimeout(()=>{if(['library','favorites','recent'].includes(state.route)){const scroller=el('main-scroll');if(scroller)scroller.scrollTop=0;renderVirtual();}},95);
});
document.addEventListener('contextmenu',event=>{
 if(state.modal||controllerMode?.active)return;
 const cardItem=event.target.closest('.poster-card,.continue-card,.game-row');
 if(!cardItem?.dataset.id)return;
 event.preventDefault();
 const trigger=cardItem.querySelector('[data-action="game-actions"]')||cardItem.querySelector('.card-open-trigger,.continue-open-trigger,.row-open-trigger');
 openGameActions(trigger,{id:cardItem.dataset.id,x:event.clientX,y:event.clientY});
});
document.addEventListener('submit',async event=>{
 if(event.target.id==='game-form'){event.preventDefault();storeGame(event.target);return;}
 if(event.target.id==='session-correction-form'){event.preventDefault();saveSessionCorrection(event.target);return;}
 if(event.target.id==='collection-create-form'){
  event.preventDefault();
  const fd=new FormData(event.target);
  try{await window.orbit.createCollection({name:String(fd.get('name')||''),color:String(fd.get('color')||''),icon:String(fd.get('icon')||'folder')});toast(t('Collection created.'));event.target.reset();}
  catch(e){toast(e.message,true)}
  return;
 }
 if(event.target.id==='collection-edit-form'){
  event.preventDefault();
  const fd=new FormData(event.target);
  try{await window.orbit.updateCollection(event.target.dataset.id,{name:String(fd.get('name')||''),color:String(fd.get('color')||''),icon:String(fd.get('icon')||'folder')});if(state.modal?.type==='collections')state.modal.editId=null;toast(t('Collection updated.'));}
  catch(e){toast(e.message,true)}
  return;
 }
 if(event.target.id==='quick-collection-form'){
  event.preventDefault();
  const fd=new FormData(event.target),name=String(fd.get('name')||'').trim();
  if(!name)return;
  try{
   const col=await window.orbit.createCollection({name,color:state.settings?.accent||palette[0],icon:'folder'});
   if(event.target.dataset.bulk==='true'&&col?.id){
    await applyBulkUpdate({add_collection_id:col.id},t('Added {count} games to collection.',{count:formatNumber(state.selectedGames.size)}));
    closeModal();
   }else if(event.target.dataset.gameId&&col?.id){
    const current=new Set(gameCollectionIds(event.target.dataset.gameId));current.add(col.id);
    await window.orbit.setGameCollections(event.target.dataset.gameId,[...current]);
    toast(t('Collection created.'));
   }
   event.target.reset();
  }catch(e){toast(e.message,true)}
  return;
 }
 if(event.target.id==='bulk-tags-form'){
  event.preventDefault();
  const fd=new FormData(event.target);
  const split=raw=>String(raw||'').split(',').map(s=>s.trim()).filter(Boolean);
  const add_tags=split(fd.get('add_tags')),remove_tags=split(fd.get('remove_tags'));
  if(!add_tags.length&&!remove_tags.length){toast(t('Enter at least one tag to add or remove.'),true);return;}
  try{await applyBulkUpdate({add_tags,remove_tags},t('Updated tags for {count} games.',{count:formatNumber(state.selectedGames.size)}));closeModal();}
  catch(e){toast(e.message,true)}
 }
});
document.addEventListener('keydown',event=>{
 const menu=el('game-actions-popup');
 if(menu){
  if(event.key==='Escape'){event.preventDefault();closeGameActions(true);return;}
  if(event.key==='Tab'){closeGameActions(true);event.preventDefault();return;}
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)&&menu.contains(document.activeElement)){
   event.preventDefault();const items=[...menu.querySelectorAll('[role=menuitem],[role=menuitemradio]')];
   const current=items.indexOf(document.activeElement);
   const next=event.key==='Home'?0:event.key==='End'?items.length-1:(current+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
   items[next]?.focus({preventScroll:true});return;
  }
 }
 if(event.key==='Enter'&&!event.isComposing&&event.target.id==='cover-search-title'){
  event.preventDefault();const search=el('modal-root')?.querySelector('[data-action="find-online-art"]');if(search&&!search.disabled)search.click();return;
 }
 if(event.key==='F11'&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();if(!event.repeat&&!state.modal)Promise.resolve().then(toggleControllerMode).catch(error=>toast(error.message,true));return;}
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();el('global-search')?.focus();el('global-search')?.select()}
 if(event.key==='Escape'){
  const openMore=document.querySelector('.showcase-more-menu[open]');
  if(openMore){event.preventDefault();openMore.open=false;openMore.querySelector('summary')?.focus();return;}
  const openFilters=el('filters-popover');
  if(openFilters?.open){event.preventDefault();openFilters.open=false;openFilters.querySelector('summary')?.focus();return;}
  if(state.modal){event.preventDefault();requestCloseModal();return;}
 }
 if(!state.modal&&!controllerMode?.active&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)&&event.target.classList?.contains('card-open-trigger')){
  const grid=event.target.closest('.games-grid');
  if(grid){
   const triggers=[...grid.querySelectorAll('.card-open-trigger')];
   const current=triggers.indexOf(event.target);
   const cols=Math.max(1,getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean).length||1);
   const delta=event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:event.key==='ArrowUp'?-cols:cols;
   const next=current+delta;
   if(next>=0&&next<triggers.length){event.preventDefault();triggers[next].focus();}
   return;
  }
 }
 if(!state.modal&&!controllerMode?.active&&['ArrowUp','ArrowDown'].includes(event.key)&&event.target.classList?.contains('row-open-trigger')){
  const list=event.target.closest('.game-list');
  if(list){
   const triggers=[...list.querySelectorAll('.row-open-trigger')];
   const current=triggers.indexOf(event.target);
   const next=current+(event.key==='ArrowDown'?1:-1);
   if(next>=0&&next<triggers.length){event.preventDefault();triggers[next].focus();}
   return;
  }
 }
 if(event.key==='Tab'&&state.modal){
  const root=el('modal-root'),dialog=root.querySelector('.dialog');
  const elements=[...root.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter(x=>x.getClientRects().length>0&&getComputedStyle(x).visibility!=='hidden');
  if(elements.length){
   const first=elements[0],last=elements[elements.length-1],active=document.activeElement;
   if(active===dialog||!dialog.contains(active)){event.preventDefault();(event.shiftKey?last:first).focus();}
   else if(event.shiftKey&&active===first){event.preventDefault();last.focus();}
   else if(!event.shiftKey&&active===last){event.preventDefault();first.focus();}
  }
 }
});
document.addEventListener('scroll',event=>{
 if(!gameActionsTrigger||event.target===el('game-actions-popup'))return;
 const rect=gameActionsTrigger.getBoundingClientRect();
 const currentScroll=el('main-scroll')?.scrollTop||0;
 // Browsers may deliver an already-completed scroll event after opening, and
 // hover/active scale transitions shift the trigger rect by ~2-3px without scrolling.
 if(!gameActionsAnchor||Math.abs(currentScroll-gameActionsAnchor.scrollTop)>2||Math.abs(rect.x-gameActionsAnchor.x)>6||Math.abs(rect.y-gameActionsAnchor.y)>6)closeGameActions();
},true);
window.addEventListener('resize',()=>closeGameActions());
// A wide header/banner is not a portrait cover. Let the icon or gradient
// show until the user requests a proper portrait via Repair library covers.
function ensureImageFallback(img){
 const url=img.dataset.fallbackIcon;
 if(!url)return;
 const parent=img.parentElement;
 if(img.classList.contains('cover-image')&&parent?.classList.contains('cover')&&!parent.querySelector('.cover-icon-frame')){
  const frame=document.createElement('span');frame.className='cover-icon-frame';
  const icon=document.createElement('img');icon.className='cover-icon';icon.src=url;icon.alt='';icon.loading='lazy';icon.decoding='async';
  frame.appendChild(icon);parent.appendChild(frame);
 }else if(parent?.classList.contains('row-cover')&&!parent.querySelector('.list-game-icon')){
  const icon=document.createElement('img');icon.className='list-game-icon';icon.src=url;icon.alt='';icon.loading='lazy';icon.decoding='async';
  parent.insertBefore(icon,img);
 }
}
function checkCoverAspect(img){
  if(!(img instanceof HTMLImageElement))return;
  if(img.matches('.hero-art,.detail-banner,.showcase-hero-banner')){if(img.naturalWidth/img.naturalHeight<1.5)img.classList.add('bad-aspect');return;}
  if(!img.matches('.cover-image,.row-cover img:not(.list-game-icon)'))return;
  const ratio=img.naturalHeight?img.naturalWidth/img.naturalHeight:0;
  const bad=ratio<0.5||ratio>0.85;
  img.classList.toggle('bad-aspect',bad);
  if(bad)ensureImageFallback(img);
}
document.addEventListener('load',event=>checkCoverAspect(event.target),true);
document.addEventListener('error',event=>{
  if(event.target instanceof HTMLImageElement){event.target.classList.add('bad-aspect');ensureImageFallback(event.target);}
},true);
window.addEventListener('resize',()=>renderVirtual());
window.matchMedia?.('(prefers-color-scheme:light)')?.addEventListener('change',()=>{if(state.settings?.theme==='system')setupTheme()});
async function boot(){try{
 if(!window.orbit)throw Error('Desktop integration is unavailable. Start Orbit using the desktop application.');
 const buffered=[];
 window.orbit.onEvent(event=>{if(libraryUpdates)handleOrbitEvent(event);else buffered.push(event);});
 if(window.orbit.ready)await window.orbit.ready;
 const data=await window.orbit.bootstrap();
 libraryUpdates=new window.OrbitLibraryUpdates.LibraryUpdates({
  snapshot:data,loadSnapshot:loadLibrarySnapshot,onChange:applyLibraryUpdate,
  onError:error=>toast(error.message||(typeof t==='function'?t('Could not update the library.'):'Could not update the library.'),true)
 });
 state.games=libraryUpdates.snapshot().games;state.collections=Array.isArray(data.collections)?data.collections:[];state.runningIds=data.runningIds||[];state.settings=data.settings;
 state.sort=data.settings.sort||'name';state.view=data.settings.view||'grid';state.platform=data.platform;state.version=data.version;
 applyLanguage(data.settings?.language||'system');setupTheme();renderShell();
 if(typeof waitForLaunchConfirmation==='function'){
  for(const item of data.launchPending||[])waitForLaunchConfirmation(item.id,item.waitMs);
 }
 lastRenderedLocale=localeRenderKey();
 for(const event of buffered)handleOrbitEvent(event);
 if(data.controllerReturn&&typeof restoreControllerReturn==='function')await restoreControllerReturn(data.controllerReturn);
 if(typeof maybeAutoEnterControllerMode==='function')await maybeAutoEnterControllerMode();
 if(typeof startDesktopPadEntry==='function')startDesktopPadEntry();
 if(typeof showWhatsNewAfterBoot==='function'&&(typeof controllerMode==='undefined'||(!controllerMode?.active&&!controllerMode?.session)))showWhatsNewAfterBoot();
 if(state.settings.autoScan)setTimeout(()=>{
  if(state.settings.autoScan&&!state.runningIds.length&&!state.imports.length)void performScan(true);
 },1000);
 // Update-service availability must not delay or prevent library startup.
 if(window.orbit.getUpdateStatus)Promise.resolve().then(()=>window.orbit.getUpdateStatus()).then(status=>{
  if(!status)return;
  state.updateStatus=status;
  if(typeof syncUpdateUi==='function')syncUpdateUi();
  else {const statusNode=el('update-status');if(statusNode)statusNode.textContent=typeof t==='function'?t(status.message||''):status.message||'';}
 }).catch(error=>{
  state.updateStatus={state:'error',message:'Update status is unavailable.'};
  if(typeof syncUpdateUi==='function')syncUpdateUi();
  else {const statusNode=el('update-status');if(statusNode)statusNode.textContent=typeof t==='function'?t(state.updateStatus.message):state.updateStatus.message;}
  console.warn('Could not load update status:',error);
 });
 }catch(e){el('app').innerHTML=`<div class="boot"><div class="boot-icon" aria-hidden="true">${ic('alert',30)}</div><h2>${typeof tr==='function'?tr('Orbit could not start'):'Orbit could not start'}</h2><p>${esc(e.message||(typeof t==='function'?t('Unknown error.'):'Unknown error.'))}</p><div class="boot-actions"><button type="button" class="primary-btn" data-action="boot-retry">${ic('refresh',16)} ${typeof tr==='function'?tr('Retry'):'Retry'}</button>${typeof window.orbit?.openAppData==='function'?`<button type="button" class="secondary-btn" data-action="open-data">${ic('folder',16)} ${typeof tr==='function'?tr('Open data folder'):'Open data folder'}</button>`:''}</div></div>`;}}

boot();
})();

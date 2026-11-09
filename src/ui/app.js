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
 dots:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
};
const ic=(name,size=18)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${iconPaths[name]||iconPaths.gamepad}</svg>`;
const state={games:[],runningIds:[],settings:null,route:'home',query:'',filter:'all',tag:'all',genre:'all',view:'grid',sort:'name',modal:null,imports:[],importPage:0,selectedImports:new Set(),scanWarnings:[],scanDiagnostics:[],pendingLaunches:new Set(),scanning:false,busy:false,platform:'',version:'',viewGames:[],statistics:{status:'idle',data:null,error:''},updateStatus:{state:'idle',message:'Update check not started.'}};
let controllerMode=null;
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
function toggleControllerMode(){
 pauseDesktopPadEntry();
 if(state.modal)closeModal();
 if(!controllerMode){
  if(!window.OrbitControllerMode)throw Error('Controller mode is unavailable. Restart Orbit to load the latest files.');
  controllerMode=window.OrbitControllerMode.create({api:window.orbit,
   snapshot:()=>({games:state.games,runningIds:state.runningIds,pendingLaunches:state.pendingLaunches}),
   launch:performLaunch,favorite,notify:toast,
   onExit:()=>{refreshNavigation(true);document.querySelector('[data-action="controller-mode"]')?.focus();wakeDesktopPadEntry();}
  });
 }
 return controllerMode.toggle();
}
const sourceNames={steam:'Steam',epic:'Epic Games',gog:'GOG',ea:'EA app',ubisoft:'Ubisoft Connect',battlenet:'Battle.net',xbox:'Xbox / PC Game Pass',folder:'Local',manual:'Manual'};
const palette=['#8b7aff','#5bafef','#fc8ca8','#53c5b3','#f3a65c','#bf87f5'];
function artwork(token){return /^[a-f\d-]{36}\.(jpg|jpeg|png|webp)$/.test(token||'')?(window.OrbitArtworkUrl?.(token)||`orbit-art://file/${token}`):null}
// One image per card in the common case: loading the icon behind every
// valid cover doubles image work. An invalid/unavailable cover loads its icon
// only after image validation (see ensureImageFallback below).
function coverImage(g,priority=false){const cover=artwork(g.cover),icon=artwork(g.icon);const fallback=icon&&!cover?`<span class="cover-icon-frame"><img class="cover-icon" src="${icon}" loading="lazy" decoding="async" alt="" /></span>`:'';const title=`<span class="cover-placeholder-symbol">${ic('gamepad',29)}</span><span class="cover-placeholder-title">${esc(g.name)}</span>`;const poster=cover?`<img class="cover-image ${g.cover_fit==='contain'?'fit-contain':''} position-${['top','bottom'].includes(g.cover_position)?g.cover_position:'center'}" src="${cover}" data-fallback-icon="${icon||''}" loading="${priority?'eager':'lazy'}" decoding="async" ${priority?'fetchpriority="high"':''} alt="" />`:'';return fallback+title+poster;}
function timeLabel(seconds){if(!seconds)return t('Not played yet');const total=Math.max(1,Math.round(seconds/60)),hrs=Math.floor(total/60),mins=total%60;return hrs?t('{hours}h {minutes}m played',{hours:formatNumber(hrs),minutes:formatNumber(mins)}):t('{minutes}m played',{minutes:formatNumber(total)})}
function sourceLabel(game){return game.source==='folder'?t('Local'):game.source==='manual'?t('Manual'):sourceNames[game.source]||t('Game')}
function formatDate(date){if(!date)return t('Never');const d=new Date(date);return Number.isNaN(d.getTime())?t('Unknown'):(window.OrbitI18n?.formatDate?.(d,{month:'short',day:'numeric',year:'numeric'})??new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'}).format(d))}
function setupTheme(){const theme=state.settings?.theme||'dark';const resolved=theme==='system'&&window.matchMedia?.('(prefers-color-scheme: light)').matches?'light':theme==='system'?'dark':theme;document.body.dataset.theme=resolved;document.body.dataset.reduceMotion=String(!!state.settings?.reduceMotion);document.body.dataset.density=state.settings?.libraryDensity==='compact'?'compact':'comfortable';const accent=state.settings?.accent||palette[0];document.documentElement.style.setProperty('--accent',accent);const n=parseInt(accent.slice(1),16);document.documentElement.style.setProperty('--accent-rgb',`${n>>16},${(n>>8)&255},${n&255}`);document.documentElement.style.setProperty('--accent-ink','#11121d')}
function totalHours(){return formatNumber(Math.round(state.games.reduce((sum,g)=>sum+(g.total_play_seconds||0),0)/3600*10)/10)}
const sortedGames=arr=>arr.slice().sort((a,b)=>state.sort==='recent'?(Date.parse(b.last_played_at||0)||0)-(Date.parse(a.last_played_at||0)||0)||a.name.localeCompare(b.name):state.sort==='added'?(Date.parse(b.created_at||0)||0)-(Date.parse(a.created_at||0)||0):state.sort==='time'?(b.total_play_seconds||0)-(a.total_play_seconds||0):a.name.localeCompare(b.name));
let filterCache=null;
function filtered(){const key=[state.games,state.route,state.filter,state.tag,state.genre,state.sort,state.query];if(filterCache&&key.every((x,i)=>filterCache.key[i]===x))return filterCache.value;let a=state.games.slice();if(state.route==='favorites')a=a.filter(g=>g.favorite);if(state.route==='recent')a=a.filter(g=>g.last_played_at);
  if(state.filter!=='all')a=a.filter(g=>g.source===state.filter);
  if(state.tag!=='all')a=a.filter(g=>g.tags?.includes(state.tag));
  if(state.genre!=='all')a=a.filter(g=>g.genre===state.genre);
  if(state.query.trim()){const q=state.query.trim().toLocaleLowerCase();a=a.filter(g=>[g.name,g.genre,g.source,...(g.tags||[])].some(v=>(v||'').toLocaleLowerCase().includes(q)));}
  const result=sortedGames(a);filterCache={key,value:result};return result;
}
function card(g){return `<article class="game-card poster-card" data-action="detail" data-id="${esc(g.id)}" role="button" tabindex="0" aria-label="${tr('View details for {name}',{name:g.name})}" title="${esc(g.name)}">
  <div class="cover cinematic-card-cover">${coverImage(g)}<span class="cover-letter">${esc(g.name.slice(0,2))}</span>
  <button class="favorite-float ${g.favorite?'active':''}" data-action="favorite" data-id="${esc(g.id)}" aria-label="${tr(g.favorite?'Remove favorite':'Add favorite')}" aria-pressed="${!!g.favorite}">${ic('heart',19)}</button>
  <button class="game-menu card-menu-float" data-action="game-actions" data-id="${esc(g.id)}" aria-label="${tr('Actions for {name}',{name:g.name})}" aria-haspopup="menu" aria-controls="game-actions-popup" aria-expanded="false">${ic('dots',20)}</button>
  <button class="cover-play" data-action="launch" data-id="${esc(g.id)}" aria-label="${tr('Launch {name}',{name:g.name})}">${ic('play',17)}<span>${tr('Spelen')}</span></button></div>
  <div class="game-label"><div><span class="game-name" title="${esc(g.name)}">${esc(g.name)}</span><span class="game-meta">${state.runningIds?.includes(g.id)?tr('● Playing now'):esc(timeLabel(g.total_play_seconds))}</span></div></div></article>`}
function rowGame(g){return `<article class="game-row" data-action="detail" data-id="${esc(g.id)}" tabindex="0" role="button" aria-label="${tr('View {name}',{name:g.name})}">
  <div class="row-cover">${esc(g.name.slice(0,1))}${!artwork(g.cover)&&artwork(g.icon)?`<img src="${artwork(g.icon)}" alt="" loading="lazy" decoding="async" class="list-game-icon" />`:''}${artwork(g.cover)?`<img src="${artwork(g.cover)}" data-fallback-icon="${artwork(g.icon)||''}" alt="" loading="lazy" decoding="async" />`:''}</div>
  <div class="row-info"><h3>${esc(g.name)}</h3><p>${esc(sourceLabel(g))}${g.tags?.length?' · '+esc(g.tags.slice(0,2).join(', ')):''}</p></div>
  <div class="row-right"><span class="playtime">${esc(timeLabel(g.total_play_seconds))}</span><button class="ghost-btn" data-action="favorite" data-id="${esc(g.id)}" aria-label="${tr(g.favorite?'Remove favorite':'Add favorite')}" aria-pressed="${!!g.favorite}">${ic('heart',17)}</button><button class="ghost-btn row-play" data-action="launch" data-id="${esc(g.id)}">${ic('play',15)} ${tr('Play')}</button></div></article>`}
function sidebar(){const links=[['home','home','Overview'],['library','library','All games'],['favorites','heart','Favorites'],['recent','clock','Recently played'],['statistics','chart','Statistics']];return `<aside class="sidebar">
 <div class="brand" role="img" aria-label="Orbit Launcher"><img class="orbit-brand-mark" src="../../assets/branding/orbit-generated-mark.png" alt="" /><span class="orbit-brand-word" aria-hidden="true">orbit</span></div>
 <div class="side-label">${tr('LIBRARY')}</div><nav class="nav" aria-label="${tr('Main navigation')}">${links.map(([id,icon,name])=>`<button class="nav-item ${state.route===id?'active':''}" data-action="navigate" data-route="${id}" title="${tr(name)}" ${state.route===id?'aria-current="page"':''}>${ic(icon,18)}<span>${tr(name)}</span>${id==='library'?`<span class="count">${formatNumber(state.games.length)}</span>`:''}</button>`).join('')}</nav>
 <div class="side-divider"></div><nav class="nav"><button class="nav-item" data-action="shuffle" title="${tr('Choose a game')}" ${state.games.length?'':'disabled'}>${ic('sparkles',18)}<span>${tr('Choose a game')}</span></button><button class="nav-item" data-action="whats-new" title="${tr('See what\'s new')}" aria-label="${tr('See what\'s new')}">${ic('info',18)}<span>${tr("What's new")}</span></button><button class="nav-item ${state.route==='settings'?'active':''}" data-action="navigate" data-route="settings" title="${tr('Settings')}">${ic('settings',18)}<span>${tr('Settings')}</span></button></nav>
 <div class="side-bottom"><div class="side-version"><span class="status-dot"></span><span>${tr(state.scanning?'Scanning your games…':'Local library')} <span class="version-number">v${esc(state.version)}</span></span></div></div></aside>`}
function topbar(){const name={home:'Overview',library:'My library',favorites:'Favorites',recent:'Recently played',statistics:'Gaming statistics',settings:'Settings'}[state.route]||'Overview';return `<header class="topbar"><div class="breadcrumb">${tr(name)}</div>
 <div class="topbar-right"><label class="searchbox">${ic('search',18)}<input id="global-search" type="search" placeholder="${tr('Search your library')}" value="${esc(state.query)}" autocomplete="off" aria-label="${tr('Search games')}"/><kbd>Ctrl K</kbd></label>
 <button class="top-icon" data-action="controller-mode" title="${tr('Controller mode (F11 / Menu)')}" aria-label="${tr('Enter controller mode')}">${ic('gamepad',18)}</button>${['library','favorites','recent'].includes(state.route)?'':`<button class="top-icon" data-action="scan" title="${tr('Discover installed games')}" aria-label="${tr('Discover installed games')}">${ic('refresh',18)}</button>`}
 <button class="primary-btn" data-action="add">${ic('plus',18)}<span>${tr('Add game')}</span></button></div></header>`}
function headline(eyebrow,title,subtitle,buttons=''){return `<div class="page-heading"><div>${eyebrow?`<div class="eyebrow"><i></i>${esc(eyebrow)}</div>`:''}<h1 class="page-title">${esc(title)}</h1>${subtitle?`<p class="page-intro">${esc(subtitle)}</p>`:''}</div>${buttons}</div>`}
function platformFilters(){
 const scope=state.route==='favorites'?state.games.filter(g=>g.favorite):state.route==='recent'?state.games.filter(g=>g.last_played_at):state.games;
 const counts=new Map();for(const game of scope)counts.set(game.source,(counts.get(game.source)||0)+1);
 return `<div class="platform-filters" role="group" aria-label="${tr('Filter by platform')}"><button class="platform-chip ${state.filter==='all'?'active':''}" data-action="platform" data-source="all" aria-pressed="${state.filter==='all'}">${tr('All games')} <span>${formatNumber(scope.length)}</span></button>${Object.entries(sourceNames).filter(([key])=>counts.has(key)).map(([key,label])=>`<button class="platform-chip ${state.filter===key?'active':''}" data-action="platform" data-source="${key}" aria-pressed="${state.filter===key}"><i class="source-dot source-${key}"></i>${tr(label)}<span>${formatNumber(counts.get(key))}</span></button>`).join('')}</div>`;
}
function activeFilterSummary(){const active=[state.query.trim()&&`“${state.query.trim()}”`,state.filter!=='all'&&(sourceNames[state.filter]||state.filter),state.genre!=='all'&&state.genre,state.tag!=='all'&&state.tag].filter(Boolean);return active.length?`<span>${tr('Showing')} ${active.map(esc).join(' · ')}</span><button class="small-link" data-action="clear-filters">${tr('Clear filters')} ${ic('close',13)}</button>`:''}
function continueCard(g){return `<article class="continue-card cinematic-continue-card" data-action="detail" data-id="${esc(g.id)}" role="button" tabindex="0" aria-label="${tr('View details for {name}',{name:g.name})}"><div class="continue-art">${coverImage(g)}</div><div class="continue-copy"><strong>${esc(g.name)}</strong><span>${esc(timeLabel(g.total_play_seconds))}</span></div><button class="continue-play" data-action="launch" data-id="${esc(g.id)}" aria-label="${tr('Launch {name}',{name:g.name})}">${ic('play',16)}</button></article>`}
function home(){
 const played=state.games.filter(g=>g.last_played_at).sort((a,b)=>(Date.parse(b.last_played_at)||0)-(Date.parse(a.last_played_at)||0));
 const feature=played[0]||state.games.find(g=>artwork(g.banner))||state.games[0];
 const recent=played.slice(0,3),collection=sortedGames(state.games).slice(0,6);
 const banner=feature&&artwork(feature.banner);
 const featureCover=feature&&artwork(feature.cover);
 return `<section class="page home-page">${headline('',t('Overview'),'',state.games.length?`<button class="secondary-btn shuffle-btn" data-action="shuffle">${ic('sparkles',16)} ${tr('Choose for me')}</button>`:'')}
 <div class="hero cinematic-hero ${banner?'has-banner':''} ${feature?'':'hero-empty'} ${featureCover?'has-feature-cover':''}">
 <div class="hero-ambient" aria-hidden="true"><span></span><span></span></div>
 ${banner?`<img class="hero-art" src="${banner}" alt="" loading="eager" decoding="async" fetchpriority="high" />`:''}
 ${feature?`<div class="hero-portrait" aria-hidden="true"><div class="cover cinematic-hero-poster">${coverImage(feature,!banner)}</div></div>`:''}
 <div class="hero-shade"></div><div class="hero-content"><span class="hero-eyebrow">${tr(feature?(played.length?'CONTINUE PLAYING':'YOUR LIBRARY'):'WELCOME TO ORBIT')}</span>
 <h2>${feature?esc(feature.name):tr('Add your first game')}</h2>
 ${feature?`<div class="hero-metadata"><span>${esc(sourceLabel(feature))}</span>${feature.genre?`<i></i><span>${esc(feature.genre)}</span>`:''}<i></i><span>${esc(timeLabel(feature.total_play_seconds))}</span></div><p>${played.length?tr('Last played {date}.',{date:formatDate(feature.last_played_at)}):''}</p>`:`<p>${tr('Bring your installed games together in a library that feels like yours. Start with your launchers or a folder you choose.')}</p>`}
 <div class="hero-buttons cinematic-hero-actions">${feature?`<button class="primary-btn" data-action="launch" data-id="${esc(feature.id)}">${ic('play',16)} ${tr('Play now')}</button><button class="secondary-btn hero-detail" data-action="detail" data-id="${esc(feature.id)}">${tr('Game details')} ${ic('arrow',16)}</button>`:`<button class="primary-btn" data-action="scan">${ic('refresh',16)} ${tr('Find my games')}</button><button class="secondary-btn" data-action="add">${ic('plus',16)} ${tr('Add a game')}</button>`}</div></div>
 ${feature?`<div class="hero-caption">${ic('gamepad',14)} ${tr('IN YOUR COLLECTION')}</div>`:''}<div class="hero-frame" aria-hidden="true"></div></div>
 <div class="collection-summary"><span><strong>${formatNumber(state.games.length)}</strong> ${tr(state.games.length===1?'game in your library':'games in your library')}</span><span><strong>${formatNumber(state.games.filter(g=>g.favorite).length)}</strong> ${tr('favorites')}</span><span><strong>${totalHours()}h</strong> ${tr('tracked play time')}</span><button class="small-link" data-action="navigate" data-route="library">${tr('Open library')} ${ic('arrow',14)}</button></div>
 ${recent.length?`<div class="subheading"><h2>${tr('Continue playing')}</h2><button class="small-link" data-action="navigate" data-route="recent">${tr('Recently played')} ${ic('arrow',14)}</button></div><div class="continue-grid">${recent.map(continueCard).join('')}</div>`:''}
 <div class="subheading collection-heading"><div><h2>${tr('Your collection')}</h2></div>${state.games.length?`<button class="small-link" data-action="navigate" data-route="library">${tr('View all')} ${formatNumber(state.games.length)} ${ic('arrow',14)}</button>`:''}</div>
 <div id="platform-filter-slot">${platformFilters()}</div>
 ${state.games.length?`<div class="games-grid home-games">${collection.map(card).join('')}</div>`:emptyState(t('Your next favorite belongs here.'),t('Find games from Steam, Epic, GOG, and other installed launchers, or add your own.'))}</section>`;
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
function libraryView(){const subtitle={library:'',favorites:'',recent:''};const title={library:'Your game library',favorites:'Your favorites',recent:'Recently played'};const tags=[...new Set(state.games.flatMap(g=>g.tags||[]))].sort((a,b)=>a.localeCompare(b)).slice(0,100);const genres=[...new Set(state.games.map(g=>g.genre).filter(Boolean))].sort((a,b)=>a.localeCompare(b)).slice(0,100);
 return `<section class="page library-page">${headline('',t(title[state.route]),subtitle[state.route],`<button class="secondary-btn" data-action="scan">${ic('refresh',15)} ${tr('Scan for games')}</button>`)}
 <div id="platform-filter-slot">${platformFilters()}</div><div class="library-controls"><div class="control-left"><span class="library-count" id="game-result-count">${formatNumber(filtered().length)} ${tr('games')}</span>
 <div class="select-wrap"><select id="genre-filter" aria-label="${tr('Filter by category')}"><option value="all" ${state.genre==='all'?'selected':''}>${tr('All categories')}</option>${genres.map(g=>`<option value="${esc(g)}" ${state.genre===g?'selected':''}>${esc(g)}</option>`).join('')}</select></div>
 <div class="select-wrap"><select id="tag-filter" aria-label="${tr('Filter by tag')}"><option value="all" ${state.tag==='all'?'selected':''}>${tr('All tags')}</option>${tags.map(tag=>`<option value="${esc(tag)}" ${state.tag===tag?'selected':''}>${esc(tag)}</option>`).join('')}</select></div></div>
 <div class="control-right"><div class="select-wrap"><select id="sort-by" aria-label="${tr('Sort games')}"><option value="name" ${state.sort==='name'?'selected':''}>${tr('Name A–Z')}</option><option value="recent" ${state.sort==='recent'?'selected':''}>${tr('Recently played')}</option><option value="added" ${state.sort==='added'?'selected':''}>${tr('Recently added')}</option><option value="time" ${state.sort==='time'?'selected':''}>${tr('Play time')}</option></select></div>
 <div class="view-switch" aria-label="${tr('Library display')}"><button data-action="view" data-view="grid" class="${state.view==='grid'?'selected':''}" aria-label="${tr('Grid view')}" aria-pressed="${state.view==='grid'}">${ic('grid',16)}</button><button data-action="view" data-view="list" class="${state.view==='list'?'selected':''}" aria-label="${tr('List view')}" aria-pressed="${state.view==='list'}">${ic('list',16)}</button></div></div></div>
 <div id="active-filters" class="active-filters" aria-live="polite">${activeFilterSummary()}</div><div id="library-area" class="virtual-area">${state.games.length?'<div id="virtual-games"></div>':emptyState(t(state.route==='favorites'?'No favorites yet':state.route==='recent'?'No games played yet':'No games yet'),t(state.route==='favorites'?'Mark games with the heart icon to see them here.':state.route==='recent'?'Launch a game and it will appear here.':'Scan your installed launchers or add a game manually.'))}</div></section>`;
}
let virtualRangeKey=null,virtualGamesRef=null,virtualRunningRef=null,virtualItems=new Map();
function captureGameFocus(host){
 const active=document.activeElement;
 if(!active||!host?.contains(active))return null;
 const item=active.closest('.game-card,.game-row,.continue-card');
 if(!item)return null;
 return {id:item.dataset.id,action:active.dataset.action,root:active===item,index:[...item.parentElement.children].indexOf(item)};
}
function restoreGameFocus(host,focus){
 if(!focus||!host)return;
 const items=[...host.querySelectorAll('.game-card,.game-row,.continue-card')];
 const item=items.find(node=>node.dataset.id===focus.id)||items[Math.min(focus.index,items.length-1)];
 const target=item?(focus.root?item:[...item.querySelectorAll('[data-action]')].find(node=>node.dataset.action===focus.action)||item):host.querySelector('button');
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
  host.innerHTML=emptyState(t(state.query?'No matching games':state.route==='favorites'?'No favorites yet':state.route==='recent'?'No games played yet':'Nothing here yet'),t(state.query?'Try another search or clear filters.':state.route==='favorites'?'Mark games with the heart icon to see them here.':state.route==='recent'?'Launch a game and it will appear here.':'Try changing the platform or tag filters.'),(state.query||state.filter!=='all'||state.tag!=='all'||state.genre!=='all')?`<button class="secondary-btn" data-action="clear-filters">${tr('Clear filters')}</button>`:`<button class="secondary-btn" data-action="navigate" data-route="library">${tr('Browse library')} ${ic('arrow',15)}</button>`);
  restoreGameFocus(host,focus);return;
 }
 const scroll=el('main-scroll');if(!scroll)return;
 const isGrid=state.view==='grid',layout=getComputedStyle(host);
 const gap=parseFloat(layout.getPropertyValue(isGrid?'--grid-gap':'--list-gap'))||0;
 const minimum=parseFloat(layout.getPropertyValue('--card-min'));
 const cols=isGrid?Math.max(1,Math.floor((host.clientWidth+gap)/(minimum+gap))):1;
 const width=(host.clientWidth-gap*(cols-1))/cols;
 // Chromium lays out grid tracks at 1/64 CSS-pixel precision. Use the same
 // quantization for spacers so fractional cover widths cannot accumulate drift.
 const rowHeight=Math.floor((isGrid?width*1.5+parseFloat(layout.getPropertyValue('--card-label-height'))+gap:parseFloat(layout.getPropertyValue('--list-row-height'))+gap)*64)/64;
 const listTop=host.getBoundingClientRect().top-scroll.getBoundingClientRect().top+scroll.scrollTop;
 const totalRows=Math.ceil(games.length/cols),visible=Math.ceil(scroll.clientHeight/rowHeight)+7;
 const first=Math.min(Math.max(0,totalRows-visible),Math.max(0,Math.floor(Math.max(0,scroll.scrollTop-listTop)/rowHeight)-3));
 const last=Math.min(totalRows,first+visible),key=`${state.view}:${cols}:${rowHeight}:${first}:${last}`;
 if(virtualGamesRef===games&&virtualRangeKey===key&&virtualRunningRef===state.runningIds)return;
 virtualGamesRef=games;virtualRangeKey=key;virtualRunningRef=state.runningIds;
 let container=host.querySelector('[data-virtual-items]');
 if(!container||container.dataset.view!==state.view){
  host.innerHTML='<div data-virtual-before></div><div data-virtual-items></div><div data-virtual-after></div>';
  container=host.querySelector('[data-virtual-items]');container.dataset.view=state.view;virtualItems=new Map();
 }
 container.className=isGrid?'games-grid':'game-list';
 container.style.gridTemplateColumns=isGrid?`repeat(${cols},minmax(0,1fr))`:'';
 container.style.gridAutoRows=isGrid?`${rowHeight-gap}px`:'';
 host.firstElementChild.style.height=`${first*rowHeight}px`;
 host.lastElementChild.style.height=`${Math.max(0,(totalRows-last)*rowHeight)}px`;
 const slice=games.slice(first*cols,last*cols),nextItems=new Map(),running=new Set(state.runningIds);
 for(let index=0;index<slice.length;index++){
  const game=slice[index],playing=running.has(game.id),previous=virtualItems.get(game.id);
  let node=previous?.node;
  if(!node||previous.game!==game||previous.playing!==playing){
   const template=document.createElement('template');template.innerHTML=(isGrid?card:rowGame)(game);
   const replacement=template.content.firstElementChild;
   if(node?.parentElement===container)node.replaceWith(replacement);
   node=replacement;
  }
  if(container.children[index]!==node)container.insertBefore(node,container.children[index]||null);
  nextItems.set(game.id,{node,game,playing});
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
 <div class="setting-row"><div><div class="setting-name">${tr('Automatic updates')}</div><div class="setting-help">${tr('Unavailable until signed releases are configured. Your preference is saved for later.')}</div></div><button class="switch ${s.autoUpdates?'on':''}" data-action="setting-toggle" data-key="autoUpdates" role="switch" aria-checked="${!!s.autoUpdates}" aria-label="${tr('Automatic updates')}"></button></div>
 <div class="setting-row"><div><div class="setting-name">${tr('Update status')}</div><div class="setting-help" id="update-status" role="status" aria-live="polite">${tr(state.updateStatus?.message||'Checking availability…')}</div></div><div class="setting-control" style="display:flex;gap:8px"><button class="secondary-btn" data-action="check-update">${tr('Check now')}</button>${state.updateStatus?.state==='ready'?`<button class="primary-btn" data-action="install-update">${tr('Install update')}</button>`:''}</div></div>
 <div class="setting-row"><div><div class="setting-name">${tr("What's new")}</div><div class="setting-help">${tr('Release highlights appear once per version and can be reopened in Settings.')}</div></div><button class="secondary-btn" data-action="whats-new">${ic('sparkles',15)} ${tr("See what's new")}</button></div></div>
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
function renderShell(){el('app').innerHTML=`<div class="app-shell"><div id="side-slot">${sidebar()}</div><div class="workspace"><div id="top-slot">${topbar()}</div><main class="content-scroll" id="main-scroll" tabindex="-1"><div id="page-slot"></div></main></div></div>`;el('main-scroll').addEventListener('scroll',()=>{if(['library','favorites','recent'].includes(state.route)&&!scrollFrame){scrollFrame=requestAnimationFrame(()=>{scrollFrame=null;renderVirtual()})}},{passive:true});renderPage()}
let scrollFrame=null,previousRenderedRoute=null;
function renderPage({keepScroll=false}={}){closeGameActions();const slot=el('page-slot'),scroller=el('main-scroll');if(!slot)return;const old=keepScroll?scroller.scrollTop:0;
 virtualRangeKey=null;virtualGamesRef=null;virtualRunningRef=null;virtualItems=new Map();
 slot.innerHTML=state.route==='home'?home():state.route==='settings'?settingsView():state.route==='statistics'?statisticsView():libraryView();scroller.scrollTop=old;
 if(previousRenderedRoute!==state.route)slot.firstElementChild?.classList.add('page-enter');
 previousRenderedRoute=state.route;
 if(['library','favorites','recent'].includes(state.route))renderVirtual();syncActivity();}
function refreshNavigation(keepScroll=false){el('side-slot').innerHTML=sidebar();el('top-slot').innerHTML=topbar();renderPage({keepScroll});}
function navigate(route){if(!['home','library','favorites','recent','statistics','settings'].includes(route))return;state.route=route;state.query='';state.filter='all';state.tag='all';state.genre='all';refreshNavigation();if(route==='statistics')void loadStatistics();}
function toast(message,error=false){const item=document.createElement('div');item.className=`toast ${error?'error':''}`;item.innerHTML=ic(error?'alert':'check',19)+`<p>${tr(message)}</p>`;const root=el('toast-root');root.appendChild(item);while(root.children.length>3)root.firstElementChild.remove();setTimeout(()=>item.remove(),4600)}
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
function applyLibraryUpdate(change){
 const runningChanged=state.runningIds!==change.runningIds;
 state.games=change.games;state.runningIds=change.runningIds;
 wakeDesktopPadEntry();
 if(controllerMode?.active){controllerMode.update();return;}
 const count=el('side-slot')?.querySelector('[data-route="library"] .count');
 if(count&&count.textContent!==formatNumber(state.games.length))count.textContent=formatNumber(state.games.length);
 if(['library','favorites','recent'].includes(state.route)){
  if(change.reset||!el('virtual-games')||!state.games.length){
   const focus=captureGameFocus(el('page-slot'));renderPage({keepScroll:true});restoreGameFocus(el('page-slot'),focus);
  }else{
   refreshFilterOptions('genre-filter',state.games.map(game=>game.genre),t('All categories'),state.genre);
   refreshFilterOptions('tag-filter',state.games.flatMap(game=>game.tags||[]),t('All tags'),state.tag);
   const platforms=el('platform-filter-slot');if(platforms)platforms.innerHTML=platformFilters();
   renderVirtual();
  }
 }else if(state.route==='home'){
  const focus=captureGameFocus(el('page-slot'));renderPage({keepScroll:true});restoreGameFocus(el('page-slot'),focus);
 }
 syncActivity();
 if(state.modal?.type==='detail'&&(change.reset||runningChanged||change.changedIds.includes(state.modal.id)||change.removedIds.includes(state.modal.id)))renderModal();
}
function handleOrbitEvent(event){
 if(event.type==='gamesChanged')libraryUpdates.receive(event);
 if(event.type==='settingsChanged'){
  const oldLanguage=state.settings?.language||'system';
  state.settings=event.settings;setupTheme();
  if((event.settings?.language||'system')!==oldLanguage){applyLanguage(event.settings.language);if(!window.OrbitI18n)redrawForLanguage();}
 }
 if(event.type==='updateStatus'){state.updateStatus=event.status;const status=el('update-status');if(status)status.textContent=t(event.status.message||'');if(state.route==='settings'&&event.status.state==='ready')renderPage({keepScroll:true});}
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
 if(trigger?.isConnected)trigger.setAttribute('aria-expanded','false');
 gameActionsTrigger=null;
 gameActionsAnchor=null;
 if(restoreFocus&&trigger?.isConnected)trigger.focus({preventScroll:true});
}
function openGameActions(trigger){
 if(gameActionsTrigger===trigger){closeGameActions(true);return;}
 closeGameActions();
 const game=state.games.find(item=>item.id===trigger.dataset.id);
 if(!game)return;
 gameActionsTrigger=trigger;
 trigger.setAttribute('aria-expanded','true');
 const id=esc(game.id);
 const item=(action,icon,label,extra='')=>`<button type="button" role="menuitem" class="game-actions-item ${extra}" data-action="${action}" data-id="${id}">${ic(icon,16)}<span>${label}</span></button>`;
 const menu=document.createElement('div');
 menu.id='game-actions-popup';menu.className='game-actions-popup';menu.setAttribute('role','menu');
 menu.setAttribute('aria-label',t('Actions for {name}',{name:game.name}));
 menu.innerHTML=item('launch','play',tr('Play game'))+item('favorite','heart',tr(game.favorite?'Remove favorite':'Add to favorites'))+
  '<div class="game-actions-divider" role="separator"></div>'+
  item('detail','info',tr('View details'))+item('edit','edit',tr('Edit game'))+item('open-folder','folder',tr('Open game location'))+
  '<div class="game-actions-divider" role="separator"></div>'+item('remove-confirm','trash',tr('Remove from library'),'danger');
 document.body.appendChild(menu);
 const rect=trigger.getBoundingClientRect();
 gameActionsAnchor={x:rect.x,y:rect.y};
 const menuRect=menu.getBoundingClientRect();
 const left=Math.max(8,Math.min(rect.right-menuRect.width,document.documentElement.clientWidth-menuRect.width-8));
 const top=rect.bottom+8+menuRect.height<=window.innerHeight-8?rect.bottom+8:Math.max(8,rect.top-menuRect.height-8);
 menu.style.left=`${left}px`;menu.style.top=`${top}px`;
 menu.querySelector('[role=menuitem]')?.focus({preventScroll:true});
}
function openModal(type,meta={}){pauseDesktopPadEntry();closeGameActions();if(!state.modal){modalReturnFocus=document.activeElement;modalReturnFocusAction=modalReturnFocus?.dataset.action?{action:modalReturnFocus.dataset.action,id:modalReturnFocus.dataset.id,kind:['game-card','game-row','continue-card','game-menu'].find(name=>modalReturnFocus.classList.contains(name))}:null;}state.modal={type,...meta};renderModal()}
const WHATS_NEW_VERSION='0.2.11';
const WHATS_NEW_KEY='orbit.whatsNew.lastAcknowledgedVersion';
let whatsNewPending=false;
function markWhatsNewSeen(){
 try{window.localStorage?.setItem(WHATS_NEW_KEY,WHATS_NEW_VERSION)}catch{/* Denied storage must not break the launcher. */}
}
function showWhatsNewAfterBoot(){
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
 <h2 id="dialog-title">${tr("What's new in Orbit")}</h2><p id="whats-new-intro">${tr('Highlights from 0.2.7 through 0.2.11')}</p></div>
 <div class="whats-new-content">
 <section class="whats-new-version"><div class="whats-new-section-head"><span class="whats-new-chip">${tr('0.2.11 — New')}</span><h3>${tr('A cleaner interface')}</h3></div>
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
 <p class="whats-new-warning">${ic('info',15)} ${tr('Rust and Electron keep separate profiles. Back up before switching.')} ${tr('Windows builds are unsigned; automatic update installation remains disabled.')}</p>
 </div><div class="whats-new-footer"><span>${tr('You can reopen this screen in Settings.')}</span><button class="primary-btn" data-action="close-modal">${tr('Continue to your library')} ${ic('arrow',16)}</button></div></section></div>`;
}
function closeModal(){if(state.modal?.type==='whats-new')markWhatsNewSeen();state.modal=null;el('modal-root').innerHTML='';const candidates=modalReturnFocusAction?[...document.querySelectorAll('[data-action]')].filter(node=>node.dataset.action===modalReturnFocusAction.action&&node.dataset.id===modalReturnFocusAction.id):[];const target=modalReturnFocus?.isConnected?modalReturnFocus:candidates.find(node=>modalReturnFocusAction.kind&&node.classList.contains(modalReturnFocusAction.kind))||candidates[0];target?.focus({preventScroll:true});modalReturnFocus=null;modalReturnFocusAction=null;wakeDesktopPadEntry();if(whatsNewPending){whatsNewPending=false;Promise.resolve().then(showWhatsNewAfterBoot);}}
function dialogFrame(title,description,body,footer='',wide=false){return `<div class="dialog-scrim" data-action="scrim"><section class="dialog ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-header"><div><h2 id="dialog-title">${esc(title)}</h2><p>${esc(description)}</p></div><button class="ghost-btn" data-action="close-modal" aria-label="${tr('Close dialog')}">${ic('close',21)}</button></div>${body}${footer}</section></div>`}
function editor(g){const isEdit=!!g;const title=t(isEdit?'Edit game':'Add a game');const params=Array.isArray(g?.launch_args)?JSON.stringify(g.launch_args):'[]';
 const imgSection=(key,label)=>`<div class="image-upload"><div id="preview-${key}">${artwork(g?.[key])?`<img src="${artwork(g[key])}" alt="${tr('{label} preview',{label:t(label)})}" />`:key==='cover'&&artwork(g?.icon)?`<div class="auto-icon-preview"><img src="${artwork(g.icon)}" alt="${tr('Icon fallback')}" /></div>`:`<div class="image-placeholder">${ic('image',21)}</div>`}</div><div style="flex:1"><p>${tr(label)}</p><small>${tr(key==='icon'?'Used when no cover exists':'PNG, JPEG or WebP')}</small></div><button type="button" class="secondary-btn" data-action="choose-art" data-key="${key}">${tr('Choose')}</button><button type="button" class="small-link" data-action="clear-art" data-key="${key}" aria-label="${tr('Clear {label}',{label:t(label)})}">${tr('Clear')}</button></div>`;
 return dialogFrame(title,t(isEdit?'Update this game without changing its installation.':'Select any locally installed game executable. Orbit recognizes known game filenames and looks for cover art or an icon.'),`<form id="game-form" data-form="game" data-id="${esc(g?.id||'')}"><div class="dialog-body">
  <div class="field"><label for="game-name">${tr('Game title *')}</label><input id="game-name" name="name" type="text" maxlength="140" value="${esc(g?.name||'')}" placeholder="${tr('For example, Hollow Knight')}" required /></div>
  <div class="field"><label for="game-executable">${tr('Executable')}</label><div class="file-field"><input id="game-executable" name="executable" type="text" value="${esc(g?.executable||'')}" placeholder="${tr('Select the game executable')}" /><button type="button" class="secondary-btn" data-action="choose-exe">${ic('folder',16)} ${tr('Browse .exe')}</button></div><div class="file-extras"><button type="button" class="small-link" data-action="find-art">${ic('sparkles',14)} ${tr('Detect game & icon')}</button><span id="game-detection-status" role="status" aria-live="polite"></span></div></div>
  <div class="field"><label for="game-uri">${tr('Launcher URI (optional)')}</label><input id="game-uri" name="launch_uri" value="${esc(g?.launch_uri||'')}" type="text" placeholder="steam://rungameid/12345" /><small>${tr('Orbit launches through the associated game launcher. On Windows, add the actual game executable for playtime tracking.')}</small></div>
  <div class="field-grid"><div class="field"><label for="game-workdir">${tr('Working directory')}</label><input id="game-workdir" name="working_dir" type="text" value="${esc(g?.working_dir||'')}" placeholder="${tr('Defaults to executable folder')}" /></div><div class="field"><label for="game-genre">${tr('Genre')}</label><input id="game-genre" name="genre" type="text" maxlength="100" value="${esc(g?.genre||'')}" placeholder="${tr('Adventure, RPG, Strategy…')}" /></div></div>
  <div class="field-grid"><div class="field"><label for="game-tags">${tr('Tags')}</label><input id="game-tags" name="tags" value="${esc((g?.tags||[]).join(', '))}" type="text" placeholder="${tr('Co-op, Story, Competitive')}" /><small>${tr('Separate multiple tags with commas.')}</small></div><div class="field"><label for="game-args">${tr('Launch arguments')}</label><input id="game-args" name="launch_args" type="text" value="${esc(params)}" placeholder='["--fullscreen"]' /><small>${tr('Enter a JSON array, e.g. ["--fullscreen", "--safe-mode"].')}</small></div></div>
  <div class="image-fields">${imgSection('cover','Cover artwork')}${imgSection('banner','Banner artwork')}${imgSection('icon','Game icon')}</div>
  <div class="field cover-search"><label for="cover-search-title">${tr('Find a cover online')}</label><div class="file-field"><input id="cover-search-title" type="text" maxlength="140" placeholder="${tr('Use game title, or enter a different title')}" autocomplete="off" /><button type="button" class="secondary-btn" data-action="find-online-art">${ic('search',14)} ${tr('Search')}</button></div><small>${tr('Search Steam and Epic Games. The preview changes only when a cover is found; save to apply it.')}</small><span id="cover-search-status" role="status" aria-live="polite"></span></div>
  <div class="field-grid"><div class="field"><label for="game-cover-fit">${tr('Cover presentation')}</label><select id="game-cover-fit" name="cover_fit"><option value="cover" ${g?.cover_fit!=='contain'?'selected':''}>${tr('Fill frame')}</option><option value="contain" ${g?.cover_fit==='contain'?'selected':''}>${tr('Fit entire artwork')}</option></select></div><div class="field"><label for="game-cover-position">${tr('Cover position')}</label><select id="game-cover-position" name="cover_position"><option value="center" ${!['top','bottom'].includes(g?.cover_position)?'selected':''}>${tr('Center')}</option><option value="top" ${g?.cover_position==='top'?'selected':''}>${tr('Top')}</option><option value="bottom" ${g?.cover_position==='bottom'?'selected':''}>${tr('Bottom')}</option></select></div></div>
  <input type="hidden" id="game-cover" name="cover" value="${esc(g?.cover||'')}"/><input type="hidden" id="game-banner" name="banner" value="${esc(g?.banner||'')}"/><input type="hidden" id="game-icon" name="icon" value="${esc(g?.icon||'')}"/>
  </div><div class="dialog-footer"><button type="button" class="secondary-btn" data-action="close-modal">${tr('Cancel')}</button><button type="submit" class="primary-btn">${ic('check',16)} ${tr(isEdit?'Save changes':'Add to library')}</button></div></form>`, '',true);
}
function detail(g){if(!g)return dialogFrame(t('Game unavailable'),t('This game no longer exists.'),`<div class="dialog-body">${tr('Please refresh the library.')}</div>`);
 const tags=(g.tags||[]).map(t=>`<span class="detail-tag">${esc(t)}</span>`).join('');
 const playing=state.runningIds.includes(g.id);
 const banner=artwork(g.banner),cover=artwork(g.cover);
 const backdrop=banner||cover;
 const launchNote=g.source==='xbox'?t('Some PC Game Pass titles require the Xbox app to launch and may not start from a direct EXE.'):g.launch_uri?t('Launched through {source}. Playtime is confirmed after Orbit detects the game process.',{source:sourceLabel(g)}):g.executable?t('Playtime updates after your session ends while Orbit is running.'):t('Choose an executable or launcher URI in Edit details to play.');
 return `<div class="dialog-scrim showcase-scrim" data-action="scrim"><section class="dialog detail-showcase" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="showcase-summary">
  <div class="showcase-hero ${banner?'has-banner':cover?'has-cover-backdrop':'no-artwork'}">
   ${backdrop?`<img class="showcase-hero-art ${banner?'showcase-hero-banner':'showcase-hero-cover'}" src="${backdrop}" alt="" decoding="async" />`:''}
   <div class="showcase-hero-shade" aria-hidden="true"></div>
   <div class="showcase-topline"><span class="showcase-eyebrow">${ic('sparkles',13)} ${tr('ORBIT SHOWCASE')}</span><button class="showcase-close" data-action="close-modal" aria-label="${tr('Close game details')}">${ic('close',20)}</button></div>
   <div class="showcase-hero-copy"><span class="showcase-source">${esc(sourceLabel(g))}${playing?` · ${tr('Playing now')}`:''}</span><h2 id="dialog-title">${esc(g.name)}</h2><p id="showcase-summary">${tr('In your library since {date}',{date:formatDate(g.created_at)})}</p></div>
  </div>
  <div class="showcase-content"><div class="showcase-poster"><div class="cover">${coverImage(g,true)}<span class="cover-letter">${esc(g.name.slice(0,2))}</span></div></div>
   <div class="showcase-information"><div class="showcase-tags">${g.genre?`<span class="detail-tag">${esc(g.genre)}</span>`:''}${tags||`<span class="detail-tag">${tr('In your collection')}</span>`}</div>
    <div class="showcase-stats"><div class="detail-playtime"><div class="detail-playtime-label">${ic('clock',15)} ${tr('PLAYTIME')}${playing?`<span class="detail-live">${tr('● Playing now')}</span>`:''}</div><strong class="detail-playtime-value">${esc(playing&&!g.total_play_seconds?t('First session in progress'):timeLabel(g.total_play_seconds))}</strong><span class="detail-playtime-caption">${tr(playing?'Session time will be added when the game closes':'Recorded game time')}</span></div>
     <div class="showcase-last-played"><span class="showcase-stat-label">${ic('clock',15)} ${tr('LAST PLAYED')}</span><strong>${esc(formatDate(g.last_played_at))}</strong><span>${tr(g.last_played_at?'Last recorded session':'Ready for your first session')}</span></div></div>
    <div class="showcase-actions"><button class="primary-btn showcase-play" data-action="launch" data-id="${esc(g.id)}">${ic('play',20)} <span>${tr('Play game')}</span>${ic('arrow',19)}</button><button class="secondary-btn showcase-favorite ${g.favorite?'is-favorite':''}" data-action="favorite" data-id="${esc(g.id)}" aria-pressed="${!!g.favorite}">${ic('heart',18)} ${tr(g.favorite?'Favorited':'Add to favorites')}</button></div>
    <p class="showcase-note">${esc(launchNote)}</p>
    <div class="showcase-foot"><span title="${esc(g.install_path||g.executable||'')}">${ic('folder',14)} ${esc(g.install_path||g.executable||t('Location unavailable'))}</span></div>
   </div></div>
 </section></div>`;
}
const IMPORT_PAGE_SIZE=100;
const MAX_IMPORT_SELECTION=10000;
function importDialog(){
 const games=state.imports,addable=games.filter(g=>!g.alreadyAdded),selected=state.selectedImports.size;
 const pageCount=Math.max(1,Math.ceil(games.length/IMPORT_PAGE_SIZE));
 state.importPage=Math.min(state.importPage,pageCount-1);
 const first=state.importPage*IMPORT_PAGE_SIZE;
 const description=t('Found {total} installed games. {new} new entries can be imported.',{total:formatNumber(games.length),new:formatNumber(addable.length)});
 const diagnostics=scanDiagnostics();
 const warnings=state.scanWarnings.length?`<div class="warning-line">${ic('alert',15)} ${esc(state.scanWarnings.slice(0,3).join(' • '))}${state.scanWarnings.length>3?` · ${tr('{count} more warnings',{count:formatNumber(state.scanWarnings.length-3)})}`:''}</div>`:'';
 const xboxNotice=games.some(game=>game.source==='xbox')?`<div class="warning-line">${ic('info',15)} ${tr('Some PC Game Pass games require the Xbox app to start, even when an installed executable is found.')}</div>`:'';
 const rows=games.slice(first,first+IMPORT_PAGE_SIZE).map((g,offset)=>{const i=first+offset;return `<label class="import-item ${g.alreadyAdded?'added':''}"><input type="checkbox" data-import-index="${i}" ${state.selectedImports.has(i)?'checked':''} ${g.alreadyAdded?'disabled':''}/><div class="icon-box">${ic(g.source==='steam'?'gamepad':'folder',18)}</div><span style="min-width:0;flex:1"><strong>${esc(g.name)}</strong><small>${esc(sourceLabel(g))} · ${esc(g.install_path||g.executable||t('Launcher entry'))}${g.alreadyAdded?` · ${tr('Already in library')}`:''}</small></span></label>`}).join('');
 const paging=pageCount>1?`<div class="import-toolbar" aria-label="${tr('Import result pages')}"><span class="muted" style="font-size:12px">${tr('Showing {first}–{last} of {total} (page {page} of {pages})',{first:formatNumber(first+1),last:formatNumber(Math.min(games.length,first+IMPORT_PAGE_SIZE)),total:formatNumber(games.length),page:formatNumber(state.importPage+1),pages:formatNumber(pageCount)})}</span><div style="display:flex;gap:8px"><button class="secondary-btn" data-action="import-page" data-page="prev" ${state.importPage===0?'disabled':''}>${tr('Previous')}</button><button class="secondary-btn" data-action="import-page" data-page="next" ${state.importPage===pageCount-1?'disabled':''}>${tr('Next')}</button></div></div>`:'';
 const selectionHint=addable.length>MAX_IMPORT_SELECTION?`<p class="setting-help">${tr('Each import supports up to {limit} games. Import the selected games, then rescan to import the remaining titles.',{limit:formatNumber(MAX_IMPORT_SELECTION)})}</p>`:'';
 return dialogFrame(t('Discover installed games'),description,`<div class="dialog-body">${warnings}${xboxNotice}${diagnostics}<div class="import-toolbar"><span class="muted" style="font-size:12px">${tr('{count} selected across all pages',{count:formatNumber(selected)})}</span><button class="small-link" data-action="toggle-all-import">${tr(selected?'Deselect all':'Select all new')}</button></div>${games.length?`<div class="import-list">${rows}</div>${paging}${selectionHint}`:emptyState(t('No installed games found'),t('Add your preferred library folders in Settings or add an executable manually.'),`<button class="secondary-btn" data-action="add">${ic('plus',15)} ${tr('Add manually')}</button>`)}</div>`,`<div class="dialog-footer"><button class="secondary-btn" data-action="close-modal">${tr('Cancel')}</button><button class="primary-btn" data-action="import" ${selected?'':'disabled'}>${ic('download',16)} ${tr('Import')} ${formatNumber(selected)} ${tr(selected===1?'game':'games')}</button></div>`,true);
}
function renderModal(){const modal=state.modal;if(!modal){el('modal-root').innerHTML='';return}let html='';
 if(modal.type==='game')html=editor(modal.id?state.games.find(g=>g.id===modal.id):null);
 else if(modal.type==='detail')html=detail(state.games.find(g=>g.id===modal.id));
 else if(modal.type==='scan')html=dialogFrame(t('Scanning your games'),t('Looking through installed launchers and selected library folders.'),`<div class="dialog-body" style="display:grid;place-items:center;min-height:200px;text-align:center;color:var(--muted)"><div>${ic('refresh',42)}<p>${tr('Scanning local manifests and folders…')}</p></div></div>`);
 else if(modal.type==='import')html=importDialog();
 else if(modal.type==='whats-new')html=whatsNewDialog();
 else if(modal.type==='remove'){const g=state.games.find(x=>x.id===modal.id);html=dialogFrame(t('Remove from library?'),t('Remove {name} from Orbit. Installed files will remain untouched.',{name:g?.name||t('this game')}),`<div class="dialog-body"><p style="color:var(--muted)">${tr('This removes the library entry, custom metadata and tracked play time. It does not uninstall the game.')}</p></div>`,`<div class="dialog-footer"><button class="secondary-btn" data-action="close-modal">${tr('Keep game')}</button><button class="danger-btn" data-action="remove" data-id="${esc(modal.id)}">${ic('trash',15)} ${tr('Remove game')}</button></div>`)}
 const root=el('modal-root'),active=document.activeElement;
 const previousFocus=root.contains(active)?{action:active.dataset.action,id:active.dataset.id}:null;
 root.innerHTML=html;
 syncActivity();
 const dialog=root.querySelector('.dialog');if(dialog){dialog.setAttribute('tabindex','-1');const keepFocus=previousFocus?.action?[...dialog.querySelectorAll('[data-action]')].find(node=>node.dataset.action===previousFocus.action&&node.dataset.id===previousFocus.id):null;(keepFocus||dialog).focus({preventScroll:true});}
}
async function performScan(){if(state.scanning){openModal('scan');return;}state.scanning=true;syncActivity();openModal('scan');
 try{const results=await window.orbit.discoverGames();if(state.modal?.type!=='scan')return;state.imports=results.games;state.importPage=0;state.scanWarnings=results.warnings||[];state.scanDiagnostics=results.diagnostics||[];state.selectedImports=new Set(results.games.flatMap((g,i)=>g.alreadyAdded?[]:[i]).slice(0,MAX_IMPORT_SELECTION));openModal('import')}
 catch(e){if(state.modal?.type==='scan')closeModal();toast(e.message||t('Scan failed'),true)}finally{state.scanning=false;syncActivity();}
}
async function performImport(){const games=[...state.selectedImports].map(i=>state.imports[i]).filter(x=>x&&!x.alreadyAdded).map(({alreadyAdded,...rest})=>rest);if(!games.length)return;
 const button=el('modal-root').querySelector('[data-action=import]');if(button)button.disabled=true;
 try{const result=await window.orbit.importGames(games);closeModal();toast(t('Imported {count} games.{skipped}',{count:formatNumber(result.imported),skipped:result.skipped?' '+t('{count} already in library.',{count:formatNumber(result.skipped)}):''}));if(result.errors.length)toast(result.errors.slice(0,3).join(' · '),true)}
 catch(e){toast(e.message||t('Import failed.'),true);if(button)button.disabled=false}
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
  if(pending||running){if(!button.dataset.restHtml)button.dataset.restHtml=button.innerHTML;button.innerHTML=ic(pending?'refresh':'check',16)+(button.matches('.cover-play,.continue-play')?'':pending?' '+tr('Starting…'):' '+tr('Playing'));button.disabled=true;button.setAttribute('aria-busy',String(pending));button.setAttribute('title',t(pending?'Starting game…':'Game is running'));}
  else if(button.dataset.restHtml){button.innerHTML=button.dataset.restHtml;delete button.dataset.restHtml;button.disabled=false;button.removeAttribute('aria-busy');button.removeAttribute('title');}
 }
 for(const button of document.querySelectorAll('[data-action="shuffle"]'))button.disabled=state.games.length===0;
 for(const button of document.querySelectorAll('[data-action="scan"]')){button.setAttribute('aria-busy',String(state.scanning));button.classList.toggle('is-scanning',state.scanning);button.title=t(state.scanning?'Scanning installed games…':'Find installed games');}
 const status=document.querySelector('.side-version>span:last-child');if(status)status.innerHTML=state.scanning?tr('Scanning your games…'):`${tr('Local library')} <span class="version-number">v${esc(state.version)}</span>`;
 controllerMode?.update();
 wakeDesktopPadEntry();
}
async function performLaunch(id){const game=state.games.find(g=>g.id===id);if(!game||state.pendingLaunches.has(id)||state.runningIds.includes(id))return;
 const started=performance.now();state.pendingLaunches.add(id);
 try{const launch=window.orbit.launchGame(id);syncActivity();const result=await launch;toast(result.message||t('Launched {name}',{name:game.name}));}
 catch(e){toast(e.message||t('Could not launch {name}',{name:game.name}),true)}
 finally{setTimeout(()=>{state.pendingLaunches.delete(id);syncActivity();},Math.max(0,650-(performance.now()-started)));}
}
async function favorite(id){try{await window.orbit.favoriteGame(id)}catch(e){toast(e.message,true)}}
async function storeGame(form){const data=Object.fromEntries(new FormData(form));data.tags=String(data.tags||'').split(',').map(t=>t.trim()).filter(Boolean);
 try{data.launch_args=JSON.parse(data.launch_args||'[]');if(!Array.isArray(data.launch_args))throw Error()}catch{toast(t('Launch arguments must be a JSON array, for example ["--fullscreen"].'),true);return}
 if(!data.executable?.trim()&&!data.launch_uri?.trim()){toast(t('Choose an executable or enter a supported game-launch URI.'),true);return}
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
async function handleAction(button){const action=button.dataset.action,id=button.dataset.id;
 switch(action){
  case 'game-actions':openGameActions(button);break;
  case 'controller-mode':await toggleControllerMode();break;
   case 'whats-new':openModal('whats-new',{automatic:false});break;
   case 'check-update':{const status=await window.orbit.checkForUpdates();state.updateStatus=status;const element=el('update-status');if(element)element.textContent=t(status.message||'');break;}
   case 'install-update':try{await window.orbit.installUpdate()}catch(error){toast(error.message||t('Cannot install update.'),true)}break;
  case 'navigate':navigate(button.dataset.route);break;
  case 'refresh-statistics':await loadStatistics();break;
  case 'shuffle':{if(state.games.length){const game=state.games[Math.floor(Math.random()*state.games.length)];openModal('detail',{id:game.id});}else toast(t('Add a game to your library first.'));break;}
  case 'platform':{state.filter=button.dataset.source;if(state.route==='home'){state.route='library';el('side-slot').innerHTML=sidebar();el('top-slot').innerHTML=topbar();}renderPage();break;}
  case 'add':openModal('game');break;
  case 'edit':openModal('game',{id});break;
  case 'detail':openModal('detail',{id});break;
  case 'close-modal':closeModal();break;
  case 'scrim':if(button.classList.contains('dialog-scrim'))closeModal();break;
  case 'launch':await performLaunch(id);break;
  case 'favorite':await favorite(id);break;
  case 'remove-confirm':openModal('remove',{id});break;
  case 'remove':try{await window.orbit.removeGame(id);closeModal();toast(t('Game removed from your library.'))}catch(e){toast(e.message,true)}break;
  case 'scan':await performScan();break;
  case 'repair-artwork':{button.disabled=true;try{const result=await window.orbit.repairSteamArtwork();const note=result.onlineEnabled===false?t(' Online artwork is off in Settings.'):result.paused?t(' Online artwork was paused by Performance Guard during repair.'):'';toast(t('Updated {covers} portrait covers and {icons} game icons across {games} games.{note}',{covers:formatNumber(result.found),icons:formatNumber(result.icons||0),games:formatNumber(result.attempted),note}))}catch(e){toast(e.message||t('Cover repair failed.'),true)}finally{button.disabled=false}break;}
  case 'import':await performImport();break;
  case 'toggle-all-import':{const allowed=state.imports.flatMap((g,i)=>g.alreadyAdded?[]:[i]).slice(0,MAX_IMPORT_SELECTION);state.selectedImports=state.selectedImports.size?new Set():new Set(allowed);renderModal();break;}
  case 'import-page':{
   const direction=button.dataset.page;
   state.importPage=Math.max(0,Math.min(Math.ceil(state.imports.length/IMPORT_PAGE_SIZE)-1,state.importPage+(direction==='next'?1:-1)));
   renderModal();
   const root=el('modal-root');
   const target=root.querySelector(`[data-action="import-page"][data-page="${direction}"]:not([disabled])`)
    ||root.querySelector('[data-action="import-page"]:not([disabled])')
    ||root.querySelector('[data-import-index]:not([disabled])')
    ||root.querySelector('.dialog [data-action="close-modal"]');
   target?.focus({preventScroll:true});
   break;
  }
  case 'choose-exe':{try{const file=await window.orbit.chooseExecutable();if(file){el('game-executable').value=file;await detectGameFile(file);}}catch(e){toast(e.message,true)}break;}
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
    }
    if(status)status.textContent=found.cover&&el('game-cover')?.value!==found.cover?t('Cover changed while searching; your selection was kept.'):found.message||t('No cover found.');
   }catch(e){if(status)status.textContent=e.message||t('Online artwork search unavailable.');toast(e.message,true)}
   finally{button.disabled=false}
   break;
  }
  case 'choose-art':{try{const file=await window.orbit.chooseArtwork();if(file){const key=button.dataset.key;el(`game-${key}`).value=file;el(`preview-${key}`).innerHTML=`<img src="${artwork(file)}" alt="${tr('Artwork preview')}"/>`}}catch(e){toast(e.message,true)}break;}
  case 'clear-art':{const key=button.dataset.key;const input=el(`game-${key}`),preview=el(`preview-${key}`);if(!input||!preview)break;input.value='';const fallback=key==='cover'?artwork(el('game-icon')?.value):null;preview.innerHTML=fallback?`<div class="auto-icon-preview"><img src="${fallback}" alt="${tr('Icon fallback')}" /></div>`:`<div class="image-placeholder">${ic('image',21)}</div>`;break;}

  case 'open-folder':try{await window.orbit.openGameFolder(id)}catch(e){toast(e.message,true)}break;
  case 'open-data':try{await window.orbit.openAppData()}catch(e){toast(e.message,true)}break;
  case 'clear-filters':{state.query='';state.filter='all';state.tag='all';state.genre='all';const search=el('global-search');if(search)search.value='';renderPage();break;}
  case 'view':state.view=button.dataset.view;await saveSettings({view:state.view});renderPage({keepScroll:true});break;
  case 'accent':await saveSettings({accent:button.dataset.color});break;
  case 'setting-toggle':{const key=button.dataset.key;await saveSettings({[key]:!state.settings[key]});break;}
  case 'add-folder':{try{const dir=await window.orbit.chooseFolder();if(dir){const folders=[...new Set([...state.settings.libraryFolders,dir])];await saveSettings({libraryFolders:folders});toast(t('Scan location added.'))}}catch(e){toast(e.message,true)}break;}
  case 'remove-folder':{const folders=state.settings.libraryFolders.filter((_,i)=>i!==Number(button.dataset.index));await saveSettings({libraryFolders:folders});break;}
  case 'export':try{const res=await window.orbit.exportLibrary();if(res?.path){toast(t(res.portable?'Portable library, artwork and completed play history exported.':'Library and completed play history exported as JSON (artwork not embedded).'));if(res.missingArtwork)toast(t('{count} missing or invalid artwork file(s) were not included.',{count:formatNumber(res.missingArtwork)}),true)}}catch(e){toast(e.message,true)}break;
  case 'restore':try{const res=await window.orbit.restoreLibrary();if(res){const history=Number.isInteger(res.sessionsImported)?t(' {count} play sessions added{skipped}.',{count:formatNumber(res.sessionsImported),skipped:res.sessionsSkipped?t('; {count} existing sessions skipped',{count:formatNumber(res.sessionsSkipped)}):''}):'';toast(t('Restored {imported} games; skipped {skipped}.{history}',{imported:formatNumber(res.imported),skipped:formatNumber(res.skipped),history}));if(res.errors?.length)toast(res.errors.slice(0,2).join(' · '),true)}}catch(e){toast(e.message,true)}break;
 }
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-action]');
 if(gameActionsTrigger&&button?.dataset.action!=='game-actions')closeGameActions(!!button?.closest('.game-actions-popup'));
 if(!button||button.disabled)return;
 if(button.dataset.action==='scrim'&&event.target!==button)return;
 event.preventDefault();handleAction(button).catch(e=>toast(e.message||t('Action failed.'),true));});
document.addEventListener('change',async event=>{const target=event.target;
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
 if(target.id==='tag-filter'){state.tag=target.value;renderPage();return}
 if(target.id==='genre-filter'){state.genre=target.value;renderPage();return}
 if(target.id==='sort-by'){state.sort=target.value;try{await saveSettings({sort:state.sort})}catch(e){toast(e.message,true)}renderPage({keepScroll:true});return}
 if(target.id==='theme-select'){try{await saveSettings({theme:target.value})}catch(e){toast(e.message,true)}}
 if(target.id==='language-select'){
  const language=target.value;
  try{await saveSettings({language})}catch(e){target.value=state.settings?.language||'system';toast(e.message||t('Could not save language preference.'),true)}
  return;
 }
 if(target.id==='density-select'){try{await saveSettings({libraryDensity:target.value});renderPage({keepScroll:true})}catch(e){toast(e.message,true)}}
});
let searchTimer;document.addEventListener('input',event=>{if(event.target.id!=='global-search')return;
 state.query=event.target.value;if(!['library','favorites','recent'].includes(state.route)){state.route='library';el('side-slot').innerHTML=sidebar();renderPage();}
 clearTimeout(searchTimer);searchTimer=setTimeout(()=>{if(['library','favorites','recent'].includes(state.route)){const scroller=el('main-scroll');if(scroller)scroller.scrollTop=0;renderVirtual();}},95);
});
document.addEventListener('submit',event=>{if(event.target.id==='game-form'){event.preventDefault();storeGame(event.target)}});
document.addEventListener('keydown',event=>{
 const menu=el('game-actions-popup');
 if(menu){
  if(event.key==='Escape'){event.preventDefault();closeGameActions(true);return;}
  if(event.key==='Tab'){closeGameActions(true);event.preventDefault();return;}
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)&&menu.contains(document.activeElement)){
   event.preventDefault();const items=[...menu.querySelectorAll('[role=menuitem]')];
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
 if(event.key==='Escape'&&state.modal){event.preventDefault();closeModal()}
 if((event.key==='Enter'||event.key===' ')&&event.target.matches('[role=button][data-action=detail]')){event.preventDefault();openModal('detail',{id:event.target.dataset.id})}
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
document.addEventListener('scroll',()=>{
 if(!gameActionsTrigger)return;
 const rect=gameActionsTrigger.getBoundingClientRect();
 // Browsers may deliver an already-completed scroll event after opening.
 // Close only if the actual trigger moved, not for a stale scroll event.
 if(!gameActionsAnchor||Math.abs(rect.x-gameActionsAnchor.x)>1||Math.abs(rect.y-gameActionsAnchor.y)>1)closeGameActions();
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
window.addEventListener('resize',()=>{if(['library','recent','favorites'].includes(state.route))renderVirtual()});
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
 state.games=libraryUpdates.snapshot().games;state.runningIds=data.runningIds||[];state.settings=data.settings;
 state.sort=data.settings.sort||'name';state.view=data.settings.view||'grid';state.platform=data.platform;state.version=data.version;
 applyLanguage(data.settings?.language||'system');setupTheme();renderShell();
 lastRenderedLocale=localeRenderKey();
 for(const event of buffered)handleOrbitEvent(event);
 if(typeof startDesktopPadEntry==='function')startDesktopPadEntry();
 if(typeof showWhatsNewAfterBoot==='function')showWhatsNewAfterBoot();
 // Update-service availability must not delay or prevent library startup.
 if(window.orbit.getUpdateStatus)Promise.resolve().then(()=>window.orbit.getUpdateStatus()).then(status=>{
  if(status){state.updateStatus=status;const statusNode=el('update-status');if(statusNode)statusNode.textContent=typeof t==='function'?t(status.message||''):status.message||'';}
 }).catch(error=>{
  state.updateStatus={state:'error',message:typeof t==='function'?t('Update status is unavailable.'):'Update status is unavailable.'};
  const statusNode=el('update-status');if(statusNode)statusNode.textContent=state.updateStatus.message;
  console.warn('Could not load update status:',error);
 });
 }catch(e){el('app').innerHTML=`<div class="boot"><div class="boot-logo">!</div><h2>${typeof tr==='function'?tr('Orbit could not start'):'Orbit could not start'}</h2><p>${esc(e.message||(typeof t==='function'?t('Unknown error.'):'Unknown error.'))}</p></div>`;}}

boot();
})();

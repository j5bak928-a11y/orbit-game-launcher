'use strict';
(() => {
const el=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
 dots:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
};
const ic=(name,size=18)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${iconPaths[name]||iconPaths.gamepad}</svg>`;
const state={games:[],runningIds:[],settings:null,route:'home',query:'',filter:'all',tag:'all',genre:'all',view:'grid',sort:'name',modal:null,imports:[],importPage:0,selectedImports:new Set(),scanWarnings:[],scanDiagnostics:[],pendingLaunches:new Set(),scanning:false,busy:false,platform:'',version:'',viewGames:[],updateStatus:{state:'idle',message:'Update check not started.'}};
let controllerMode=null;
function toggleControllerMode(){
 if(state.modal)closeModal();
 if(!controllerMode){
  if(!window.OrbitControllerMode)throw Error('Controller mode is unavailable. Restart Orbit to load the latest files.');
  controllerMode=window.OrbitControllerMode.create({api:window.orbit,
   snapshot:()=>({games:state.games,runningIds:state.runningIds,pendingLaunches:state.pendingLaunches}),
   launch:performLaunch,favorite,notify:toast,
   onExit:()=>{refreshNavigation(true);document.querySelector('[data-action="controller-mode"]')?.focus();}
  });
 }
 return controllerMode.toggle();
}
const sourceNames={steam:'Steam',epic:'Epic Games',gog:'GOG',ea:'EA app',ubisoft:'Ubisoft Connect',battlenet:'Battle.net',folder:'Local',manual:'Manual'};
const palette=['#8b7aff','#5bafef','#fc8ca8','#53c5b3','#f3a65c','#bf87f5'];
function artwork(token){return /^[a-f\d-]{36}\.(jpg|jpeg|png|webp)$/.test(token||'')?`orbit-art://file/${token}`:null}
function coverImage(g){const fallback=artwork(g.icon)?`<span class="cover-icon-frame"><img class="cover-icon" src="${artwork(g.icon)}" loading="lazy" alt="" /></span>`:'';const title=`<span class="cover-placeholder-symbol">${ic('gamepad',29)}</span><span class="cover-placeholder-title">${esc(g.name)}</span><span class="cover-placeholder-note">${esc(sourceLabel(g))}</span>`;const poster=artwork(g.cover)?`<img class="cover-image ${g.cover_fit==='contain'?'fit-contain':''} position-${['top','bottom'].includes(g.cover_position)?g.cover_position:'center'}" src="${artwork(g.cover)}" loading="lazy" alt="" />`:'';return fallback+title+poster;}
function timeLabel(seconds){if(!seconds)return 'Not played yet';const total=Math.max(1,Math.round(seconds/60)),hrs=Math.floor(total/60),mins=total%60;return hrs?`${hrs}h ${mins}m played`:`${total}m played`}
function sourceLabel(game){return sourceNames[game.source]||'Game'}
function formatDate(date){if(!date)return 'Never';const d=new Date(date);return Number.isNaN(d.getTime())?'Unknown':new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'}).format(d)}
function setupTheme(){const theme=state.settings?.theme||'dark';const resolved=theme==='system'&&window.matchMedia?.('(prefers-color-scheme: light)').matches?'light':theme==='system'?'dark':theme;document.body.dataset.theme=resolved;document.body.dataset.reduceMotion=String(!!state.settings?.reduceMotion);document.body.dataset.density=state.settings?.libraryDensity==='compact'?'compact':'comfortable';const accent=state.settings?.accent||palette[0];document.documentElement.style.setProperty('--accent',accent);const n=parseInt(accent.slice(1),16);document.documentElement.style.setProperty('--accent-rgb',`${n>>16},${(n>>8)&255},${n&255}`);document.documentElement.style.setProperty('--accent-ink','#11121d')}
function totalHours(){return Math.round(state.games.reduce((sum,g)=>sum+(g.total_play_seconds||0),0)/3600*10)/10}
const sortedGames=arr=>arr.slice().sort((a,b)=>state.sort==='recent'?(Date.parse(b.last_played_at||0)||0)-(Date.parse(a.last_played_at||0)||0)||a.name.localeCompare(b.name):state.sort==='added'?(Date.parse(b.created_at||0)||0)-(Date.parse(a.created_at||0)||0):state.sort==='time'?(b.total_play_seconds||0)-(a.total_play_seconds||0):a.name.localeCompare(b.name));
let filterCache=null;
function filtered(){const key=[state.games,state.route,state.filter,state.tag,state.genre,state.sort,state.query];if(filterCache&&key.every((x,i)=>filterCache.key[i]===x))return filterCache.value;let a=state.games.slice();if(state.route==='favorites')a=a.filter(g=>g.favorite);if(state.route==='recent')a=a.filter(g=>g.last_played_at);
  if(state.filter!=='all')a=a.filter(g=>g.source===state.filter);
  if(state.tag!=='all')a=a.filter(g=>g.tags?.includes(state.tag));
  if(state.genre!=='all')a=a.filter(g=>g.genre===state.genre);
  if(state.query.trim()){const q=state.query.trim().toLocaleLowerCase();a=a.filter(g=>[g.name,g.genre,g.source,...(g.tags||[])].some(v=>(v||'').toLocaleLowerCase().includes(q)));}
  const result=sortedGames(a);filterCache={key,value:result};return result;
}
function card(g){return `<article class="game-card" data-action="detail" data-id="${esc(g.id)}" role="button" tabindex="0" aria-label="View details for ${esc(g.name)}">
  <div class="cover">${coverImage(g)}<span class="cover-letter">${esc(g.name.slice(0,2))}</span><span class="cover-source">${esc(sourceLabel(g))}</span>
  <button class="favorite-float ${g.favorite?'active':''}" data-action="favorite" data-id="${esc(g.id)}" aria-label="${g.favorite?'Remove favorite':'Add favorite'}">${ic('heart',16)}</button>
  <button class="cover-play" data-action="launch" data-id="${esc(g.id)}" aria-label="Launch ${esc(g.name)}">${ic('play',17)}</button></div>
  <div class="game-label"><div style="min-width:0"><span class="game-name" title="${esc(g.name)}">${esc(g.name)}</span><span class="game-meta">${state.runningIds?.includes(g.id)?'● Playing now':esc(timeLabel(g.total_play_seconds))}</span></div>
  <button class="game-menu" data-action="detail" data-id="${esc(g.id)}" aria-label="More about ${esc(g.name)}">${ic('dots',18)}</button></div></article>`}
function rowGame(g){return `<article class="game-row" data-action="detail" data-id="${esc(g.id)}" tabindex="0" role="button" aria-label="View ${esc(g.name)}">
  <div class="row-cover">${esc(g.name.slice(0,1))}${artwork(g.icon)?`<img src="${artwork(g.icon)}" alt="" loading="lazy" class="list-game-icon" />`:''}${artwork(g.cover)?`<img src="${artwork(g.cover)}" alt="" loading="lazy" />`:''}</div>
  <div class="row-info"><h3>${esc(g.name)}</h3><p>${esc(sourceLabel(g))}${g.tags?.length?' · '+esc(g.tags.slice(0,2).join(', ')):''}</p></div>
  <div class="row-right"><span class="playtime">${esc(timeLabel(g.total_play_seconds))}</span><button class="ghost-btn" data-action="favorite" data-id="${esc(g.id)}" aria-label="Toggle favorite" style="${g.favorite?'color:#ffc171':''}">${ic('heart',17)}</button><button class="ghost-btn row-play" data-action="launch" data-id="${esc(g.id)}">${ic('play',15)} Play</button></div></article>`}
function sidebar(){const links=[['home','home','Overview'],['library','library','All games'],['favorites','heart','Favorites'],['recent','clock','Recently played']];return `<aside class="sidebar">
 <div class="brand" role="img" aria-label="Orbit Launcher"><img class="orbit-brand-mark" src="../../assets/branding/orbit-generated-mark.png" alt="" /><span class="orbit-brand-word" aria-hidden="true">orbit</span></div>
 <div class="side-label">LIBRARY</div><nav class="nav" aria-label="Main navigation">${links.map(([id,icon,name])=>`<button class="nav-item ${state.route===id?'active':''}" data-action="navigate" data-route="${id}" title="${name}" ${state.route===id?'aria-current="page"':''}>${ic(icon,18)}<span>${name}</span>${id==='library'?`<span class="count">${state.games.length}</span>`:''}</button>`).join('')}</nav>
 <div class="side-divider"></div><nav class="nav"><button class="nav-item" data-action="shuffle" title="Choose a game" ${state.games.length?'':'disabled'}>${ic('sparkles',18)}<span>Choose a game</span></button><button class="nav-item ${state.route==='settings'?'active':''}" data-action="navigate" data-route="settings" title="Settings">${ic('settings',18)}<span>Settings</span></button></nav>
 <div class="side-bottom"><div class="side-version"><span class="status-dot"></span><span>${state.scanning?'Scanning your games…':'Local library'} <span class="version-number">v${esc(state.version)}</span></span></div></div></aside>`}
function topbar(){const name={home:'Overview',library:'My library',favorites:'Favorites',recent:'Recently played',settings:'Settings'}[state.route]||'Overview';return `<header class="topbar"><div class="breadcrumb">${name}</div>
 <div class="topbar-right"><label class="searchbox">${ic('search',18)}<input id="global-search" type="search" placeholder="Search your library" value="${esc(state.query)}" autocomplete="off" aria-label="Search games"/><kbd>Ctrl K</kbd></label>
 <button class="top-icon" data-action="controller-mode" title="Controller mode (F11)" aria-label="Enter controller mode">${ic('gamepad',18)}</button>${['library','favorites','recent'].includes(state.route)?'':`<button class="top-icon" data-action="scan" title="Discover installed games" aria-label="Discover installed games">${ic('refresh',18)}</button>`}
 <button class="primary-btn" data-action="add">${ic('plus',18)}<span>Add game</span></button></div></header>`}
function headline(eyebrow,title,subtitle,buttons=''){return `<div class="page-heading"><div>${eyebrow?`<div class="eyebrow"><i></i>${esc(eyebrow)}</div>`:''}<h1 class="page-title">${esc(title)}</h1>${subtitle?`<p class="page-intro">${esc(subtitle)}</p>`:''}</div>${buttons}</div>`}
function platformFilters(){
 const scope=state.route==='favorites'?state.games.filter(g=>g.favorite):state.route==='recent'?state.games.filter(g=>g.last_played_at):state.games;
 const counts=new Map();for(const game of scope)counts.set(game.source,(counts.get(game.source)||0)+1);
 return `<div class="platform-filters" role="group" aria-label="Filter by platform"><button class="platform-chip ${state.filter==='all'?'active':''}" data-action="platform" data-source="all" aria-pressed="${state.filter==='all'}">All games <span>${scope.length}</span></button>${Object.entries(sourceNames).filter(([key])=>counts.has(key)).map(([key,label])=>`<button class="platform-chip ${state.filter===key?'active':''}" data-action="platform" data-source="${key}" aria-pressed="${state.filter===key}"><i class="source-dot source-${key}"></i>${esc(label)}<span>${counts.get(key)}</span></button>`).join('')}</div>`;
}
function activeFilterSummary(){const active=[state.query.trim()&&`“${state.query.trim()}”`,state.filter!=='all'&&(sourceNames[state.filter]||state.filter),state.genre!=='all'&&state.genre,state.tag!=='all'&&state.tag].filter(Boolean);return active.length?`<span>Showing ${active.map(esc).join(' · ')}</span><button class="small-link" data-action="clear-filters">Clear filters ${ic('close',13)}</button>`:''}
function continueCard(g){return `<article class="continue-card" data-action="detail" data-id="${esc(g.id)}" role="button" tabindex="0" aria-label="View details for ${esc(g.name)}"><div class="continue-art">${coverImage(g)}</div><div class="continue-copy"><strong>${esc(g.name)}</strong><span>${esc(timeLabel(g.total_play_seconds))}</span></div><button class="continue-play" data-action="launch" data-id="${esc(g.id)}" aria-label="Launch ${esc(g.name)}">${ic('play',16)}</button></article>`}
function home(){
 const played=state.games.filter(g=>g.last_played_at).sort((a,b)=>(Date.parse(b.last_played_at)||0)-(Date.parse(a.last_played_at)||0));
 const feature=played[0]||state.games.find(g=>artwork(g.banner))||state.games[0];
 const recent=played.slice(0,3),collection=sortedGames(state.games).slice(0,6);
 const banner=feature&&artwork(feature.banner);
 return `<section class="page home-page">${headline('','Overview','',state.games.length?`<button class="secondary-btn shuffle-btn" data-action="shuffle">${ic('sparkles',16)} Choose for me</button>`:'')}
 <div class="hero ${banner?'has-banner':''} ${feature?'':'hero-empty'}">
 ${banner?`<img class="hero-art" src="${banner}" alt="" />`:feature?`<div class="hero-portrait"><div class="cover">${coverImage(feature)}</div></div>`:''}
 <div class="hero-shade"></div><div class="hero-content"><span class="hero-eyebrow">${feature?(played.length?'CONTINUE PLAYING':'YOUR LIBRARY'):'WELCOME TO ORBIT'}</span>
 <h2>${feature?esc(feature.name):'Add your first game'}</h2>
 ${feature?`<div class="hero-metadata"><span>${esc(sourceLabel(feature))}</span>${feature.genre?`<i></i><span>${esc(feature.genre)}</span>`:''}<i></i><span>${esc(timeLabel(feature.total_play_seconds))}</span></div><p>${played.length?`Last played ${esc(formatDate(feature.last_played_at))}.`:''}</p>`:'<p>Bring your installed games together in a library that feels like yours. Start with your launchers or a folder you choose.</p>'}
 <div class="hero-buttons">${feature?`<button class="primary-btn" data-action="launch" data-id="${esc(feature.id)}">${ic('play',16)} Play now</button><button class="secondary-btn hero-detail" data-action="detail" data-id="${esc(feature.id)}">Game details ${ic('arrow',16)}</button>`:`<button class="primary-btn" data-action="scan">${ic('refresh',16)} Find my games</button><button class="secondary-btn" data-action="add">${ic('plus',16)} Add a game</button>`}</div></div>
 ${feature?`<div class="hero-caption">${ic('gamepad',14)} IN YOUR COLLECTION</div>`:''}</div>
 <div class="collection-summary"><span><strong>${state.games.length}</strong> ${state.games.length===1?'game':'games'} in your library</span><span><strong>${state.games.filter(g=>g.favorite).length}</strong> favorites</span><span><strong>${totalHours()}h</strong> tracked play time</span><button class="small-link" data-action="navigate" data-route="library">Open library ${ic('arrow',14)}</button></div>
 ${recent.length?`<div class="subheading"><h2>Continue playing</h2><button class="small-link" data-action="navigate" data-route="recent">Recently played ${ic('arrow',14)}</button></div><div class="continue-grid">${recent.map(continueCard).join('')}</div>`:''}
 <div class="subheading collection-heading"><div><h2>Your collection</h2></div>${state.games.length?`<button class="small-link" data-action="navigate" data-route="library">View all ${state.games.length} ${ic('arrow',14)}</button>`:''}</div>
 <div id="platform-filter-slot">${platformFilters()}</div>
 ${state.games.length?`<div class="games-grid home-games">${collection.map(card).join('')}</div>`:emptyState('Your next favorite belongs here.','Find games from Steam, Epic, GOG, and other installed launchers, or add your own.')}</section>`;
}
function emptyState(title,body,extra=''){return `<div class="empty-state"><div class="empty-illustration">${ic('gamepad',47)}</div><h2>${esc(title)}</h2><p>${esc(body)}</p><div class="empty-actions">${extra||`<button class="primary-btn" data-action="scan">${ic('refresh',16)} Discover games</button><button class="secondary-btn" data-action="add">${ic('plus',16)} Add game</button>`}</div></div>`}
function libraryView(){const subtitle={library:'',favorites:'',recent:''};const title={library:'Your game library',favorites:'Your favorites',recent:'Recently played'};const tags=[...new Set(state.games.flatMap(g=>g.tags||[]))].sort((a,b)=>a.localeCompare(b)).slice(0,100);const genres=[...new Set(state.games.map(g=>g.genre).filter(Boolean))].sort((a,b)=>a.localeCompare(b)).slice(0,100);
 return `<section class="page library-page">${headline('',title[state.route],subtitle[state.route],`<button class="secondary-btn" data-action="scan">${ic('refresh',15)} Scan for games</button>`)}
 <div id="platform-filter-slot">${platformFilters()}</div><div class="library-controls"><div class="control-left"><span class="library-count" id="game-result-count">${filtered().length} games</span>
 <div class="select-wrap"><select id="genre-filter" aria-label="Filter by category"><option value="all" ${state.genre==='all'?'selected':''}>All categories</option>${genres.map(g=>`<option value="${esc(g)}" ${state.genre===g?'selected':''}>${esc(g)}</option>`).join('')}</select></div>
 <div class="select-wrap"><select id="tag-filter" aria-label="Filter by tag"><option value="all" ${state.tag==='all'?'selected':''}>All tags</option>${tags.map(t=>`<option value="${esc(t)}" ${state.tag===t?'selected':''}>${esc(t)}</option>`).join('')}</select></div></div>
 <div class="control-right"><div class="select-wrap"><select id="sort-by" aria-label="Sort games"><option value="name" ${state.sort==='name'?'selected':''}>Name A–Z</option><option value="recent" ${state.sort==='recent'?'selected':''}>Recently played</option><option value="added" ${state.sort==='added'?'selected':''}>Recently added</option><option value="time" ${state.sort==='time'?'selected':''}>Play time</option></select></div>
 <div class="view-switch" aria-label="Library display"><button data-action="view" data-view="grid" class="${state.view==='grid'?'selected':''}" aria-label="Grid view" aria-pressed="${state.view==='grid'}">${ic('grid',16)}</button><button data-action="view" data-view="list" class="${state.view==='list'?'selected':''}" aria-label="List view" aria-pressed="${state.view==='list'}">${ic('list',16)}</button></div></div></div>
 <div id="active-filters" class="active-filters" aria-live="polite">${activeFilterSummary()}</div><div id="library-area" class="virtual-area">${state.games.length?'<div id="virtual-games"></div>':emptyState('No games yet','Scan your installed launchers or add a game manually.')}</div></section>`;
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
 const host=el('virtual-games');if(!host)return;
 const games=filtered();state.viewGames=games;
 const count=el('game-result-count'),label=`${games.length} ${games.length===1?'game':'games'}`;
 if(count&&count.textContent!==label)count.textContent=label;
 const summary=el('active-filters'),filterSummary=activeFilterSummary();if(summary&&summary.innerHTML!==filterSummary)summary.innerHTML=filterSummary;
 const focus=captureGameFocus(host);
 if(!games.length){
  if(virtualRangeKey==='empty'&&virtualGamesRef===games)return;
  virtualRangeKey='empty';virtualGamesRef=games;virtualItems=new Map();
  host.innerHTML=emptyState(state.query?'No matching games':state.route==='favorites'?'No favorites yet':state.route==='recent'?'No games played yet':'Nothing here yet',state.query?'Try another search or clear filters.':state.route==='favorites'?'Mark games with the heart icon to see them here.':state.route==='recent'?'Launch a game and it will appear here.':'Try changing the platform or tag filters.',(state.query||state.filter!=='all'||state.tag!=='all'||state.genre!=='all')?`<button class="secondary-btn" data-action="clear-filters">Clear filters</button>`:`<button class="secondary-btn" data-action="navigate" data-route="library">Browse library ${ic('arrow',15)}</button>`);
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
function settingsView(){const s=state.settings,folders=s.libraryFolders||[];return `<section class="page">${headline('','Settings','')}
 <div class="settings-layout"><div class="settings-stack">
 <div class="settings-card"><h2>Appearance</h2>
 <div class="setting-row"><div><div class="setting-name">Theme</div><div class="setting-help">Choose a color mode for the launcher.</div></div><div class="select-wrap setting-control"><select id="theme-select" aria-label="Theme"><option value="dark" ${s.theme==='dark'?'selected':''}>Dark</option><option value="light" ${s.theme==='light'?'selected':''}>Light</option><option value="system" ${s.theme==='system'?'selected':''}>System</option></select></div></div>
 <div class="setting-row"><div><div class="setting-name">Accent color</div></div><div class="accent-swatches setting-control">${palette.map(c=>`<button class="swatch ${s.accent.toLowerCase()===c?'chosen':''}" style="--sw:${c}" data-action="accent" data-color="${c}" aria-label="Set accent color ${c}"></button>`).join('')}</div></div>
 <div class="setting-row"><div><div class="setting-name">Reduce motion</div><div class="setting-help">Limit animation and transitions.</div></div><button class="switch ${s.reduceMotion?'on':''}" data-action="setting-toggle" data-key="reduceMotion" role="switch" aria-checked="${s.reduceMotion}" aria-label="Reduce motion"></button></div>
 <div class="setting-row"><div><div class="setting-name">Library density</div><div class="setting-help">Choose comfortable or compact game cards.</div></div><div class="select-wrap setting-control"><select id="density-select" aria-label="Library density"><option value="comfortable" ${s.libraryDensity!=='compact'?'selected':''}>Comfortable</option><option value="compact" ${s.libraryDensity==='compact'?'selected':''}>Compact</option></select></div></div></div>
 <div class="settings-card"><h2>Performance & updates</h2><p>Keep game performance first. Orbit remains available in the tray for playtime tracking.</p>
 <div class="setting-row"><div><div class="setting-name">Performance Guard</div><div class="setting-help">Hide Orbit's window after a confirmed game start on Windows, keeping your edits open.</div></div><button class="switch ${s.performanceGuard?'on':''}" data-action="setting-toggle" data-key="performanceGuard" role="switch" aria-checked="${!!s.performanceGuard}" aria-label="Performance Guard"></button></div>
 <div class="setting-row"><div><div class="setting-name">Automatic updates</div><div class="setting-help">Unavailable until signed releases are configured. Your preference is saved for later.</div></div><button class="switch ${s.autoUpdates?'on':''}" data-action="setting-toggle" data-key="autoUpdates" role="switch" aria-checked="${!!s.autoUpdates}" aria-label="Automatic updates"></button></div>
 <div class="setting-row"><div><div class="setting-name">Update status</div><div class="setting-help" id="update-status" role="status" aria-live="polite">${esc(state.updateStatus?.message||'Checking availability…')}</div></div><div class="setting-control" style="display:flex;gap:8px"><button class="secondary-btn" data-action="check-update">Check now</button>${state.updateStatus?.state==='ready'?'<button class="primary-btn" data-action="install-update">Install update</button>':''}</div></div></div>
 <div class="settings-card"><h2>Library discovery</h2><p>Orbit searches installed game stores and folders you select. Downloads is never scanned automatically.</p>
 <div class="setting-row"><div><div class="setting-name">Scan at startup</div><div class="setting-help">Look for new games whenever Orbit starts.</div></div><button class="switch ${s.autoScan?'on':''}" data-action="setting-toggle" data-key="autoScan" role="switch" aria-checked="${s.autoScan}" aria-label="Scan at startup"></button></div>
 <div class="setting-row"><div><div class="setting-name">Online artwork</div><div class="setting-help">Find covers using Steam and Epic Games when online.</div></div><button class="switch ${s.useSteamArtwork?'on':''}" data-action="setting-toggle" data-key="useSteamArtwork" role="switch" aria-checked="${s.useSteamArtwork}" aria-label="Online artwork downloads"></button></div>
 <div class="setting-row"><div><div class="setting-name">Missing or incorrect covers</div><div class="setting-help">Find portrait artwork, and use installed game EXE icons when no cover is available. Valid portrait covers are preserved.</div></div><button class="secondary-btn" data-action="repair-artwork">${ic('refresh',14)} Repair library covers</button></div>
 <div class="setting-row"><div><div class="setting-name">Custom library locations</div><div class="setting-help">Optional folders to scan for game executables and GOG info files.</div></div><button class="secondary-btn" data-action="add-folder">${ic('plus',14)} Add folder</button></div>
 <div class="folder-list">${folders.length?folders.map((f,index)=>`<div class="folder-item">${ic('folder',15)}<span title="${esc(f)}">${esc(f)}</span><button data-action="remove-folder" data-index="${index}" aria-label="Remove folder">${ic('close',15)}</button></div>`).join(''):'<span class="setting-help">No custom folders yet. Steam, Epic and GOG discovery works independently.</span>'}</div><div style="margin-top:16px"><button class="secondary-btn" data-action="scan">${ic('refresh',15)} Scan now</button></div></div>
 <div class="settings-card"><h2>Data & privacy</h2><p>Your collection lives in a local SQLite database. Orbit does not require an account.</p>
 <div class="setting-row"><div><div class="setting-name">Application data</div><div class="setting-help">Browse your database, artwork cache, and preferences.</div></div><button class="secondary-btn" data-action="open-data">${ic('folder',15)} Open folder</button></div>
 <div class="setting-row"><div><div class="setting-name">Library backup</div><div class="setting-help">Portable .orbit backups include artwork and metadata. JSON exports contain metadata only.</div></div><div class="setting-control" style="display:flex;gap:7px"><button class="secondary-btn" data-action="export">${ic('download',15)} Export</button><button class="secondary-btn" data-action="restore">${ic('upload',15)} Restore</button></div></div></div>
 </div></div></section>`;
}
function renderShell(){el('app').innerHTML=`<div class="app-shell"><div id="side-slot">${sidebar()}</div><div class="workspace"><div id="top-slot">${topbar()}</div><main class="content-scroll" id="main-scroll" tabindex="-1"><div id="page-slot"></div></main></div></div>`;el('main-scroll').addEventListener('scroll',()=>{if(['library','favorites','recent'].includes(state.route)&&!scrollFrame){scrollFrame=requestAnimationFrame(()=>{scrollFrame=null;renderVirtual()})}},{passive:true});renderPage()}
let scrollFrame=null;
function renderPage({keepScroll=false}={}){const slot=el('page-slot'),scroller=el('main-scroll');if(!slot)return;const old=keepScroll?scroller.scrollTop:0;
 virtualRangeKey=null;virtualGamesRef=null;virtualRunningRef=null;virtualItems=new Map();
 slot.innerHTML=state.route==='home'?home():state.route==='settings'?settingsView():libraryView();scroller.scrollTop=old;
 if(['library','favorites','recent'].includes(state.route))renderVirtual();syncActivity();}
function refreshNavigation(keepScroll=false){el('side-slot').innerHTML=sidebar();el('top-slot').innerHTML=topbar();renderPage({keepScroll});}
function navigate(route){if(!['home','library','favorites','recent','settings'].includes(route))return;state.route=route;state.query='';state.filter='all';state.tag='all';state.genre='all';refreshNavigation();}
function toast(message,error=false){const item=document.createElement('div');item.className=`toast ${error?'error':''}`;item.innerHTML=ic(error?'alert':'check',19)+`<p>${esc(message)}</p>`;const root=el('toast-root');root.appendChild(item);while(root.children.length>3)root.firstElementChild.remove();setTimeout(()=>item.remove(),4600)}
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
 if(controllerMode?.active){controllerMode.update();return;}
 const count=el('side-slot')?.querySelector('[data-route="library"] .count');
 if(count&&count.textContent!==String(state.games.length))count.textContent=String(state.games.length);
 if(['library','favorites','recent'].includes(state.route)){
  if(change.reset||!el('virtual-games')||!state.games.length){
   const focus=captureGameFocus(el('page-slot'));renderPage({keepScroll:true});restoreGameFocus(el('page-slot'),focus);
  }else{
   refreshFilterOptions('genre-filter',state.games.map(game=>game.genre),'All categories',state.genre);
   refreshFilterOptions('tag-filter',state.games.flatMap(game=>game.tags||[]),'All tags',state.tag);
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
 if(event.type==='settingsChanged'){state.settings=event.settings;setupTheme();}
 if(event.type==='updateStatus'){state.updateStatus=event.status;const status=el('update-status');if(status)status.textContent=event.status.message||'';if(state.route==='settings'&&event.status.state==='ready')renderPage({keepScroll:true});}
 if(event.type==='windowState')controllerMode?.windowState(event);
 if(event.type==='toggleControllerMode')Promise.resolve().then(toggleControllerMode).catch(error=>toast(error.message,true));
 if(event.type==='error')toast(event.message,true);
}
async function saveSettings(patch){state.settings=await window.orbit.saveSettings(patch);setupTheme();if(state.route==='settings')renderPage({keepScroll:true});}
let modalReturnFocus=null;
function openModal(type,meta={}){if(!state.modal)modalReturnFocus=document.activeElement;state.modal={type,...meta};renderModal()}
function closeModal(){state.modal=null;el('modal-root').innerHTML='';if(modalReturnFocus?.isConnected)modalReturnFocus.focus({preventScroll:true});modalReturnFocus=null}
function dialogFrame(title,description,body,footer='',wide=false){return `<div class="dialog-scrim" data-action="scrim"><section class="dialog ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-header"><div><h2 id="dialog-title">${esc(title)}</h2><p>${esc(description)}</p></div><button class="ghost-btn" data-action="close-modal" aria-label="Close dialog">${ic('close',21)}</button></div>${body}${footer}</section></div>`}
function editor(g){const isEdit=!!g;const title=isEdit?'Edit game':'Add a game';const params=Array.isArray(g?.launch_args)?JSON.stringify(g.launch_args):'[]';
 const imgSection=(key,label)=>`<div class="image-upload"><div id="preview-${key}">${artwork(g?.[key])?`<img src="${artwork(g[key])}" alt="${label} preview" />`:key==='cover'&&artwork(g?.icon)?`<div class="auto-icon-preview"><img src="${artwork(g.icon)}" alt="Icon fallback" /></div>`:`<div class="image-placeholder">${ic('image',21)}</div>`}</div><div style="flex:1"><p>${label}</p><small>${key==='icon'?'Used when no cover exists':'PNG, JPEG or WebP'}</small></div><button type="button" class="secondary-btn" data-action="choose-art" data-key="${key}">Choose</button><button type="button" class="small-link" data-action="clear-art" data-key="${key}" aria-label="Clear ${label}">Clear</button></div>`;
 return dialogFrame(title,isEdit?'Update this game without changing its installation.':'Select any locally installed game executable. Orbit recognizes known game filenames and looks for cover art or an icon.',`<form id="game-form" data-form="game" data-id="${esc(g?.id||'')}"><div class="dialog-body">
  <div class="field"><label for="game-name">Game title *</label><input id="game-name" name="name" type="text" maxlength="140" value="${esc(g?.name||'')}" placeholder="For example, Hollow Knight" required /></div>
  <div class="field"><label for="game-executable">Executable</label><div class="file-field"><input id="game-executable" name="executable" type="text" value="${esc(g?.executable||'')}" placeholder="Select the game executable" /><button type="button" class="secondary-btn" data-action="choose-exe">${ic('folder',16)} Browse .exe</button></div><div class="file-extras"><button type="button" class="small-link" data-action="find-art">${ic('sparkles',14)} Detect game &amp; icon</button><span id="game-detection-status" role="status" aria-live="polite"></span></div></div>
  <div class="field"><label for="game-uri">Launcher URI (optional)</label><input id="game-uri" name="launch_uri" value="${esc(g?.launch_uri||'')}" type="text" placeholder="steam://rungameid/12345" /><small>Orbit launches through the associated game launcher. On Windows, add the actual game executable for playtime tracking.</small></div>
  <div class="field-grid"><div class="field"><label for="game-workdir">Working directory</label><input id="game-workdir" name="working_dir" type="text" value="${esc(g?.working_dir||'')}" placeholder="Defaults to executable folder" /></div><div class="field"><label for="game-genre">Genre</label><input id="game-genre" name="genre" type="text" maxlength="100" value="${esc(g?.genre||'')}" placeholder="Adventure, RPG, Strategy…" /></div></div>
  <div class="field-grid"><div class="field"><label for="game-tags">Tags</label><input id="game-tags" name="tags" value="${esc((g?.tags||[]).join(', '))}" type="text" placeholder="Co-op, Story, Competitive" /><small>Separate multiple tags with commas.</small></div><div class="field"><label for="game-args">Launch arguments</label><input id="game-args" name="launch_args" type="text" value="${esc(params)}" placeholder='["--fullscreen"]' /><small>Enter a JSON array, e.g. ["--fullscreen", "--safe-mode"].</small></div></div>
  <div class="image-fields">${imgSection('cover','Cover artwork')}${imgSection('banner','Banner artwork')}${imgSection('icon','Game icon')}</div>
  <div class="field cover-search"><label for="cover-search-title">Find a cover online</label><div class="file-field"><input id="cover-search-title" type="text" maxlength="140" placeholder="Use game title, or enter a different title" autocomplete="off" /><button type="button" class="secondary-btn" data-action="find-online-art">${ic('search',14)} Search</button></div><small>Search Steam and Epic Games. The preview changes only when a cover is found; save to apply it.</small><span id="cover-search-status" role="status" aria-live="polite"></span></div>
  <div class="field-grid"><div class="field"><label for="game-cover-fit">Cover presentation</label><select id="game-cover-fit" name="cover_fit"><option value="cover" ${g?.cover_fit!=='contain'?'selected':''}>Fill frame</option><option value="contain" ${g?.cover_fit==='contain'?'selected':''}>Fit entire artwork</option></select></div><div class="field"><label for="game-cover-position">Cover position</label><select id="game-cover-position" name="cover_position"><option value="center" ${!['top','bottom'].includes(g?.cover_position)?'selected':''}>Center</option><option value="top" ${g?.cover_position==='top'?'selected':''}>Top</option><option value="bottom" ${g?.cover_position==='bottom'?'selected':''}>Bottom</option></select></div></div>
  <input type="hidden" id="game-cover" name="cover" value="${esc(g?.cover||'')}"/><input type="hidden" id="game-banner" name="banner" value="${esc(g?.banner||'')}"/><input type="hidden" id="game-icon" name="icon" value="${esc(g?.icon||'')}"/>
  </div><div class="dialog-footer"><button type="button" class="secondary-btn" data-action="close-modal">Cancel</button><button type="submit" class="primary-btn">${ic('check',16)} ${isEdit?'Save changes':'Add to library'}</button></div></form>`, '',true);
}
function detail(g){if(!g)return dialogFrame('Game unavailable','This game no longer exists.','<div class="dialog-body">Please refresh the library.</div>');
 const tags=(g.tags||[]).map(t=>`<span class="detail-tag">${esc(t)}</span>`).join('');
 const playing=state.runningIds.includes(g.id);
 return dialogFrame(g.name,`${sourceLabel(g)} · Added ${formatDate(g.created_at)}`,`<div class="dialog-body"><div class="detail-cover"><div class="cover">${coverImage(g)}<span class="cover-letter">${esc(g.name.slice(0,2))}</span></div>
 <div><h2 class="detail-title">${esc(g.name)}</h2>${g.genre?`<span class="detail-tag">${esc(g.genre)}</span>`:''}${tags||'<span class="detail-tag">No tags yet</span>'}
 <div class="detail-stat">${ic('gamepad',15)} ${esc(sourceLabel(g))}${g.source_id?` · ${esc(g.source_id)}`:''}</div>
 <div class="detail-playtime"><div class="detail-playtime-label">${ic('clock',15)} <span>PLAYTIME</span>${playing?'<span class="detail-live">● Playing now</span>':''}</div><strong class="detail-playtime-value">${esc(playing&&!g.total_play_seconds?'First session in progress':timeLabel(g.total_play_seconds))}</strong><span class="detail-playtime-caption">${playing?'Time updates when the session ends':`Last played ${esc(formatDate(g.last_played_at))}`}</span></div>
 <div class="detail-actions"><button class="primary-btn" data-action="launch" data-id="${esc(g.id)}">${ic('play',16)} Play game</button><button class="secondary-btn" data-action="favorite" data-id="${esc(g.id)}">${ic('heart',16)} ${g.favorite?'Unfavorite':'Favorite'}</button></div></div></div>
 ${artwork(g.banner)?`<img class="detail-banner" src="${artwork(g.banner)}" alt="Game banner" />`:''}
 <div class="hr"></div><div class="detail-stat">${ic('folder',15)} <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(g.install_path||g.executable||'')}" >${esc(g.install_path||g.executable||'No install path saved')}</span></div>
 ${g.launch_uri?`<p class="detail-note">Starts through ${esc(sourceLabel(g))}. Orbit confirms playtime once the game process is detected. Add the actual executable if detection fails; keep Orbit running in the tray.</p>`:g.executable?'<p class="detail-note">Direct executable launches count play time while Orbit is running and the launched process remains open.</p>':'<p class="detail-note">A valid executable or game launcher URI is required to launch this title.</p>'}
 </div>`,`<div class="dialog-footer"><button class="danger-btn" data-action="remove-confirm" data-id="${esc(g.id)}">${ic('trash',15)} Remove</button><button class="secondary-btn" data-action="open-folder" data-id="${esc(g.id)}">${ic('folder',15)} Location</button><button class="secondary-btn" data-action="edit" data-id="${esc(g.id)}">${ic('edit',15)} Edit</button><button class="secondary-btn" data-action="close-modal">Done</button></div>`,true);
}
const IMPORT_PAGE_SIZE=100;
const MAX_IMPORT_SELECTION=10000;
function importDialog(){
 const games=state.imports,addable=games.filter(g=>!g.alreadyAdded),selected=state.selectedImports.size;
 const pageCount=Math.max(1,Math.ceil(games.length/IMPORT_PAGE_SIZE));
 state.importPage=Math.min(state.importPage,pageCount-1);
 const first=state.importPage*IMPORT_PAGE_SIZE;
 const description=`Found ${games.length} installed ${games.length===1?'game':'games'}. ${addable.length} new ${addable.length===1?'entry':'entries'} can be imported.`;
 const diagnostics=scanDiagnostics();
 const warnings=state.scanWarnings.length?`<div class="warning-line">${ic('alert',15)} ${esc(state.scanWarnings.slice(0,3).join(' • '))}${state.scanWarnings.length>3?` · ${state.scanWarnings.length-3} more warnings`:''}</div>`:'';
 const rows=games.slice(first,first+IMPORT_PAGE_SIZE).map((g,offset)=>{const i=first+offset;return `<label class="import-item ${g.alreadyAdded?'added':''}"><input type="checkbox" data-import-index="${i}" ${state.selectedImports.has(i)?'checked':''} ${g.alreadyAdded?'disabled':''}/><div class="icon-box">${ic(g.source==='steam'?'gamepad':'folder',18)}</div><span style="min-width:0;flex:1"><strong>${esc(g.name)}</strong><small>${esc(sourceLabel(g))} · ${esc(g.install_path||g.executable||'Launcher entry')}${g.alreadyAdded?' · Already in library':''}</small></span></label>`}).join('');
 const paging=pageCount>1?`<div class="import-toolbar" aria-label="Import result pages"><span class="muted" style="font-size:12px">Showing ${first+1}–${Math.min(games.length,first+IMPORT_PAGE_SIZE)} of ${games.length} (page ${state.importPage+1} of ${pageCount})</span><div style="display:flex;gap:8px"><button class="secondary-btn" data-action="import-page" data-page="prev" ${state.importPage===0?'disabled':''}>Previous</button><button class="secondary-btn" data-action="import-page" data-page="next" ${state.importPage===pageCount-1?'disabled':''}>Next</button></div></div>`:'';
 const selectionHint=addable.length>MAX_IMPORT_SELECTION?`<p class="setting-help">Each import supports up to ${MAX_IMPORT_SELECTION.toLocaleString()} games. Import the selected games, then rescan to import the remaining titles.</p>`:'';
 return dialogFrame('Discover installed games',description,`<div class="dialog-body">${warnings}${diagnostics}<div class="import-toolbar"><span class="muted" style="font-size:12px">${selected} selected across all pages</span><button class="small-link" data-action="toggle-all-import">${selected?'Deselect all':'Select all new'}</button></div>${games.length?`<div class="import-list">${rows}</div>${paging}${selectionHint}`:emptyState('No installed games found','Add your preferred library folders in Settings or add an executable manually.',`<button class="secondary-btn" data-action="add">${ic('plus',15)} Add manually</button>`)}</div>`,`<div class="dialog-footer"><button class="secondary-btn" data-action="close-modal">Cancel</button><button class="primary-btn" data-action="import" ${selected?'':'disabled'}>${ic('download',16)} Import ${selected} ${selected===1?'game':'games'}</button></div>`,true);
}
function renderModal(){const modal=state.modal;if(!modal){el('modal-root').innerHTML='';return}let html='';
 if(modal.type==='game')html=editor(modal.id?state.games.find(g=>g.id===modal.id):null);
 else if(modal.type==='detail')html=detail(state.games.find(g=>g.id===modal.id));
 else if(modal.type==='scan')html=dialogFrame('Scanning your games','Looking through installed launchers and selected library folders.',`<div class="dialog-body" style="display:grid;place-items:center;min-height:200px;text-align:center;color:var(--muted)"><div>${ic('refresh',42)}<p>Scanning local manifests and folders…</p></div></div>`);
 else if(modal.type==='import')html=importDialog();
 else if(modal.type==='remove'){const g=state.games.find(x=>x.id===modal.id);html=dialogFrame('Remove from library?',`Remove ${g?.name||'this game'} from Orbit. Installed files will remain untouched.`,`<div class="dialog-body"><p style="color:var(--muted)">This removes the library entry, custom metadata and tracked play time. It does not uninstall the game.</p></div>`,`<div class="dialog-footer"><button class="secondary-btn" data-action="close-modal">Keep game</button><button class="danger-btn" data-action="remove" data-id="${esc(modal.id)}">${ic('trash',15)} Remove game</button></div>`)}
 el('modal-root').innerHTML=html;
 syncActivity();
 const dialog=el('modal-root').querySelector('.dialog');if(dialog){dialog.setAttribute('tabindex','-1');dialog.focus({preventScroll:true});}
}
async function performScan(){if(state.scanning){openModal('scan');return;}state.scanning=true;syncActivity();openModal('scan');
 try{const results=await window.orbit.discoverGames();if(state.modal?.type!=='scan')return;state.imports=results.games;state.importPage=0;state.scanWarnings=results.warnings||[];state.scanDiagnostics=results.diagnostics||[];state.selectedImports=new Set(results.games.flatMap((g,i)=>g.alreadyAdded?[]:[i]).slice(0,MAX_IMPORT_SELECTION));openModal('import')}
 catch(e){if(state.modal?.type==='scan')closeModal();toast(e.message||'Scan failed',true)}finally{state.scanning=false;syncActivity();}
}
async function performImport(){const games=[...state.selectedImports].map(i=>state.imports[i]).filter(x=>x&&!x.alreadyAdded).map(({alreadyAdded,...rest})=>rest);if(!games.length)return;
 const button=el('modal-root').querySelector('[data-action=import]');if(button)button.disabled=true;
 try{const result=await window.orbit.importGames(games);closeModal();toast(`Imported ${result.imported} ${result.imported===1?'game':'games'}.${result.skipped?' '+result.skipped+' already in library.':''}`);if(result.errors.length)toast(result.errors.slice(0,3).join(' · '),true)}
 catch(e){toast(e.message||'Import failed.',true);if(button)button.disabled=false}
}
function scanDiagnostics(){
 if(!state.scanDiagnostics.length)return '';
 const names={...sourceNames,'gog-registry':'GOG registry',heroic:'Heroic',legendary:'Legendary','windows-stores':'Windows launchers',folder:'Selected folders'};
 return `<details class="scan-diagnostics"><summary>Scan report <span>${state.scanDiagnostics.length} locations checked</span></summary><div class="diagnostics-list">${state.scanDiagnostics.map(d=>`<div class="diagnostic ${['ok','warning','error'].includes(d.status)?d.status:'warning'}"><div><span class="diagnostic-status">${ic(d.status==='ok'?'check':d.status==='error'?'close':'alert',14)}</span><strong>${esc(names[d.provider]||d.provider)}</strong><span>${Number(d.games)||0} games · ${Math.max(0,Math.round(Number(d.durationMs)||0))} ms</span></div>${d.path?`<p title="${esc(d.path)}">${esc(d.path)}</p>`:''}${(Array.isArray(d.warnings)?d.warnings:[]).map(w=>`<p>${esc(w)}</p>`).join('')}</div>`).join('')}</div></details>`;
}
function syncActivity(){
 for(const button of document.querySelectorAll('[data-action="launch"]')){
  const pending=state.pendingLaunches.has(button.dataset.id),running=state.runningIds.includes(button.dataset.id);
  if(pending||running){if(!button.dataset.restHtml)button.dataset.restHtml=button.innerHTML;button.innerHTML=ic(pending?'refresh':'check',16)+(button.matches('.cover-play,.continue-play')?'':pending?' Starting…':' Playing');button.disabled=true;button.setAttribute('aria-busy',String(pending));button.setAttribute('title',pending?'Starting game…':'Game is running');}
  else if(button.dataset.restHtml){button.innerHTML=button.dataset.restHtml;delete button.dataset.restHtml;button.disabled=false;button.removeAttribute('aria-busy');button.removeAttribute('title');}
 }
 for(const button of document.querySelectorAll('[data-action="shuffle"]'))button.disabled=state.games.length===0;
 for(const button of document.querySelectorAll('[data-action="scan"]')){button.setAttribute('aria-busy',String(state.scanning));button.classList.toggle('is-scanning',state.scanning);button.title=state.scanning?'Scanning installed games…':'Find installed games';}
 const status=document.querySelector('.side-version>span:last-child');if(status)status.innerHTML=state.scanning?'Scanning your games…':`Local library <span class="version-number">v${esc(state.version)}</span>`;
 controllerMode?.update();
}
async function performLaunch(id){const game=state.games.find(g=>g.id===id);if(!game||state.pendingLaunches.has(id)||state.runningIds.includes(id))return;
 const started=performance.now();state.pendingLaunches.add(id);
 try{const launch=window.orbit.launchGame(id);syncActivity();const result=await launch;toast(result.message||`Launched ${game.name}`);}
 catch(e){toast(e.message||`Could not launch ${game.name}`,true)}
 finally{setTimeout(()=>{state.pendingLaunches.delete(id);syncActivity();},Math.max(0,650-(performance.now()-started)));}
}
async function favorite(id){try{await window.orbit.favoriteGame(id)}catch(e){toast(e.message,true)}}
async function storeGame(form){const data=Object.fromEntries(new FormData(form));data.tags=String(data.tags||'').split(',').map(t=>t.trim()).filter(Boolean);
 try{data.launch_args=JSON.parse(data.launch_args||'[]');if(!Array.isArray(data.launch_args))throw Error()}catch{toast('Launch arguments must be a JSON array, for example ["--fullscreen"].',true);return}
 if(!data.executable?.trim()&&!data.launch_uri?.trim()){toast('Choose an executable or enter a supported game-launch URI.',true);return}
 const button=form.querySelector('[type=submit]');button.disabled=true;
 try{if(form.dataset.id)await window.orbit.updateGame(form.dataset.id,data);else await window.orbit.addGame({...data,source:'manual'});closeModal();toast(form.dataset.id?'Game updated.':'Game added to your library.');}
 catch(e){toast(e.message||'Could not save game.',true)}finally{button.disabled=false}
}
async function detectGameFile(file){
 const modal=state.modal;
 const status=el('game-detection-status');
 if(!status || modal?.type!=='game')return;
 status.textContent='Looking for local artwork and executable icon…';
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
   if(preview)preview.innerHTML=`<img src="${artwork(token)}" alt="Detected ${kind} preview"/>`;
   artworkFound=true;
  }
  const nameMessage=found.recognized?`Recognized as ${found.name}. `:'';
  const artMessage=found.cover_source==='steam'?'Cover downloaded from Steam.':found.cover?'Cover found in game folder.':found.icon?'Game icon detected.':'No artwork found; you can add your own.';
  status.textContent=nameMessage+artMessage;
  if(artworkFound&&!found.cover&&found.icon){
   const preview=el('preview-cover');
   if(preview&&!el('game-cover').value)preview.innerHTML=`<div class="auto-icon-preview"><img src="${artwork(found.icon)}" alt="Icon fallback" /></div>`;
  }
 }catch(e){if(state.modal===modal){status.textContent='Artwork detection unavailable.';toast(e.message||'Could not inspect this executable.',true)}}
}
async function handleAction(button){const action=button.dataset.action,id=button.dataset.id;
 switch(action){
  case 'controller-mode':await toggleControllerMode();break;
   case 'check-update':{const status=await window.orbit.checkForUpdates();state.updateStatus=status;const element=el('update-status');if(element)element.textContent=status.message||'';break;}
   case 'install-update':try{await window.orbit.installUpdate()}catch(error){toast(error.message||'Cannot install update.',true)}break;
  case 'navigate':navigate(button.dataset.route);break;
  case 'shuffle':{if(state.games.length){const game=state.games[Math.floor(Math.random()*state.games.length)];openModal('detail',{id:game.id});}else toast('Add a game to your library first.');break;}
  case 'platform':{state.filter=button.dataset.source;if(state.route==='home'){state.route='library';el('side-slot').innerHTML=sidebar();el('top-slot').innerHTML=topbar();}renderPage();break;}
  case 'add':openModal('game');break;
  case 'edit':openModal('game',{id});break;
  case 'detail':openModal('detail',{id});break;
  case 'close-modal':closeModal();break;
  case 'scrim':if(button.classList.contains('dialog-scrim'))closeModal();break;
  case 'launch':await performLaunch(id);break;
  case 'favorite':await favorite(id);break;
  case 'remove-confirm':openModal('remove',{id});break;
  case 'remove':try{await window.orbit.removeGame(id);closeModal();toast('Game removed from your library.')}catch(e){toast(e.message,true)}break;
  case 'scan':await performScan();break;
  case 'repair-artwork':{button.disabled=true;try{const result=await window.orbit.repairSteamArtwork();const note=result.onlineEnabled===false?' Online artwork is off in Settings.':result.paused?' Online artwork was paused by Performance Guard during repair.':'';toast(`Updated ${result.found} portrait covers and ${result.icons||0} game icons across ${result.attempted} games.${note}`)}catch(e){toast(e.message||'Cover repair failed.',true)}finally{button.disabled=false}break;}
  case 'import':await performImport();break;
  case 'toggle-all-import':{const allowed=state.imports.flatMap((g,i)=>g.alreadyAdded?[]:[i]).slice(0,MAX_IMPORT_SELECTION);state.selectedImports=state.selectedImports.size?new Set():new Set(allowed);renderModal();break;}
  case 'import-page':{const direction=button.dataset.page;state.importPage=Math.max(0,Math.min(Math.ceil(state.imports.length/IMPORT_PAGE_SIZE)-1,state.importPage+(direction==='next'?1:-1)));renderModal();el('modal-root').querySelector(`[data-page="${direction}"]:not([disabled])`)?.focus();break;}
  case 'choose-exe':{try{const file=await window.orbit.chooseExecutable();if(file){el('game-executable').value=file;await detectGameFile(file);}}catch(e){toast(e.message,true)}break;}
  case 'find-art':{const file=el('game-executable')?.value?.trim();if(!file){toast('Choose a game executable first.',true);break;}await detectGameFile(file);break;}
  case 'find-online-art':{
   const entered=el('cover-search-title')?.value?.trim()||'',gameTitle=el('game-name')?.value?.trim()||'';
   const name=entered||gameTitle;
   if(!name){toast('Enter the complete game title to search for its cover.',true);break;}
   const modal=state.modal,status=el('cover-search-status'),oldCover=el('game-cover')?.value;
   if(status)status.textContent='Searching for an exact game title…';
   button.disabled=true;
   try{
    const found=await window.orbit.findOnlineCover(name);
    if(state.modal!==modal)return;
    if((el('cover-search-title')?.value.trim()||'')!==entered||(!entered&&el('game-name')?.value.trim()!==gameTitle)){if(status)status.textContent='Title changed. Search again.';return;}
    if(found.cover&&el('game-cover')?.value===oldCover){
     el('game-cover').value=found.cover;
     el('preview-cover').innerHTML=`<img src="${artwork(found.cover)}" alt="Cover found online"/>`;
    }
    if(status)status.textContent=found.cover&&el('game-cover')?.value!==found.cover?'Cover changed while searching; your selection was kept.':found.message||'No cover found.';
   }catch(e){if(status)status.textContent=e.message||'Online artwork search unavailable.';toast(e.message,true)}
   finally{button.disabled=false}
   break;
  }
  case 'choose-art':{try{const file=await window.orbit.chooseArtwork();if(file){const key=button.dataset.key;el(`game-${key}`).value=file;el(`preview-${key}`).innerHTML=`<img src="${artwork(file)}" alt="Artwork preview"/>`}}catch(e){toast(e.message,true)}break;}
  case 'clear-art':{const key=button.dataset.key;const input=el(`game-${key}`),preview=el(`preview-${key}`);if(!input||!preview)break;input.value='';const fallback=key==='cover'?artwork(el('game-icon')?.value):null;preview.innerHTML=fallback?`<div class="auto-icon-preview"><img src="${fallback}" alt="Icon fallback" /></div>`:`<div class="image-placeholder">${ic('image',21)}</div>`;break;}

  case 'open-folder':try{await window.orbit.openGameFolder(id)}catch(e){toast(e.message,true)}break;
  case 'open-data':try{await window.orbit.openAppData()}catch(e){toast(e.message,true)}break;
  case 'clear-filters':{state.query='';state.filter='all';state.tag='all';state.genre='all';const search=el('global-search');if(search)search.value='';renderPage();break;}
  case 'view':state.view=button.dataset.view;await saveSettings({view:state.view});renderPage({keepScroll:true});break;
  case 'accent':await saveSettings({accent:button.dataset.color});break;
  case 'setting-toggle':{const key=button.dataset.key;await saveSettings({[key]:!state.settings[key]});break;}
  case 'add-folder':{try{const dir=await window.orbit.chooseFolder();if(dir){const folders=[...new Set([...state.settings.libraryFolders,dir])];await saveSettings({libraryFolders:folders});toast('Scan location added.')}}catch(e){toast(e.message,true)}break;}
  case 'remove-folder':{const folders=state.settings.libraryFolders.filter((_,i)=>i!==Number(button.dataset.index));await saveSettings({libraryFolders:folders});break;}
  case 'export':try{const res=await window.orbit.exportLibrary();if(res?.path){toast(res.portable?'Portable library backup exported.':'Metadata-only JSON backup exported.');if(res.missingArtwork)toast(`${res.missingArtwork} missing or invalid artwork file(s) were not included.`,true)}}catch(e){toast(e.message,true)}break;
  case 'restore':try{const res=await window.orbit.restoreLibrary();if(res){toast(`Restored ${res.imported} games; skipped ${res.skipped}.`);if(res.errors?.length)toast(res.errors.slice(0,2).join(' · '),true)}}catch(e){toast(e.message,true)}break;
 }
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
 if(button.dataset.action==='scrim'&&event.target!==button)return;
 event.preventDefault();handleAction(button).catch(e=>toast(e.message||'Action failed.',true));});
document.addEventListener('change',async event=>{const target=event.target;
 if(target.matches('[data-import-index]')){
  const i=Number(target.dataset.importIndex);
  if(target.checked){if(state.selectedImports.size>=MAX_IMPORT_SELECTION){target.checked=false;toast(`Select up to ${MAX_IMPORT_SELECTION.toLocaleString()} games per import.`,true);return;}state.selectedImports.add(i)}else state.selectedImports.delete(i);
  const count=state.selectedImports.size,modal=el('modal-root');
  const summary=modal.querySelector('.import-toolbar .muted');if(summary)summary.textContent=`${count} selected`;
  const toggle=modal.querySelector('[data-action="toggle-all-import"]');if(toggle)toggle.textContent=count?'Deselect all':'Select all new';
  const submit=modal.querySelector('[data-action="import"]');
  if(submit){submit.disabled=count===0;submit.innerHTML=`${ic('download',16)} Import ${count} ${count===1?'game':'games'}`;}
  return;
 }
 if(target.id==='tag-filter'){state.tag=target.value;renderPage();return}
 if(target.id==='genre-filter'){state.genre=target.value;renderPage();return}
 if(target.id==='sort-by'){state.sort=target.value;try{await saveSettings({sort:state.sort})}catch(e){toast(e.message,true)}renderPage({keepScroll:true});return}
 if(target.id==='theme-select'){try{await saveSettings({theme:target.value})}catch(e){toast(e.message,true)}}
 if(target.id==='density-select'){try{await saveSettings({libraryDensity:target.value});renderPage({keepScroll:true})}catch(e){toast(e.message,true)}}
});
let searchTimer;document.addEventListener('input',event=>{if(event.target.id!=='global-search')return;
 state.query=event.target.value;if(!['library','favorites','recent'].includes(state.route)){state.route='library';el('side-slot').innerHTML=sidebar();renderPage();}
 clearTimeout(searchTimer);searchTimer=setTimeout(()=>{if(['library','favorites','recent'].includes(state.route)){const scroller=el('main-scroll');if(scroller)scroller.scrollTop=0;renderVirtual();}},95);
});
document.addEventListener('submit',event=>{if(event.target.id==='game-form'){event.preventDefault();storeGame(event.target)}});
document.addEventListener('keydown',event=>{
 if(event.key==='Enter'&&!event.isComposing&&event.target.id==='cover-search-title'){
  event.preventDefault();const search=el('modal-root')?.querySelector('[data-action="find-online-art"]');if(search&&!search.disabled)search.click();return;
 }
 if(event.key==='F11'&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();if(!event.repeat)Promise.resolve().then(toggleControllerMode).catch(error=>toast(error.message,true));return;}
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
// A wide header/banner is not a portrait cover. Let the icon or gradient
// show until the user requests a proper portrait via Repair library covers.
function checkCoverAspect(img){
  if(!(img instanceof HTMLImageElement))return;
  if(img.matches('.hero-art,.detail-banner')){if(img.naturalWidth/img.naturalHeight<1.5)img.classList.add('bad-aspect');return;}
  if(!img.matches('.cover-image,.row-cover img:not(.list-game-icon)'))return;
  const ratio=img.naturalHeight?img.naturalWidth/img.naturalHeight:0;
  img.classList.toggle('bad-aspect',ratio<0.5||ratio>0.85);
}
document.addEventListener('load',event=>checkCoverAspect(event.target),true);
document.addEventListener('error',event=>{
  if(event.target instanceof HTMLImageElement)event.target.classList.add('bad-aspect');
},true);
window.addEventListener('resize',()=>{if(['library','recent','favorites'].includes(state.route))renderVirtual()});
window.matchMedia?.('(prefers-color-scheme:light)')?.addEventListener('change',()=>{if(state.settings?.theme==='system')setupTheme()});
async function boot(){try{
 if(!window.orbit)throw Error('Desktop integration is unavailable. Start Orbit using Electron.');
 const buffered=[];
 window.orbit.onEvent(event=>{if(libraryUpdates)handleOrbitEvent(event);else buffered.push(event);});
 const data=await window.orbit.bootstrap();
 libraryUpdates=new window.OrbitLibraryUpdates.LibraryUpdates({
  snapshot:data,loadSnapshot:loadLibrarySnapshot,onChange:applyLibraryUpdate,
  onError:error=>toast(error.message||'Could not update the library.',true)
 });
 state.games=libraryUpdates.snapshot().games;state.runningIds=data.runningIds||[];state.settings=data.settings;
 state.sort=data.settings.sort||'name';state.view=data.settings.view||'grid';state.platform=data.platform;state.version=data.version;
 if(window.orbit.getUpdateStatus)state.updateStatus=await window.orbit.getUpdateStatus();
 setupTheme();renderShell();
 for(const event of buffered)handleOrbitEvent(event);
 }catch(e){el('app').innerHTML=`<div class="boot"><div class="boot-logo">!</div><h2>Orbit could not start</h2><p>${esc(e.message||'Unknown error.')}</p></div>`;}}

boot();
})();

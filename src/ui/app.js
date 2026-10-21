'use strict';
(() => {
const el=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iconPaths={
 home:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
 library:'<rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5"/><path d="M3 9h7M13 15h8"/>',
 heart:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
 settings:'<path d="M12 3.2 14 4l2.1-1 2.5 2.5-1 2.1.8 2 2.3.8v3.5l-2.3.8-.8 2 1 2.1-2.5 2.5-2.1-1-2 .8-1 2.3H10.5l-.8-2.3-2-.8-2.1 1-2.5-2.5 1-2.1-.8-2L1 13.9v-3.5l2.3-.8.8-2-1-2.1L5.6 3l2.1 1 2-.8 1-2.2h3.5" transform="translate(1 1) scale(.84)"/><circle cx="12" cy="12" r="3"/>',
 search:'<circle cx="10.6" cy="10.6" r="6.6"/><path d="m16 16 5 5"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',play:'<path d="m8 5 12 7-12 7V5Z"/>',
 arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
 chevron:'<path d="m9 18 6-6-6-6"/>',
 grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
 list:'<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.1M3 12h.1M3 18h.1" stroke-width="3"/>',
 refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 9a7 7 0 0 1 12-2l2 5M4 12l2 5a7 7 0 0 0 12-2"/>',
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
 gamepad:'<path d="M7 7h10a5 5 0 0 1 5 5l-1 6a2 2 0 0 1-3 1l-3-3H9l-3 3a2 2 0 0 1-3-1l-1-6a5 5 0 0 1 5-5Zm-1 5h5M8.5 9.5v5M16 12h.1M19 14h.1"/>',
 external:'<path d="M13 4h7v7M20 4l-9 9M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"/>',
 image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="2"/><path d="m3 17 6-6 4 4 2-2 6 6"/>',
 sort:'<path d="M5 3v18m-3-3 3 3 3-3M12 7h9M12 12h7M12 17h4"/>',
 dots:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
};
const ic=(name,size=18)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${iconPaths[name]||iconPaths.gamepad}</svg>`;
const state={games:[],runningIds:[],settings:null,route:'home',query:'',filter:'all',tag:'all',genre:'all',view:'grid',sort:'name',modal:null,imports:[],importPage:0,selectedImports:new Set(),scanWarnings:[],scanning:false,busy:false,platform:'',version:'',viewGames:[]};
const sourceNames={steam:'Steam',epic:'Epic Games',gog:'GOG',folder:'Local',manual:'Manual'};
const palette=['#8b7aff','#5bafef','#fc8ca8','#53c5b3','#f3a65c','#bf87f5'];
function artwork(token){return /^[a-f\d-]{36}\.(jpg|jpeg|png|webp)$/.test(token||'')?`orbit-art://file/${token}`:null}
function paletteFor(name){let hash=0;for(const c of name||'')hash=(hash*31+c.charCodeAt(0))>>>0;return [hash%360,(hash*11+126)%360]}
function coverStyle(g){const [hue,hue2]=paletteFor(g.name);return `--hue:${hue};--hue2:${hue2}`}
function coverImage(g){const fallback=artwork(g.icon)?`<span class="cover-icon-frame"><img class="cover-icon" src="${artwork(g.icon)}" loading="lazy" alt="" /></span>`:'';const poster=artwork(g.cover)?`<img class="cover-image" src="${artwork(g.cover)}" loading="lazy" alt="" />`:'';return fallback+poster;}
function timeLabel(seconds){if(!seconds)return 'Not played yet';const hrs=Math.floor(seconds/3600),mins=Math.round((seconds%3600)/60);return hrs?`${hrs}h ${mins}m played`:`${Math.max(1,mins)}m played`}
function sourceLabel(game){return sourceNames[game.source]||'Game'}
function formatDate(date){if(!date)return 'Never';const d=new Date(date);return Number.isNaN(d.getTime())?'Unknown':new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'}).format(d)}
function setupTheme(){const theme=state.settings?.theme||'dark';const resolved=theme==='system'&&window.matchMedia?.('(prefers-color-scheme: light)').matches?'light':theme==='system'?'dark':theme;document.body.dataset.theme=resolved;document.body.dataset.reduceMotion=String(!!state.settings?.reduceMotion);const accent=state.settings?.accent||palette[0];document.documentElement.style.setProperty('--accent',accent);const n=parseInt(accent.slice(1),16);document.documentElement.style.setProperty('--accent-rgb',`${n>>16},${(n>>8)&255},${n&255}`);document.documentElement.style.setProperty('--accent-ink','#11121d')}
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
function card(g){return `<article class="game-card" style="${coverStyle(g)}" data-action="detail" data-id="${esc(g.id)}" role="button" tabindex="0" aria-label="View details for ${esc(g.name)}">
  <div class="cover">${coverImage(g)}<span class="cover-letter">${esc(g.name.slice(0,2))}</span><span class="cover-source">${esc(sourceLabel(g))}</span>
  <button class="favorite-float ${g.favorite?'active':''}" data-action="favorite" data-id="${esc(g.id)}" aria-label="${g.favorite?'Remove favorite':'Add favorite'}">${ic('heart',16)}</button>
  <button class="cover-play" data-action="launch" data-id="${esc(g.id)}" aria-label="Launch ${esc(g.name)}">${ic('play',17)}</button></div>
  <div class="game-label"><div style="min-width:0"><span class="game-name" title="${esc(g.name)}">${esc(g.name)}</span><span class="game-meta">${state.runningIds?.includes(g.id)?'● Playing now':g.total_play_seconds?esc(timeLabel(g.total_play_seconds)):esc(sourceLabel(g))}</span></div>
  <button class="game-menu" data-action="detail" data-id="${esc(g.id)}" aria-label="More about ${esc(g.name)}">${ic('dots',18)}</button></div></article>`}
function rowGame(g){return `<article class="game-row" data-action="detail" data-id="${esc(g.id)}" tabindex="0" role="button" aria-label="View ${esc(g.name)}">
  <div class="row-cover" style="${coverStyle(g)}">${esc(g.name.slice(0,1))}${artwork(g.cover||g.icon)?`<img src="${artwork(g.cover||g.icon)}" alt="" loading="lazy" class="${artwork(g.cover)?'':'list-game-icon'}" />`:''}</div>
  <div class="row-info"><h3>${esc(g.name)}</h3><p>${esc(sourceLabel(g))}${g.tags?.length?' · '+esc(g.tags.slice(0,2).join(', ')):''}</p></div>
  <div class="row-right"><span class="playtime">${esc(timeLabel(g.total_play_seconds))}</span><button class="ghost-btn" data-action="favorite" data-id="${esc(g.id)}" aria-label="Toggle favorite" style="${g.favorite?'color:#ffc171':''}">${ic('heart',17)}</button><button class="ghost-btn row-play" data-action="launch" data-id="${esc(g.id)}">${ic('play',15)} Play</button></div></article>`}
function sidebar(){const links=[['home','home','Overview'],['library','library','My library'],['favorites','heart','Favorites'],['recent','clock','Recently played']];return `<aside class="sidebar">
 <div class="brand"><div class="brand-mark" aria-hidden="true">O</div><div><div class="brand-name">orbit<span style="color:var(--accent)">.</span></div><div class="brand-sub">GAME LAUNCHER</div></div></div>
 <div class="side-label">YOUR SPACE</div><nav class="nav" aria-label="Main navigation">${links.map(([id,icon,name])=>`<button class="nav-item ${state.route===id?'active':''}" data-action="navigate" data-route="${id}" ${state.route===id?'aria-current="page"':''}>${ic(icon,18)}<span>${name}</span>${id==='library'?`<span class="count">${state.games.length}</span>`:''}</button>`).join('')}</nav>
 <div class="side-label" style="margin-top:25px">PREFERENCES</div><nav class="nav"><button class="nav-item ${state.route==='settings'?'active':''}" data-action="navigate" data-route="settings">${ic('settings',18)}<span>Settings</span></button></nav>
 <div class="side-bottom"><div class="side-tip"><strong>Discover your games</strong><p>Import titles from installed launchers and local folders.</p><button data-action="scan">${ic('refresh',13)} Scan library</button></div><div class="side-version"><span class="status-dot"></span><span>Ready to play · v${esc(state.version)}</span></div></div></aside>`}
function topbar(){const name={home:'Dashboard',library:'My library',favorites:'Favorites',recent:'Recently played',settings:'Settings'}[state.route]||'Dashboard';return `<header class="topbar"><div class="breadcrumb">Orbit <span style="color:var(--soft);padding:0 9px">/</span>${name}</div>
 <div class="topbar-right"><label class="searchbox">${ic('search',18)}<input id="global-search" type="search" placeholder="Search your games..." value="${esc(state.query)}" autocomplete="off" aria-label="Search games"/><kbd>Ctrl K</kbd></label>
 <button class="top-icon" data-action="scan" title="Discover installed games" aria-label="Discover installed games">${ic('refresh',18)}</button>
 <button class="primary-btn" data-action="add">${ic('plus',18)}<span>Add game</span></button></div></header>`}
function headline(eyebrow,title,subtitle,buttons=''){return `<div class="page-heading"><div><div class="eyebrow"><i></i>${esc(eyebrow)}</div><h1 class="page-title">${esc(title)}</h1><p class="page-intro">${esc(subtitle)}</p></div>${buttons}</div>`}
function home(){
 const played=sortedGames(state.games.filter(g=>g.last_played_at)).sort((a,b)=>Date.parse(b.last_played_at)-Date.parse(a.last_played_at));
 const feature=played[0]||state.games[0];
 const recent=played.slice(0,6),collection=sortedGames(state.games).slice(0,6);
 const favs=state.games.filter(g=>g.favorite).length;
 return `<section class="page">${headline('Your command center','Welcome to Orbit','All your games. One beautiful place to play.')}
 <div class="hero">${feature&&artwork(feature.banner||feature.cover)?`<img class="hero-art" src="${artwork(feature.banner||feature.cover)}" alt="" />`:''}${feature&&!artwork(feature.banner||feature.cover)&&artwork(feature.icon)?`<img class="hero-game-icon" src="${artwork(feature.icon)}" alt=""/>`:''}<div class="hero-grid"></div><div class="hero-orbit"></div>
 <div class="hero-content"><span class="hero-eyebrow">${feature?'READY WHEN YOU ARE':'YOUR UNIVERSE STARTS HERE'}</span><h2>${feature?`Jump back into<br>${esc(feature.name)}`:'Every game.<br>One universe.'}</h2><p>${feature?'Your next adventure is a click away. Pick up right where you left off.':'Bring your Steam, Epic, GOG and local games together. Built for your collection.'}</p>
 <div class="hero-buttons">${feature?`<button class="primary-btn" data-action="launch" data-id="${esc(feature.id)}">${ic('play',17)} Play now</button><button class="secondary-btn" data-action="detail" data-id="${esc(feature.id)}">View game ${ic('arrow',16)}</button>`:`<button class="primary-btn" data-action="scan">${ic('sparkles',17)} Discover games</button><button class="secondary-btn" data-action="add">${ic('plus',17)} Add manually</button>`}</div></div></div>
 <div class="stat-grid"><div class="stat"><div class="stat-icon">${ic('gamepad',24)}</div><div><div class="stat-label">Total games</div><div class="stat-value">${state.games.length}</div></div></div><div class="stat"><div class="stat-icon">${ic('clock',24)}</div><div><div class="stat-label">Tracked play time</div><div class="stat-value">${totalHours()} <span class="stat-suffix">hours</span></div></div></div><div class="stat"><div class="stat-icon">${ic('heart',24)}</div><div><div class="stat-label">Favorites</div><div class="stat-value">${favs}</div></div></div></div>
 ${recent.length?`<div class="subheading"><h2>Continue playing</h2><button class="small-link" data-action="navigate" data-route="recent">View history ${ic('arrow',15)}</button></div><div class="games-grid">${recent.map(card).join('')}</div>`:''}
 <div class="subheading"><h2>${state.games.length?'Explore your library':'Your collection awaits'}</h2>${state.games.length?`<button class="small-link" data-action="navigate" data-route="library">View all games ${ic('arrow',15)}</button>`:''}</div>
 ${state.games.length?`<div class="games-grid">${collection.map(card).join('')}</div>`:emptyState('Ready for your first game?','Scan your installed launchers or add a game manually to start your collection.')}</section>`;
}
function emptyState(title,body,extra=''){return `<div class="empty-state"><div class="empty-illustration">${ic('gamepad',47)}</div><h2>${esc(title)}</h2><p>${esc(body)}</p><div class="empty-actions">${extra||`<button class="primary-btn" data-action="scan">${ic('refresh',16)} Discover games</button><button class="secondary-btn" data-action="add">${ic('plus',16)} Add game</button>`}</div></div>`}
function libraryView(){const subtitle={library:'A home for everything you play.',favorites:'The games you love, always one click away.',recent:'Pick up where you left off.'};const title={library:'Your game library',favorites:'Your favorites',recent:'Recently played'};const tags=[...new Set(state.games.flatMap(g=>g.tags||[]))].sort((a,b)=>a.localeCompare(b)).slice(0,100);const genres=[...new Set(state.games.map(g=>g.genre).filter(Boolean))].sort((a,b)=>a.localeCompare(b)).slice(0,100);
 return `<section class="page">${headline('Your collection',title[state.route],subtitle[state.route],`<button class="secondary-btn" data-action="scan">${ic('refresh',15)} Scan for games</button>`)}
 <div class="library-controls"><div class="control-left"><span class="library-count" id="game-result-count">${filtered().length} games</span><div class="select-wrap"><select id="source-filter" aria-label="Filter by platform"><option value="all" ${state.filter==='all'?'selected':''}>All platforms</option>${Object.entries(sourceNames).map(([value,label])=>`<option value="${value}" ${state.filter===value?'selected':''}>${esc(label)}</option>`).join('')}</select></div>
 <div class="select-wrap"><select id="genre-filter" aria-label="Filter by category"><option value="all" ${state.genre==='all'?'selected':''}>All categories</option>${genres.map(g=>`<option value="${esc(g)}" ${state.genre===g?'selected':''}>${esc(g)}</option>`).join('')}</select></div>
 <div class="select-wrap"><select id="tag-filter" aria-label="Filter by tag"><option value="all" ${state.tag==='all'?'selected':''}>All tags</option>${tags.map(t=>`<option value="${esc(t)}" ${state.tag===t?'selected':''}>${esc(t)}</option>`).join('')}</select></div></div>
 <div class="control-right"><div class="select-wrap"><select id="sort-by" aria-label="Sort games"><option value="name" ${state.sort==='name'?'selected':''}>Name A–Z</option><option value="recent" ${state.sort==='recent'?'selected':''}>Recently played</option><option value="added" ${state.sort==='added'?'selected':''}>Recently added</option><option value="time" ${state.sort==='time'?'selected':''}>Play time</option></select></div>
 <div class="view-switch" aria-label="Library display"><button data-action="view" data-view="grid" class="${state.view==='grid'?'selected':''}" aria-label="Grid view" aria-pressed="${state.view==='grid'}">${ic('grid',16)}</button><button data-action="view" data-view="list" class="${state.view==='list'?'selected':''}" aria-label="List view" aria-pressed="${state.view==='list'}">${ic('list',16)}</button></div></div></div>
 <div id="library-area" class="virtual-area">${state.games.length?'<div id="virtual-games"></div>':emptyState('No games yet','Scan your installed launchers or add a game manually.')}</div></section>`;
}
let virtualRangeKey=null,virtualGamesRef=null;
function renderVirtual(){const host=el('virtual-games');if(!host)return;const games=filtered();state.viewGames=games;
 const count=el('game-result-count');if(count)count.textContent=`${games.length} ${games.length===1?'game':'games'}`;
 if(!games.length){if(virtualRangeKey==='empty'&&virtualGamesRef===games)return;virtualRangeKey='empty';virtualGamesRef=games;host.innerHTML=emptyState(state.query?'No matching games':state.route==='favorites'?'No favorites yet':state.route==='recent'?'No games played yet':'Nothing here yet',state.query?'Try another search or clear filters.':state.route==='favorites'?'Mark games with the heart icon to see them here.':state.route==='recent'?'Launch a game and it will appear here.':'Try changing the platform or tag filters.',`<button class="secondary-btn" data-action="clear-filters">Clear filters</button>`);return;}
 const scroll=el('main-scroll');if(!scroll)return;const isGrid=state.view==='grid';
 const cols=isGrid?Math.max(1,Math.floor((host.clientWidth+18)/195)):1;
 const rowHeight=isGrid?(window.innerWidth<=1180?304:327):88;
 const listTop=host.getBoundingClientRect().top-scroll.getBoundingClientRect().top+scroll.scrollTop;
 const totalRows=Math.ceil(games.length/cols),visible=Math.ceil(scroll.clientHeight/rowHeight)+7;
 const first=Math.min(Math.max(0,totalRows-visible),Math.max(0,Math.floor(Math.max(0,scroll.scrollTop-listTop)/rowHeight)-3));
 const last=Math.min(totalRows,first+visible);const key=`${state.view}:${cols}:${rowHeight}:${first}:${last}`;
 if(virtualGamesRef===games&&virtualRangeKey===key)return;
 virtualGamesRef=games;virtualRangeKey=key;
 const slice=games.slice(first*cols,last*cols);
 host.innerHTML=`<div style="height:${first*rowHeight}px"></div><div class="${isGrid?'games-grid':'game-list'}" style="${isGrid?`grid-template-columns:repeat(${cols},minmax(0,1fr))`:''}">${slice.map(isGrid?card:rowGame).join('')}</div><div style="height:${Math.max(0,(totalRows-last)*rowHeight)}px"></div>`;
}
function settingsView(){const s=state.settings,folders=s.libraryFolders||[];return `<section class="page">${headline('Make it yours','Settings','Customize how Orbit looks, discovers games, and works for you.')}
 <div class="settings-layout"><div class="settings-stack">
 <div class="settings-card"><h2>Appearance</h2><p>A launcher that looks and feels the way you want.</p>
 <div class="setting-row"><div><div class="setting-name">Theme</div><div class="setting-help">Choose a color mode for the launcher.</div></div><div class="select-wrap setting-control"><select id="theme-select" aria-label="Theme"><option value="dark" ${s.theme==='dark'?'selected':''}>Dark</option><option value="light" ${s.theme==='light'?'selected':''}>Light</option><option value="system" ${s.theme==='system'?'selected':''}>System</option></select></div></div>
 <div class="setting-row"><div><div class="setting-name">Accent color</div><div class="setting-help">Add a personal touch to your library.</div></div><div class="accent-swatches setting-control">${palette.map(c=>`<button class="swatch ${s.accent.toLowerCase()===c?'chosen':''}" style="--sw:${c}" data-action="accent" data-color="${c}" aria-label="Set accent color ${c}"></button>`).join('')}</div></div>
 <div class="setting-row"><div><div class="setting-name">Reduce motion</div><div class="setting-help">Limit animation and transitions.</div></div><button class="switch ${s.reduceMotion?'on':''}" data-action="setting-toggle" data-key="reduceMotion" role="switch" aria-checked="${s.reduceMotion}" aria-label="Reduce motion"></button></div></div>
 <div class="settings-card"><h2>Library discovery</h2><p>Orbit searches installed game stores and folders you select. Downloads is never scanned automatically.</p>
 <div class="setting-row"><div><div class="setting-name">Scan at startup</div><div class="setting-help">Look for new games whenever Orbit starts.</div></div><button class="switch ${s.autoScan?'on':''}" data-action="setting-toggle" data-key="autoScan" role="switch" aria-checked="${s.autoScan}" aria-label="Scan at startup"></button></div>
 <div class="setting-row"><div><div class="setting-name">Steam artwork</div><div class="setting-help">Download publicly available cover images when online.</div></div><button class="switch ${s.useSteamArtwork?'on':''}" data-action="setting-toggle" data-key="useSteamArtwork" role="switch" aria-checked="${s.useSteamArtwork}" aria-label="Steam artwork downloads"></button></div>
 <div class="setting-row"><div><div class="setting-name">Missing or incorrect covers</div><div class="setting-help">Find portrait artwork, and use installed game EXE icons when no cover is available. Valid portrait covers are preserved.</div></div><button class="secondary-btn" data-action="repair-artwork">${ic('refresh',14)} Repair library covers</button></div>
 <div class="setting-row"><div><div class="setting-name">Custom library locations</div><div class="setting-help">Optional folders to scan for game executables and GOG info files.</div></div><button class="secondary-btn" data-action="add-folder">${ic('plus',14)} Add folder</button></div>
 <div class="folder-list">${folders.length?folders.map((f,index)=>`<div class="folder-item">${ic('folder',15)}<span title="${esc(f)}">${esc(f)}</span><button data-action="remove-folder" data-index="${index}" aria-label="Remove folder">${ic('close',15)}</button></div>`).join(''):'<span class="setting-help">No custom folders yet. Steam, Epic and GOG discovery works independently.</span>'}</div><div style="margin-top:16px"><button class="secondary-btn" data-action="scan">${ic('refresh',15)} Scan now</button></div></div>
 <div class="settings-card"><h2>Data & privacy</h2><p>Your collection lives in a local SQLite database. Orbit does not require an account.</p>
 <div class="setting-row"><div><div class="setting-name">Application data</div><div class="setting-help">Browse your database, artwork cache, and preferences.</div></div><button class="secondary-btn" data-action="open-data">${ic('folder',15)} Open folder</button></div>
 <div class="setting-row"><div><div class="setting-name">Library backup</div><div class="setting-help">Portable .orbit backups include artwork and metadata. JSON exports contain metadata only.</div></div><div class="setting-control" style="display:flex;gap:7px"><button class="secondary-btn" data-action="export">${ic('download',15)} Export</button><button class="secondary-btn" data-action="restore">${ic('upload',15)} Restore</button></div></div></div>
 </div><aside class="settings-side"><div class="orb"></div><h3>Made for your games.</h3><p>Fast to open. Simple to organize. Always available offline. Your library stays yours.</p><div class="hr"></div><p>Orbit ${esc(state.version)} · ${esc(state.platform)}</p></aside></div></section>`;
}
function renderShell(){el('app').innerHTML=`<div class="app-shell"><div id="side-slot">${sidebar()}</div><div class="workspace"><div id="top-slot">${topbar()}</div><main class="content-scroll" id="main-scroll" tabindex="-1"><div id="page-slot"></div></main></div></div>`;el('main-scroll').addEventListener('scroll',()=>{if(['library','favorites','recent'].includes(state.route)&&!scrollFrame){scrollFrame=requestAnimationFrame(()=>{scrollFrame=null;renderVirtual()})}},{passive:true});renderPage()}
let scrollFrame=null;
function renderPage({keepScroll=false}={}){const slot=el('page-slot'),scroller=el('main-scroll');if(!slot)return;const old=keepScroll?scroller.scrollTop:0;
 virtualRangeKey=null;virtualGamesRef=null;
 slot.innerHTML=state.route==='home'?home():state.route==='settings'?settingsView():libraryView();scroller.scrollTop=old;
 if(['library','favorites','recent'].includes(state.route))renderVirtual();}
function refreshNavigation(keepScroll=false){el('side-slot').innerHTML=sidebar();el('top-slot').innerHTML=topbar();renderPage({keepScroll});}
function navigate(route){if(!['home','library','favorites','recent','settings'].includes(route))return;state.route=route;state.query='';state.filter='all';state.tag='all';state.genre='all';refreshNavigation();}
function toast(message,error=false){const item=document.createElement('div');item.className=`toast ${error?'error':''}`;item.innerHTML=ic(error?'alert':'check',19)+`<p>${esc(message)}</p>`;const root=el('toast-root');root.appendChild(item);while(root.children.length>3)root.firstElementChild.remove();setTimeout(()=>item.remove(),4600)}
async function call(promise){try{return await promise}catch(e){toast(e.message||'Something went wrong.',true);throw e}}
async function refreshGames(){state.games=await window.orbit.listGames();state.runningIds=typeof window.orbit.runningGames==='function'?await window.orbit.runningGames():[];el('side-slot').innerHTML=sidebar();renderPage({keepScroll:true});}
async function saveSettings(patch){state.settings=await window.orbit.saveSettings(patch);setupTheme();if(state.route==='settings')renderPage({keepScroll:true});}
let modalReturnFocus=null;
function openModal(type,meta={}){if(!state.modal)modalReturnFocus=document.activeElement;state.modal={type,...meta};renderModal()}
function closeModal(){state.modal=null;el('modal-root').innerHTML='';if(modalReturnFocus?.isConnected)modalReturnFocus.focus({preventScroll:true});modalReturnFocus=null}
function dialogFrame(title,description,body,footer='',wide=false){return `<div class="dialog-scrim" data-action="scrim"><section class="dialog ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-header"><div><h2 id="dialog-title">${esc(title)}</h2><p>${esc(description)}</p></div><button class="ghost-btn" data-action="close-modal" aria-label="Close dialog">${ic('close',21)}</button></div>${body}${footer}</section></div>`}
function editor(g){const isEdit=!!g;const title=isEdit?'Edit game':'Add a game';const params=Array.isArray(g?.launch_args)?JSON.stringify(g.launch_args):'[]';
 const imgSection=(key,label)=>`<div class="image-upload"><div id="preview-${key}">${artwork(g?.[key])?`<img src="${artwork(g[key])}" alt="${label} preview" />`:key==='cover'&&artwork(g?.icon)?`<div class="auto-icon-preview"><img src="${artwork(g.icon)}" alt="Icon fallback" /></div>`:`<div class="image-placeholder">${ic('image',21)}</div>`}</div><div style="flex:1"><p>${label}</p><small>${key==='icon'?'Used when no cover exists':'PNG, JPEG or WebP'}</small></div><button type="button" class="secondary-btn" data-action="choose-art" data-key="${key}">Choose</button><button type="button" class="small-link" data-action="clear-art" data-key="${key}" aria-label="Clear ${label}">Clear</button></div>`;
 return dialogFrame(title,isEdit?'Update this game without changing its installation.':'Select any locally installed game executable. Orbit recognizes known game filenames and looks for cover art or an icon.',`<form id="game-form" data-form="game" data-id="${esc(g?.id||'')}"><div class="dialog-body">
  <div class="field"><label for="game-name">Game title *</label><input id="game-name" name="name" type="text" maxlength="140" value="${esc(g?.name||'')}" placeholder="For example, Hollow Knight" required /></div>
  <div class="field"><label for="game-executable">Executable</label><div class="file-field"><input id="game-executable" name="executable" type="text" value="${esc(g?.executable||'')}" placeholder="Select the game executable" /><button type="button" class="secondary-btn" data-action="choose-exe">${ic('folder',16)} Browse .exe</button></div><div class="file-extras"><button type="button" class="small-link" data-action="find-art">${ic('sparkles',14)} Detect game &amp; icon</button><button type="button" class="small-link" data-action="find-online-art">${ic('search',14)} Find online cover by title</button><span id="game-detection-status" role="status" aria-live="polite"></span></div></div>
  <div class="field"><label for="game-uri">Launcher URI (optional)</label><input id="game-uri" name="launch_uri" value="${esc(g?.launch_uri||'')}" type="text" placeholder="steam://rungameid/12345" /><small>If set, Orbit launches through the associated game launcher. Direct executables support play-time tracking.</small></div>
  <div class="field-grid"><div class="field"><label for="game-workdir">Working directory</label><input id="game-workdir" name="working_dir" type="text" value="${esc(g?.working_dir||'')}" placeholder="Defaults to executable folder" /></div><div class="field"><label for="game-genre">Genre</label><input id="game-genre" name="genre" type="text" maxlength="100" value="${esc(g?.genre||'')}" placeholder="Adventure, RPG, Strategy…" /></div></div>
  <div class="field-grid"><div class="field"><label for="game-tags">Tags</label><input id="game-tags" name="tags" value="${esc((g?.tags||[]).join(', '))}" type="text" placeholder="Co-op, Story, Competitive" /><small>Separate multiple tags with commas.</small></div><div class="field"><label for="game-args">Launch arguments</label><input id="game-args" name="launch_args" type="text" value="${esc(params)}" placeholder='["--fullscreen"]' /><small>Enter a JSON array, e.g. ["--fullscreen", "--safe-mode"].</small></div></div>
  <div class="image-fields">${imgSection('cover','Cover artwork')}${imgSection('banner','Banner artwork')}${imgSection('icon','Game icon')}</div>
  <input type="hidden" id="game-cover" name="cover" value="${esc(g?.cover||'')}"/><input type="hidden" id="game-banner" name="banner" value="${esc(g?.banner||'')}"/><input type="hidden" id="game-icon" name="icon" value="${esc(g?.icon||'')}"/>
  </div><div class="dialog-footer"><button type="button" class="secondary-btn" data-action="close-modal">Cancel</button><button type="submit" class="primary-btn">${ic('check',16)} ${isEdit?'Save changes':'Add to library'}</button></div></form>`, '',true);
}
function detail(g){if(!g)return dialogFrame('Game unavailable','This game no longer exists.','<div class="dialog-body">Please refresh the library.</div>');
 const tags=(g.tags||[]).map(t=>`<span class="detail-tag">${esc(t)}</span>`).join('');
 return dialogFrame(g.name,`${sourceLabel(g)} · Added ${formatDate(g.created_at)}`,`<div class="dialog-body"><div class="detail-cover"><div class="cover" style="${coverStyle(g)}">${coverImage(g)}<span class="cover-letter">${esc(g.name.slice(0,2))}</span></div>
 <div><h2 class="detail-title">${esc(g.name)}</h2>${g.genre?`<span class="detail-tag">${esc(g.genre)}</span>`:''}${tags||'<span class="detail-tag">No tags yet</span>'}
 <div class="detail-stat">${ic('gamepad',15)} ${esc(sourceLabel(g))}${g.source_id?` · ${esc(g.source_id)}`:''}</div>
 <div class="detail-stat">${ic('clock',15)} ${esc(timeLabel(g.total_play_seconds))}</div><div class="detail-stat">${ic('clock',15)} Last played: ${esc(formatDate(g.last_played_at))}</div>
 <div class="detail-actions"><button class="primary-btn" data-action="launch" data-id="${esc(g.id)}">${ic('play',16)} Play game</button><button class="secondary-btn" data-action="favorite" data-id="${esc(g.id)}">${ic('heart',16)} ${g.favorite?'Unfavorite':'Favorite'}</button></div></div></div>
 ${artwork(g.banner)?`<img class="detail-banner" src="${artwork(g.banner)}" alt="Game banner" />`:''}
 <div class="hr"></div><div class="detail-stat">${ic('folder',15)} <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(g.install_path||g.executable||'')}" >${esc(g.install_path||g.executable||'No install path saved')}</span></div>
 ${g.launch_uri?`<p class="detail-note">Starts through ${esc(sourceLabel(g))} using a launcher URI. External launcher processes cannot be tracked reliably.</p>`:g.executable?'<p class="detail-note">Direct executable launches count play time while Orbit is running and the launched process remains open.</p>':'<p class="detail-note">A valid executable or game launcher URI is required to launch this title.</p>'}
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
 const warnings=state.scanWarnings.length?`<div class="warning-line">${ic('alert',15)} ${esc(state.scanWarnings.slice(0,3).join(' • '))}${state.scanWarnings.length>3?` · ${state.scanWarnings.length-3} more warnings`:''}</div>`:'';
 const rows=games.slice(first,first+IMPORT_PAGE_SIZE).map((g,offset)=>{const i=first+offset;return `<label class="import-item ${g.alreadyAdded?'added':''}"><input type="checkbox" data-import-index="${i}" ${state.selectedImports.has(i)?'checked':''} ${g.alreadyAdded?'disabled':''}/><div class="icon-box">${ic(g.source==='steam'?'gamepad':'folder',18)}</div><span style="min-width:0;flex:1"><strong>${esc(g.name)}</strong><small>${esc(sourceLabel(g))} · ${esc(g.install_path||g.executable||'Launcher entry')}${g.alreadyAdded?' · Already in library':''}</small></span></label>`}).join('');
 const paging=pageCount>1?`<div class="import-toolbar" aria-label="Import result pages"><span class="muted" style="font-size:12px">Showing ${first+1}–${Math.min(games.length,first+IMPORT_PAGE_SIZE)} of ${games.length} (page ${state.importPage+1} of ${pageCount})</span><div style="display:flex;gap:8px"><button class="secondary-btn" data-action="import-page" data-page="prev" ${state.importPage===0?'disabled':''}>Previous</button><button class="secondary-btn" data-action="import-page" data-page="next" ${state.importPage===pageCount-1?'disabled':''}>Next</button></div></div>`:'';
 const selectionHint=addable.length>MAX_IMPORT_SELECTION?`<p class="setting-help">Each import supports up to ${MAX_IMPORT_SELECTION.toLocaleString()} games. Import the selected games, then rescan to import the remaining titles.</p>`:'';
 return dialogFrame('Discover installed games',description,`<div class="dialog-body">${warnings}<div class="import-toolbar"><span class="muted" style="font-size:12px">${selected} selected across all pages</span><button class="small-link" data-action="toggle-all-import">${selected?'Deselect all':'Select all new'}</button></div>${games.length?`<div class="import-list">${rows}</div>${paging}${selectionHint}`:emptyState('No installed games found','Add your preferred library folders in Settings or add an executable manually.',`<button class="secondary-btn" data-action="add">${ic('plus',15)} Add manually</button>`)}</div>`,`<div class="dialog-footer"><button class="secondary-btn" data-action="close-modal">Cancel</button><button class="primary-btn" data-action="import" ${selected?'':'disabled'}>${ic('download',16)} Import ${selected} ${selected===1?'game':'games'}</button></div>`,true);
}
function renderModal(){const modal=state.modal;if(!modal){el('modal-root').innerHTML='';return}let html='';
 if(modal.type==='game')html=editor(modal.id?state.games.find(g=>g.id===modal.id):null);
 else if(modal.type==='detail')html=detail(state.games.find(g=>g.id===modal.id));
 else if(modal.type==='scan')html=dialogFrame('Scanning your games','Looking through installed launchers and selected library folders.',`<div class="dialog-body" style="display:grid;place-items:center;min-height:200px;text-align:center;color:var(--muted)"><div>${ic('refresh',42)}<p>Scanning local manifests and folders…</p></div></div>`);
 else if(modal.type==='import')html=importDialog();
 else if(modal.type==='remove'){const g=state.games.find(x=>x.id===modal.id);html=dialogFrame('Remove from library?',`Remove ${g?.name||'this game'} from Orbit. Installed files will remain untouched.`,`<div class="dialog-body"><p style="color:var(--muted)">This removes the library entry, custom metadata and tracked play time. It does not uninstall the game.</p></div>`,`<div class="dialog-footer"><button class="secondary-btn" data-action="close-modal">Keep game</button><button class="danger-btn" data-action="remove" data-id="${esc(modal.id)}">${ic('trash',15)} Remove game</button></div>`)}
 el('modal-root').innerHTML=html;
 const dialog=el('modal-root').querySelector('.dialog');if(dialog){dialog.setAttribute('tabindex','-1');dialog.focus({preventScroll:true});}
}
async function performScan(){if(state.scanning)return toast('A scan is already running.');state.scanning=true;openModal('scan');
 try{const results=await window.orbit.discoverGames();if(state.modal?.type!=='scan')return;state.imports=results.games;state.importPage=0;state.scanWarnings=results.warnings||[];state.selectedImports=new Set(results.games.flatMap((g,i)=>g.alreadyAdded?[]:[i]).slice(0,MAX_IMPORT_SELECTION));openModal('import')}
 catch(e){if(state.modal?.type==='scan')closeModal();toast(e.message||'Scan failed',true)}finally{state.scanning=false}
}
async function performImport(){const games=[...state.selectedImports].map(i=>state.imports[i]).filter(x=>x&&!x.alreadyAdded).map(({alreadyAdded,...rest})=>rest);if(!games.length)return;
 const button=el('modal-root').querySelector('[data-action=import]');if(button)button.disabled=true;
 try{const result=await window.orbit.importGames(games);closeModal();await refreshGames();toast(`Imported ${result.imported} ${result.imported===1?'game':'games'}.${result.skipped?' '+result.skipped+' already in library.':''}`);if(result.errors.length)toast(result.errors.slice(0,3).join(' · '),true)}
 catch(e){toast(e.message||'Import failed.',true);if(button)button.disabled=false}
}
async function performLaunch(id){const game=state.games.find(g=>g.id===id);if(!game)return;
 try{const result=await window.orbit.launchGame(id);toast(result.message||`Launched ${game.name}`);await refreshGames();if(state.modal?.type==='detail'&&state.modal.id===id)renderModal();}
 catch(e){toast(e.message||`Could not launch ${game.name}`,true)}
}
async function favorite(id){try{await window.orbit.favoriteGame(id);await refreshGames();if(state.modal?.type==='detail'&&state.modal.id===id)renderModal()}catch(e){toast(e.message,true)}}
async function storeGame(form){const data=Object.fromEntries(new FormData(form));data.tags=String(data.tags||'').split(',').map(t=>t.trim()).filter(Boolean);
 try{data.launch_args=JSON.parse(data.launch_args||'[]');if(!Array.isArray(data.launch_args))throw Error()}catch{toast('Launch arguments must be a JSON array, for example ["--fullscreen"].',true);return}
 if(!data.executable?.trim()&&!data.launch_uri?.trim()){toast('Choose an executable or enter a supported game-launch URI.',true);return}
 const button=form.querySelector('[type=submit]');button.disabled=true;
 try{if(form.dataset.id)await window.orbit.updateGame(form.dataset.id,data);else await window.orbit.addGame({...data,source:'manual'});closeModal();await refreshGames();toast(form.dataset.id?'Game updated.':'Game added to your library.');}
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
  case 'navigate':navigate(button.dataset.route);break;
  case 'add':openModal('game');break;
  case 'edit':openModal('game',{id});break;
  case 'detail':openModal('detail',{id});break;
  case 'close-modal':closeModal();break;
  case 'scrim':if(button.classList.contains('dialog-scrim'))closeModal();break;
  case 'launch':await performLaunch(id);break;
  case 'favorite':await favorite(id);break;
  case 'remove-confirm':openModal('remove',{id});break;
  case 'remove':try{await window.orbit.removeGame(id);closeModal();await refreshGames();toast('Game removed from your library.')}catch(e){toast(e.message,true)}break;
  case 'scan':await performScan();break;
  case 'repair-artwork':{button.disabled=true;try{const result=await window.orbit.repairSteamArtwork();await refreshGames();toast(result.disabled?'Enable Steam artwork downloads first.':`Updated ${result.found} portrait covers and ${result.icons||0} game icons across ${result.attempted} games.`)}catch(e){toast(e.message||'Cover repair failed.',true)}finally{button.disabled=false}break;}
  case 'import':await performImport();break;
  case 'toggle-all-import':{const allowed=state.imports.flatMap((g,i)=>g.alreadyAdded?[]:[i]).slice(0,MAX_IMPORT_SELECTION);state.selectedImports=state.selectedImports.size?new Set():new Set(allowed);renderModal();break;}
  case 'import-page':{const direction=button.dataset.page;state.importPage=Math.max(0,Math.min(Math.ceil(state.imports.length/IMPORT_PAGE_SIZE)-1,state.importPage+(direction==='next'?1:-1)));renderModal();el('modal-root').querySelector(`[data-page="${direction}"]:not([disabled])`)?.focus();break;}
  case 'choose-exe':{try{const file=await window.orbit.chooseExecutable();if(file){el('game-executable').value=file;await detectGameFile(file);}}catch(e){toast(e.message,true)}break;}
  case 'find-art':{const file=el('game-executable')?.value?.trim();if(!file){toast('Choose a game executable first.',true);break;}await detectGameFile(file);break;}
  case 'find-online-art':{
   const name=el('game-name')?.value?.trim();
   if(!name){toast('Enter the complete game title to search for its cover.',true);break;}
   const modal=state.modal,status=el('game-detection-status'),oldCover=el('game-cover')?.value;
   if(status)status.textContent='Searching Steam for an exact game title…';
   button.disabled=true;
   try{
    const found=await window.orbit.findOnlineCover(name);
    if(state.modal!==modal||el('game-name')?.value.trim()!==name)return;
    if(found.cover&&el('game-cover')?.value===oldCover){
     el('game-cover').value=found.cover;
     el('preview-cover').innerHTML=`<img src="${artwork(found.cover)}" alt="Cover from Steam"/>`;
    }
    if(status)status.textContent=found.message||'No cover found.';
   }catch(e){if(status)status.textContent=e.message||'Steam artwork search unavailable.';toast(e.message,true)}
   finally{button.disabled=false}
   break;
  }
  case 'choose-art':{try{const file=await window.orbit.chooseArtwork();if(file){const key=button.dataset.key;el(`game-${key}`).value=file;el(`preview-${key}`).innerHTML=`<img src="${artwork(file)}" alt="Artwork preview"/>`}}catch(e){toast(e.message,true)}break;}
  case 'clear-art':{const key=button.dataset.key;const input=el(`game-${key}`),preview=el(`preview-${key}`);if(!input||!preview)break;input.value='';const fallback=key==='cover'?artwork(el('game-icon')?.value):null;preview.innerHTML=fallback?`<div class="auto-icon-preview"><img src="${fallback}" alt="Icon fallback" /></div>`:`<div class="image-placeholder">${ic('image',21)}</div>`;break;}

  case 'open-folder':try{await window.orbit.openGameFolder(id)}catch(e){toast(e.message,true)}break;
  case 'open-data':try{await window.orbit.openAppData()}catch(e){toast(e.message,true)}break;
  case 'clear-filters':state.query='';state.filter='all';state.tag='all';state.genre='all';const search=el('global-search');if(search)search.value='';renderPage();break;
  case 'view':state.view=button.dataset.view;await saveSettings({view:state.view});renderPage({keepScroll:true});break;
  case 'accent':await saveSettings({accent:button.dataset.color});break;
  case 'setting-toggle':{const key=button.dataset.key;await saveSettings({[key]:!state.settings[key]});break;}
  case 'add-folder':{try{const dir=await window.orbit.chooseFolder();if(dir){const folders=[...new Set([...state.settings.libraryFolders,dir])];await saveSettings({libraryFolders:folders});toast('Scan location added.')}}catch(e){toast(e.message,true)}break;}
  case 'remove-folder':{const folders=state.settings.libraryFolders.filter((_,i)=>i!==Number(button.dataset.index));await saveSettings({libraryFolders:folders});break;}
  case 'export':try{const res=await window.orbit.exportLibrary();if(res?.path){toast(res.portable?'Portable library backup exported.':'Metadata-only JSON backup exported.');if(res.missingArtwork)toast(`${res.missingArtwork} missing or invalid artwork file(s) were not included.`,true)}}catch(e){toast(e.message,true)}break;
  case 'restore':try{const res=await window.orbit.restoreLibrary();if(res){await refreshGames();toast(`Restored ${res.imported} games; skipped ${res.skipped}.`);if(res.errors?.length)toast(res.errors.slice(0,2).join(' · '),true)}}catch(e){toast(e.message,true)}break;
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
 if(target.id==='source-filter'){state.filter=target.value;renderPage();return}
 if(target.id==='tag-filter'){state.tag=target.value;renderPage();return}
 if(target.id==='genre-filter'){state.genre=target.value;renderPage();return}
 if(target.id==='sort-by'){state.sort=target.value;try{await saveSettings({sort:state.sort})}catch(e){toast(e.message,true)}renderPage({keepScroll:true});return}
 if(target.id==='theme-select'){try{await saveSettings({theme:target.value})}catch(e){toast(e.message,true)}}
});
let searchTimer;document.addEventListener('input',event=>{if(event.target.id!=='global-search')return;
 state.query=event.target.value;if(!['library','favorites','recent'].includes(state.route)){state.route='library';el('side-slot').innerHTML=sidebar();renderPage();}
 clearTimeout(searchTimer);searchTimer=setTimeout(()=>{if(['library','favorites','recent'].includes(state.route)){const scroller=el('main-scroll');if(scroller)scroller.scrollTop=0;renderVirtual();}},95);
});
document.addEventListener('submit',event=>{if(event.target.id==='game-form'){event.preventDefault();storeGame(event.target)}});
document.addEventListener('keydown',event=>{
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
  if(!(img instanceof HTMLImageElement)||!img.matches('.cover-image,.row-cover img:not(.list-game-icon)'))return;
  const ratio=img.naturalHeight?img.naturalWidth/img.naturalHeight:0;
  img.classList.toggle('bad-aspect',ratio<0.5||ratio>0.85);
}
document.addEventListener('load',event=>checkCoverAspect(event.target),true);
document.addEventListener('error',event=>{
  if(event.target instanceof HTMLImageElement&&event.target.matches('.cover-image,.row-cover img:not(.list-game-icon)'))
    event.target.classList.add('bad-aspect');
},true);
window.addEventListener('resize',()=>{if(['library','recent','favorites'].includes(state.route))renderVirtual()});
window.matchMedia?.('(prefers-color-scheme:light)')?.addEventListener('change',()=>{if(state.settings?.theme==='system')setupTheme()});
async function boot(){try{if(!window.orbit)throw Error('Desktop integration is unavailable. Start Orbit using Electron.');
 const data=await window.orbit.bootstrap();state.games=data.games;state.runningIds=data.runningIds||[];state.settings=data.settings;state.sort=data.settings.sort||'name';state.view=data.settings.view||'grid';state.platform=data.platform;state.version=data.version;
 setupTheme();renderShell();window.orbit.onEvent(async event=>{
  if(event.type==='gamesChanged')try{await refreshGames();if(state.modal?.type==='detail')renderModal()}catch(e){toast(e.message,true)}
  if(event.type==='settingsChanged'){state.settings=event.settings;setupTheme()}
  if(event.type==='error')toast(event.message,true);
 });
 }catch(e){el('app').innerHTML=`<div class="boot"><div class="boot-logo">!</div><h2>Orbit could not start</h2><p>${esc(e.message||'Unknown error.')}</p></div>`}}
boot();
})();

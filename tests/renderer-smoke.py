"""Optional Chromium UI smoke test. Requires playwright and a Chromium browser."""
import asyncio
from pathlib import Path
import re
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
MOCK = r"""
(() => {
  const games = Array.from({length: 80}, (_,n)=>({
    id: `${String(n+1).padStart(8,'0')}-0000-4000-8000-000000000000`,
    name:['Hollow Knight','Hades','Stardew Valley','Celeste','No Man\'s Sky','The Witcher 3','Dead Cells','Terraria','Outer Wilds','Slay the Spire'][n%10]+(n>=10?' '+String(Math.ceil(n/10)):''),
    source:['steam','epic','gog','manual'][n%4],source_id:n%4===0?String(n+1):'',install_path:'/games/test',executable:'/bin/true',launch_uri:'',
    cover:'',banner:'',genre:n%2?'Action':'Adventure',tags:n%2?['Action','Co-op']:['Indie','Adventure'],favorite:n%7===0,
    total_play_seconds:n*1500,last_played_at:n%3?new Date(Date.now()-n*86400*1000).toISOString():null,
    created_at:new Date(Date.now()-n*86400*1000).toISOString(),launch_args:[],working_dir:''
  }));
  let settings={theme:'dark',accent:'#8b7aff',reduceMotion:false,autoScan:false,useSteamArtwork:true,libraryFolders:[],view:'grid',sort:'name',onboardingDone:false};
  const listeners=[];
  const emit = e => listeners.forEach(fn=>fn(e));
  window.orbit = {
    bootstrap:async()=>({games:games.slice(),settings:{...settings},platform:'linux',version:'1.0.0'}),
    listGames:async()=>games.slice(),
    addGame:async g=>{const n={...g,id:`00000000-0000-4000-8000-${String(games.length+1).padStart(12,'0')}`,favorite:false,total_play_seconds:0,created_at:new Date().toISOString(),last_played_at:null};games.push(n);emit({type:'gamesChanged'});return {game:n,added:true}},
    updateGame:async(id,changes)=>{const i=games.findIndex(g=>g.id===id);games[i]={...games[i],...changes};emit({type:'gamesChanged'});return games[i]},
    favoriteGame:async id=>{const g=games.find(g=>g.id===id);g.favorite=!g.favorite;emit({type:'gamesChanged'});return g},
    removeGame:async id=>{const n=games.findIndex(g=>g.id===id);games.splice(n,1);emit({type:'gamesChanged'});return true},
    launchGame:async()=>({message:'Game launched',tracked:true}),
    saveSettings:async patch=>{settings={...settings,...patch};emit({type:'settingsChanged',settings});return settings},
    chooseExecutable:async()=>'/tmp/test.exe',inspectGameFile:async file=>({executable:file,name:'Test',working_dir:'/tmp',cover:'',icon:''}),chooseArtwork:async()=>null,chooseFolder:async()=>'/games',
    discoverGames:async()=>({games:[{name:'A discovered game',source:'steam',source_id:'98218',install_path:'/games',launch_uri:'steam://rungameid/98218',alreadyAdded:false}],warnings:[]}),
    importGames:async arr=>{arr.forEach((g,n)=>games.push({...g,id:`10000000-0000-4000-8000-${String(n+1).padStart(12,'0')}`,favorite:false,total_play_seconds:0,created_at:new Date().toISOString(),last_played_at:null}));emit({type:'gamesChanged'});return {imported:arr.length,skipped:0,errors:[]}},
    openAppData:async()=>true,openGameFolder:async()=>true,exportLibrary:async()=>({path:'/tmp/orbit.json'}),restoreLibrary:async()=>({imported:0,skipped:0,errors:[]}),
    onEvent:callback=>{listeners.push(callback);return()=>{}}
  };
})();
"""
async def run():
  async with async_playwright() as p:
    browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=await browser.new_page(viewport={'width':1440,'height':900},device_scale_factor=1)
    errors=[]
    page.on('pageerror',lambda error: errors.append(str(error)))
    html=(ROOT/'src/ui/index.html').read_text()
    css=(ROOT/'src/ui/styles.css').read_text()
    html=re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]+>', '', html)
    html=html.replace('<link rel="stylesheet" href="./styles.css" />', f'<style>{css}</style>')
    html=html.replace('<script src="./app.js" defer></script>','')
    await page.set_content(html)
    await page.evaluate(MOCK)
    await page.add_script_tag(content=(ROOT/'src/ui/app.js').read_text())
    await page.get_by_text('Welcome to Orbit').wait_for()
    await page.screenshot(path=str(ROOT/'preview-dashboard.png'),full_page=True)
    assert await page.get_by_text('Total games').count()==1
    await page.get_by_role('button',name='My library').click()
    await page.get_by_text('Your game library').wait_for()
    await page.screenshot(path=str(ROOT/'preview-library.png'),full_page=True)
    assert await page.locator('.game-card').count()<80, 'large list should virtualize'
    await page.locator('#global-search').fill('Hades')
    await page.wait_for_timeout(180)
    assert await page.locator('.game-card').count()>0
    assert await page.locator('.game-card').count()<30
    await page.locator('#global-search').fill('')
    await page.get_by_role('button',name='Add game').click()
    await page.locator('#game-name').fill('Example Test Game')
    await page.locator('#game-executable').fill('/bin/true')
    await page.get_by_role('button',name='Add to library').click()
    await page.get_by_text('Game added to your library.').wait_for()
    await page.locator('#global-search').fill('Example Test Game')
    await page.wait_for_timeout(130)
    await page.locator('.game-card').first.click()
    await page.get_by_role('button',name='Edit').click()
    await page.locator('#game-name').fill('Example Edited Game')
    await page.get_by_role('button',name='Save changes').click()
    await page.get_by_text('Game updated.').wait_for()
    await page.locator('#global-search').fill('')
    await page.get_by_role('button',name='Settings').click()
    assert await page.locator('#global-search').input_value()=='' , 'old library search should clear when navigating'
    await page.locator('#theme-select').select_option('light')
    await page.wait_for_timeout(150)
    assert await page.locator('body').get_attribute('data-theme')=='light'
    await page.screenshot(path=str(ROOT/'preview-settings-light.png'),full_page=True)
    await page.get_by_role('button',name='Scan now').click()
    await page.get_by_text('A discovered game').wait_for()
    checkbox=page.locator('[data-import-index="0"]')
    await checkbox.uncheck()
    assert await checkbox.evaluate('(el) => document.activeElement===el'), 'Changing import selection must preserve keyboard focus'
    assert await page.locator('[data-action="import"]').is_disabled()
    await checkbox.check()
    assert await checkbox.evaluate('(el) => document.activeElement===el')
    await page.get_by_role('button',name='Import 1 game').click()
    await page.get_by_text('Imported 1 game.').wait_for()
    await page.get_by_role('button',name='My library').click()
    await page.locator('#sort-by').select_option('time')
    await page.get_by_role('button',name='List view').click()
    assert await page.locator('.game-row').count()>0
    # Paging: results beyond the old 800-entry cutoff must be reachable and
    # the selected state must remain correct while moving between pages.
    await page.evaluate("""() => {window.orbit.discoverGames = async () => ({
      games: Array.from({length:251}, (_,i) => ({name:`Discovered ${i}`,source:'steam',source_id:String(i+2000),
        install_path:'/games',launch_uri:`steam://rungameid/${i+2000}`,alreadyAdded:i<250})),warnings:[]});}""")
    await page.get_by_role('button',name='Scan library').click()
    await page.locator('[data-import-index="0"]').wait_for()
    assert await page.locator('[data-action="import"]').inner_text() == 'Import 1 game'
    await page.locator('[data-action="import-page"][data-page="next"]').click()
    await page.locator('[data-import-index="100"]').wait_for()
    await page.locator('[data-action="import-page"][data-page="next"]').click()
    final_checkbox=page.locator('[data-import-index="250"]')
    await final_checkbox.wait_for()
    assert await final_checkbox.is_checked(), 'last-page selection should survive paging'
    await final_checkbox.uncheck()
    assert await page.locator('[data-action="import"]').is_disabled()
    await final_checkbox.check()
    assert await page.locator('[data-action="import"]').inner_text() == 'Import 1 game'
    await page.locator('[data-action="import"]').click()
    await page.get_by_text('Imported 1 game.').last.wait_for()
    # Rescans with 10,000 already-imported titles must still select new titles
    # after them. The old first-800 logic made those titles unreachable.
    await page.evaluate("""() => {window.orbit.discoverGames = async () => ({
      games: Array.from({length:10025}, (_,i) => ({name:`Discovered ${i}`,source:'steam',source_id:String(i+3000),
        install_path:'/games',launch_uri:`steam://rungameid/${i+3000}`,alreadyAdded:i<10000})),warnings:[]});}""")
    await page.get_by_role('button',name='Scan library').click()
    await page.locator('[data-import-index="0"]').wait_for()
    assert 'Import 25 games' in await page.locator('[data-action="import"]').inner_text()
    await page.locator('[data-action="import"]').click()
    await page.get_by_text('Imported 25 games.').wait_for()
    # Closing a long-running scan must not reopen a dialog when it finishes.
    await page.evaluate("""() => {window.orbit.discoverGames = () => new Promise(resolve => {
      window.finishDeferredScan = () => resolve({games:[{name:'Late scan game',source:'steam',source_id:'65000',alreadyAdded:false}],warnings:[]});
    });}""")
    await page.get_by_role('button',name='Scan library').click()
    await page.get_by_text('Scanning your games').wait_for()
    await page.get_by_role('button',name='Close dialog').click()
    await page.evaluate('window.finishDeferredScan()')
    await page.wait_for_timeout(100)
    assert await page.locator('.dialog').count() == 0, 'completed cancelled scan reopened its dialog'
    if errors: raise AssertionError('Browser errors: '+str(errors))
    empty=await browser.new_page(viewport={'width':910,'height':610})
    await empty.set_content(html)
    await empty.evaluate(MOCK.replace('length: 80','length: 0'))
    await empty.add_script_tag(content=(ROOT/'src/ui/app.js').read_text())
    await empty.get_by_text('Ready for your first game?').wait_for()
    await empty.get_by_role('button',name='My library').click()
    await empty.get_by_text('No games yet').wait_for()
    assert await empty.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth')
    await empty.close()
    # 5,000-game stress run: measures frontend work only; mock backend is in memory.
    large=await browser.new_page(viewport={'width':1440,'height':900})
    await large.set_content(html)
    await large.evaluate(MOCK.replace('length: 80','length: 5000'))
    import time
    started=time.perf_counter()
    await large.add_script_tag(content=(ROOT/'src/ui/app.js').read_text())
    await large.get_by_text('Welcome to Orbit').wait_for()
    start_ms=(time.perf_counter()-started)*1000
    started=time.perf_counter()
    await large.get_by_role('button',name='My library').click()
    await large.get_by_text('Your game library').wait_for()
    render_ms=(time.perf_counter()-started)*1000
    visible=await large.locator('.game-card').count()
    assert visible<65,f'virtualization rendered {visible} cards for 5000 games'
    # A scroll within the same virtual row must preserve DOM nodes and keyboard
    # focus. Earlier versions recreated every visible card on every scroll event.
    await large.locator('.game-card').first.evaluate('(el) => el.dataset.preserved = "yes"')
    await large.locator('#main-scroll').evaluate('(el) => { el.scrollTop = 10; el.dispatchEvent(new Event("scroll")); }')
    await large.wait_for_timeout(70)
    assert await large.locator('.game-card').first.get_attribute('data-preserved') == 'yes', 'same-row scroll should not rebuild cards'
    started=time.perf_counter()
    await large.locator('#global-search').fill('Hollow Knight')
    await large.wait_for_timeout(150)
    search_ms=(time.perf_counter()-started)*1000-150
    await large.locator('#global-search').fill('')
    await large.wait_for_timeout(150)
    await large.locator('#main-scroll').evaluate('(el) => { el.scrollTop = 50000; el.dispatchEvent(new Event("scroll")); }')
    await large.wait_for_timeout(80)
    assert await large.locator('.game-card').count()<65
    await large.locator('#source-filter').select_option('gog')
    assert await large.locator('.game-card').count()>0, 'filtering after deep scrolling must show items'
    assert await large.locator('#main-scroll').evaluate('(el) => el.scrollTop') == 0, 'filtering must return to top'
    print(f'5,000-game renderer mock: startup {start_ms:.1f} ms, initial library {render_ms:.1f} ms, search excluding debounce {max(0,search_ms):.1f} ms, visible cards {visible}')
    await large.close()
    # Stress the same virtualized renderer with a substantially larger library.
    huge=await browser.new_page(viewport={'width':1440,'height':900})
    await huge.set_content(html)
    await huge.evaluate(MOCK.replace('length: 80','length: 20000'))
    huge_started=time.perf_counter()
    await huge.add_script_tag(content=(ROOT/'src/ui/app.js').read_text())
    await huge.get_by_text('Welcome to Orbit').wait_for()
    await huge.get_by_role('button',name='My library').click()
    await huge.get_by_text('Your game library').wait_for()
    huge_ms=(time.perf_counter()-huge_started)*1000
    await huge.locator('#main-scroll').evaluate('(el) => { el.scrollTop = 400000; el.dispatchEvent(new Event("scroll")); }')
    await huge.wait_for_timeout(90)
    huge_visible=await huge.locator('.game-card').count()
    assert 0<huge_visible<65,f'20,000-item scroll unexpectedly mounted {huge_visible} cards'
    print(f'20,000-game renderer stress: boot + library {huge_ms:.1f} ms, mounted cards after deep scroll {huge_visible}')
    await huge.close()
    await browser.close()
    print('Renderer smoke PASS: dashboard, library virtualization, search, manual add, themes, scan/import, sorting, list view, zero JS errors')
asyncio.run(run())

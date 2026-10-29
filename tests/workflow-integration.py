"""Browser workflow test with Orbit's real SQLite/main-process handlers.

Uses Chromium and minimal Electron stand-ins. Native Electron windows, OS dialogs
and third-party game launchers remain outside the scope of this test.
"""
import asyncio
import json
import os
from pathlib import Path
import re
import tempfile
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = r"""
(() => {
  const listeners = new Set();
  const methods = ['bootstrap','listGames','getGame','addGame','updateGame','removeGame',
    'favoriteGame','saveSettings','chooseExecutable','inspectGameFile','findOnlineCover','chooseArtwork','chooseFolder',
    'discoverGames','importGames','launchGame','openGameFolder','openAppData','getAppInfo',
    'exportLibrary','restoreLibrary'];
  const changes = new Set(['addGame','updateGame','removeGame','favoriteGame','importGames','restoreLibrary','launchGame']);
  const emit = event => {for(const listener of listeners) listener(event);};
  window.orbit = {};
  for (const method of methods) window.orbit[method] = async (...args) => {
    const value = await window.orbitBridge(method, args);
    if (changes.has(method)) emit({type:'gamesChanged'});
    if (method === 'saveSettings') emit({type:'settingsChanged',settings:value});
    return value;
  };
  window.orbit.onEvent = callback => {listeners.add(callback);return () => listeners.delete(callback);};
})();
"""

class NodeHost:
    def __init__(self, process):
        self.proc = process
        self.pending = {}
        self.counter = 0
        self.task = asyncio.create_task(self.reader())
        self.ready = asyncio.Event()
        self.messages = []
    async def reader(self):
        while line := await self.proc.stdout.readline():
            event = json.loads(line.decode())
            if event.get('ready'):
                self.ready.set()
            elif 'id' in event:
                future = self.pending.pop(event['id'],None)
                if future:
                    if event['ok']: future.set_result(event['result'])
                    else: future.set_exception(RuntimeError(event['error']))
            else:
                self.messages.append(event)
    async def call(self,method,args=None):
        self.counter+=1
        future=asyncio.get_running_loop().create_future()
        self.pending[self.counter]=future
        self.proc.stdin.write((json.dumps({'id':self.counter,'method':method,'args':args or []})+'\n').encode())
        await self.proc.stdin.drain()
        return await asyncio.wait_for(future,10)
    async def close(self):
        await self.call('__quit')
        self.proc.stdin.close()
        await self.proc.wait()
        await self.task

async def add_page(browser,host,html,css,width=1440,height=900):
    page=await browser.new_page(viewport={'width':width,'height':height})
    page.set_default_timeout(7000)
    errors=[]
    page.on('pageerror',lambda err:errors.append(str(err)))
    await page.expose_binding('orbitBridge',lambda _source,method,args:host.call(method,args))
    await page.set_content(html)
    await page.evaluate(BRIDGE)
    await page.add_script_tag(content=(ROOT/'src/ui/library-updates.js').read_text(encoding='utf-8'))
    await page.add_script_tag(content=(ROOT/'src/ui/app.js').read_text())
    await page.get_by_text('Welcome to Orbit').wait_for(timeout=12000)
    return page,errors

async def run():
  with tempfile.TemporaryDirectory(prefix='orbit-workflow-') as base:
    base=Path(base)
    home=base/'home'
    home.mkdir()
    game_dir=base/'Local games'/'Demo Adventure'
    game_dir.mkdir(parents=True)
    cover_picture=base/'cover.png'
    # Valid one-pixel PNG for a real artwork import through the native handler.
    import base64
    cover_picture.write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=='))
    log_file=base/'game-args.json'
    executable=game_dir/'Demo Adventure.sh'
    executable.write_text('#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > '+json.dumps(str(log_file))+'\nsleep 1\n')
    executable.chmod(0o755)
    manual_game=base/'Local games'/'Starlight Runner'
    manual_game.mkdir(parents=True)
    manual_exe=manual_game/'Starlight Runner.exe'
    manual_exe.write_bytes(b'harmless test executable fixture')
    (manual_game/'cover.png').write_bytes(cover_picture.read_bytes())
    # A Steam manifest in a fake HOME makes discovery exercise a real manifest path.
    steam=home/'.steam'/'steam'/'steamapps'
    steam.mkdir(parents=True)
    (steam/'common'/'FixtureSteam').mkdir(parents=True)
    (steam/'appmanifest_890.acf').write_text('"AppState" { "appid" "890" "name" "Steam Fixture" "installdir" "FixtureSteam" }')
    gog_dir=base/'Local games'/'GOG Fixture'
    gog_dir.mkdir()
    gog_exe=gog_dir/'GOGGame.sh'
    gog_exe.write_text('#!/bin/sh\nexit 0\n')
    gog_exe.chmod(0o755)
    (gog_dir/'goggame-100.info').write_text(json.dumps({'gameId':'100','name':'GOG Fixture','playTasks':[{'isPrimary':True,'path':'GOGGame.sh'}]}))
    hoi_dir=base/'Local games'/'Hearts of Iron IV'
    hoi_dir.mkdir()
    hoi_exe=hoi_dir/'hoi4.exe'
    hoi_exe.write_text('not a real executable; tests never launch this file')
    data=base/'userdata'
    env={**os.environ,'HOME':str(home),'ORBIT_E2E_DATA':str(data)}
    process=await asyncio.create_subprocess_exec('node',str(ROOT/'tests/electron-stub-host.cjs'),
        env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
    host=NodeHost(process)
    await asyncio.wait_for(host.ready.wait(),10)
    html=(ROOT/'src/ui/index.html').read_text()
    css=(ROOT/'src/ui/styles.css').read_text()
    html=re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]+>', '', html)
    html=html.replace('<link rel="stylesheet" href="./styles.css" />',f'<style>{css}</style>')
    html=html.replace('<script src="./app.js" defer></script>','')
    async with async_playwright() as p:
      browser=await p.chromium.launch(headless=os.environ.get('ORBIT_HEADFUL')!='1',executable_path='/usr/bin/chromium',args=['--no-sandbox'])
      page,errors=await add_page(browser,host,html,css)
      try:
        # Initial empty state, add with the actual native picker handler and edit.
        await page.get_by_text('Ready for your first game?').wait_for()
        # A modal keeps keyboard navigation inside its controls and returns focus on Escape.
        trigger=page.get_by_role('button',name='Add game').first
        await trigger.click()
        await page.keyboard.press('Shift+Tab')
        assert await page.evaluate('document.activeElement.matches("#game-form [type=submit]")')
        await page.keyboard.press('Tab')
        assert await page.evaluate('document.activeElement.matches(".dialog-header [data-action=close-modal]")')
        await page.keyboard.press('Escape')
        assert await page.locator('#game-form').count()==0
        # Choose a Windows-style .exe. Real IPC scans its directory for art,
        # extracts the icon through Electron's icon API stand-in and autofills
        # the name and working directory in the existing Add Game dialog.
        await host.call('__dialog',[str(manual_exe)])
        await page.get_by_role('button',name='Add game').first.click()
        await page.get_by_role('button',name='Browse .exe').click()
        await page.wait_for_function('document.querySelector("#game-cover")?.value.endsWith(".png")')
        assert await page.locator('#game-name').input_value()=='Starlight Runner'
        assert await page.locator('#game-workdir').input_value()==str(manual_game)
        assert (await page.locator('#game-icon').input_value()).endswith('.png')
        artwork_dir=data/'artwork'
        count_before=len(list(artwork_dir.iterdir()))
        again=await host.call('inspectGameFile',[str(manual_exe)])
        assert again['icon']==await page.locator('#game-icon').input_value()
        assert again['cover']==await page.locator('#game-cover').input_value()
        assert len(list(artwork_dir.iterdir()))==count_before, 'repeated detection should reuse saved images'
        # The Chromium stand-in does not register Electron's orbit-art scheme.
        # Substitute the real saved PNG bytes only for this layout screenshot.
        for kind in ['cover','icon']:
            asset=await page.locator(f'#game-{kind}').input_value()
            picture=artwork_dir/asset
            await page.locator(f'#preview-{kind} img').evaluate('(img,src)=>img.src=src',
                'data:image/png;base64,'+base64.b64encode(picture.read_bytes()).decode())
        await page.screenshot(path=str(ROOT/'preview-add-executable.png'))
        await page.get_by_role('button',name='Add to library').click()
        await page.get_by_text('Game added to your library.').wait_for()
        scanned=await host.call('listGames')
        assert len(scanned)==1 and scanned[0]['cover'] and scanned[0]['icon'],scanned
        await page.get_by_role('button',name='My library').click()
        await page.locator('.game-card').first.click()
        await page.get_by_role('button',name='Edit').click()
        await page.get_by_role('button',name='Clear Cover artwork').click()
        assert await page.locator('#game-cover').input_value()==''
        assert (await page.locator('#game-icon').input_value()).endswith('.png')
        await page.get_by_role('button',name='Save changes').click()
        updated=(await host.call('listGames'))[0]
        assert updated['cover']=='' and updated['icon'],updated
        await page.locator('.game-card').first.click()
        await page.get_by_role('button',name='Remove',exact=True).click()
        await page.get_by_role('button',name='Remove game').click()
        assert manual_exe.exists(), 'removing library entry must not delete executable'
        assert (await host.call('listGames'))==[]
        # A DRM-free / standalone executable is imported directly. Recognize
        # hoi4.exe offline and attach public artwork without a Steam install.
        await page.get_by_role('button',name='Add game').first.click()
        await host.call('__dialog',[str(hoi_exe)])
        await page.get_by_role('button',name='Browse .exe').click()
        await page.wait_for_function('document.querySelector("#game-name")?.value === "Hearts of Iron IV"')
        await page.wait_for_function('document.querySelector("#game-cover")?.value.endsWith(".jpg")')
        assert 'Recognized as Hearts of Iron IV' in await page.locator('#game-detection-status').inner_text()
        assert 'Cover downloaded from Steam' in await page.locator('#game-detection-status').inner_text()
        await page.get_by_role('button',name='Add to library').click()
        await page.get_by_text('Game added to your library.').wait_for()
        imported=(await host.call('listGames'))
        assert len(imported)==1 and imported[0]['name']=='Hearts of Iron IV'
        assert imported[0]['source']=='manual',imported
        assert imported[0]['executable']==str(hoi_exe) and imported[0]['launch_uri']==''
        assert (data/'artwork'/imported[0]['cover']).exists()
        await page.get_by_role('button',name='My library').click()
        await page.locator('.game-card').first.click()
        await page.get_by_role('button',name='Remove',exact=True).click()
        await page.get_by_role('button',name='Remove game').click()
        assert hoi_exe.exists() and await host.call('listGames')==[]
        # Arbitrary game titles can search public artwork when the executable
        # name is unrecognizable. This must not require a store account.
        await page.get_by_role('button',name='Add game').first.click()
        await page.locator('#game-name').fill('Celeste')
        await page.get_by_role('button',name='Search',exact=True).click()
        await page.wait_for_function('document.querySelector("#game-cover")?.value.endsWith(".jpg")')
        assert 'Cover found on Steam' in await page.locator('#cover-search-status').inner_text()
        await page.get_by_role('button',name='Cancel').click()
        await page.get_by_role('button',name='Add game').first.click()
        await page.locator('#game-name').fill('Local Demo')
        await host.call('__dialog',[str(executable)])
        await page.get_by_role('button',name='Browse .exe').click()
        await page.wait_for_function('(path) => document.querySelector("#game-executable")?.value === path',arg=str(executable))
        await page.locator('#game-genre').fill('Adventure')
        await page.locator('#game-tags').fill('Story, Test')
        await page.locator('#game-args').fill('["--test", "two words"]')
        await page.get_by_role('button',name='Add to library').click()
        await page.get_by_text('Game added to your library.').wait_for()
        rows=await host.call('listGames')
        assert len(rows)==1 and rows[0]['tags']==['Story','Test']
        game_id=rows[0]['id']
        await page.get_by_role('button',name='My library').click()
        await page.locator('.game-card').first.click()
        await page.get_by_role('button',name='Favorite',exact=True).click()
        assert (await host.call('getGame',[game_id]))['favorite'] is True
        await page.get_by_role('button',name='Edit').click()
        await page.locator('#game-name').fill('Local Demo Edited')
        await host.call('__dialog',[str(cover_picture)])
        await page.get_by_role('button',name='Choose').first.click()
        await page.wait_for_function("document.querySelector('#game-cover')?.value.endsWith('.png')")
        cover_name=await page.locator('#game-cover').input_value()
        assert cover_name.endswith('.png')
        await page.get_by_role('button',name='Save changes').click()
        assert (await host.call('getGame',[game_id]))['name']=='Local Demo Edited'
        # Real local process invocation, with discrete arguments and tracked exit.
        await page.locator('#global-search').fill('Local Demo Edited')
        await page.wait_for_timeout(150)
        await page.locator('.cover-play').first.click()
        await page.get_by_text('Game launched.').wait_for()
        await page.wait_for_timeout(1350)
        assert log_file.exists(), 'game launch failed to write log'
        assert log_file.read_text().splitlines()==[str(game_dir),'--test','two words']
        saved=await host.call('getGame',[game_id])
        assert saved['last_played_at'] is not None
        assert saved['total_play_seconds']>=1
        # Simulate rapid double-clicks at the IPC handler boundary while the
        # first launch is still pending. Exactly one game process may start.
        simultaneous=await host.call('__parallelLaunch',[game_id])
        assert sum(entry['ok'] for entry in simultaneous)==1,simultaneous
        assert any('already launching or has a tracked session running' in entry.get('error','') for entry in simultaneous),simultaneous
        await asyncio.sleep(1.3)
        # Settings, fixture discovery, filtering and real SQLite import.
        await page.get_by_role('button',name='Settings').click()
        await page.locator('#theme-select').select_option('light')
        await page.get_by_role('button',name='Set accent color #53c5b3').click()
        await host.call('__dialog',[str(base/'Local games')])
        await page.get_by_role('button',name='Add folder').click()
        for attempt in range(30):
            if str(base/'Local games') in (await host.call('bootstrap'))['settings']['libraryFolders']: break
            await asyncio.sleep(.08)
        else: raise AssertionError('Folder selection was not saved in database')
        await page.get_by_role('button',name='Scan now').click()
        await page.get_by_text('GOG Fixture',exact=True).wait_for()
        await page.get_by_role('button',name=re.compile(r'Import \d+ game')).click()
        await page.get_by_text(re.compile('Imported .* game')).wait_for()
        games=await host.call('listGames')
        assert any(g['name']=='Steam Fixture' for g in games),[g['name'] for g in games]
        assert any(g['name']=='GOG Fixture' for g in games)
        assert len({g['executable'] for g in games if g['executable']})==len([g for g in games if g['executable']])
        await page.get_by_role('button',name='My library').click()
        await page.screenshot(path=str(ROOT/'stage3-library-integration.png'))
        await page.get_by_role('button',name='Settings').click()
        assert await page.locator('#toast-root .toast').count()<=3
        await page.screenshot(path=str(ROOT/'stage3-settings-integration.png'))
        await page.get_by_text('Library backup').scroll_into_view_if_needed()
        await page.screenshot(path=str(ROOT/'improved-settings-backup.png'))
        # Back up the actual database; confirm restore does not duplicate entries.
        export_file=base/'library.json'
        await host.call('__dialog',[str(export_file)])
        await page.get_by_role('button',name='Export',exact=True).click()
        await page.get_by_text('Metadata-only JSON backup exported.').wait_for()
        assert export_file.exists()
        backup=json.loads(export_file.read_text())
        assert backup['games'] and backup['settings']['theme']=='light'
        await host.call('__dialog',[str(export_file)])
        await page.get_by_role('button',name='Restore',exact=True).click()
        await page.get_by_text(re.compile(r'Restored \d+ games; skipped')).wait_for()
        assert len(await host.call('listGames'))==len(games)
        # Native handler roundtrip with the new portable compressed format.
        portable_file=base/'library.orbit'
        await host.call('__dialog',[str(portable_file)])
        await page.get_by_role('button',name='Export',exact=True).click()
        await page.get_by_text('Portable library backup exported.').wait_for()
        assert portable_file.read_bytes()[:2]==b'\x1f\x8b'
        await host.call('__dialog',[str(portable_file)])
        await page.get_by_role('button',name='Restore',exact=True).click()
        await page.get_by_text(re.compile(r'Restored \d+ games; skipped')).wait_for()
        assert len(await host.call('listGames'))==len(games)
        # Error path: bad binary and friendly toast, no process spawned.
        await page.get_by_role('button',name='My library').click()
        await page.get_by_role('button',name='Add game').first.click()
        await page.locator('#game-name').fill('Missing Drive Game')
        await page.locator('#game-executable').fill(str(base/'unplugged'/'missing.sh'))
        await page.get_by_role('button',name='Add to library').click()
        await page.get_by_text('Game added to your library.').wait_for()
        await page.locator('#global-search').fill('Missing Drive Game')
        await page.wait_for_timeout(180)
        await page.locator('.cover-play').first.click()
        await page.get_by_text(re.compile('executable was not found')).wait_for()
        # Removal deletes database entry only; executable remains on disk.
        await page.locator('#global-search').fill('Local Demo Edited')
        await page.wait_for_timeout(180)
        await page.locator('.game-card').first.click()
        await page.get_by_role('button',name='Remove',exact=True).click()
        await page.get_by_role('button',name='Remove game').click()
        assert await host.call('getGame',[game_id]) is None
        assert executable.exists()
        # Allow pending IPC events to settle before disposing the renderer.
        await page.wait_for_timeout(150)
        # Restart renderer, read live database and preferences again.
        await page.close()
        page,restarted_errors=await add_page(browser,host,html,css,width=910,height=610)
        errors.extend(restarted_errors)
        await page.get_by_role('button',name='Settings').click()
        assert await page.locator('#theme-select').input_value()=='light'
        assert await page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')
        assert not errors,errors
        print('Workflow integration PASS: real main-process IPC, SQLite, executable picker, add/edit/favorite, launch + arguments + playtime, Steam/GOG scan/import, theme/settings, backup restore, missing-drive error, removal, renderer reload, minimum-size layout')
      finally:
        if not page.is_closed():
          await page.wait_for_timeout(150)
          await page.close()
        await browser.close()
    await host.close()
    assert process.returncode==0,(await process.stderr.read()).decode()
    # Confirm persistence across a fresh backend process, not only UI refresh.
    restarted=await asyncio.create_subprocess_exec('node',str(ROOT/'tests/electron-stub-host.cjs'),
        env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
    second=NodeHost(restarted)
    await asyncio.wait_for(second.ready.wait(),10)
    snapshot=await second.call('bootstrap')
    assert snapshot['settings']['theme']=='light' and snapshot['settings']['accent']=='#53c5b3'
    assert any(g['name']=='Steam Fixture' for g in snapshot['games'])
    assert all(g['name']!='Local Demo Edited' for g in snapshot['games'])
    await second.close()
    assert restarted.returncode==0,(await restarted.stderr.read()).decode()
    print('Main process restart PASS: saved game library, deletion and appearance preferences persisted')
    # Restore the portable archive into a different, completely empty profile.
    # The source game was subsequently removed, so its artwork must come from
    # the archive itself, not the current machine's original artwork folder.
    migrated_data=base/'clean-machine-profile'
    migrated_env={**env,'ORBIT_E2E_DATA':str(migrated_data)}
    migrated=await asyncio.create_subprocess_exec('node',str(ROOT/'tests/electron-stub-host.cjs'),
        env=migrated_env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
    clean=NodeHost(migrated)
    await asyncio.wait_for(clean.ready.wait(),10)
    await clean.call('__dialog',[str(portable_file)])
    restored=await clean.call('restoreLibrary')
    assert restored['imported']==len(games) and not restored['errors'],restored
    migrated_games=await clean.call('listGames')
    transferred=next(g for g in migrated_games if g['name']=='Local Demo Edited')
    assert transferred['cover'].endswith('.png')
    assert (migrated_data/'artwork'/transferred['cover']).read_bytes()==cover_picture.read_bytes()
    await clean.close()
    assert migrated.returncode==0,(await migrated.stderr.read()).decode()
    print('Portable backup migration PASS: restored actual game metadata and embedded artwork into an empty profile')

if __name__ == '__main__':
    asyncio.run(run())

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {LibraryDatabase} = require('../src/core/database.cjs');

test('session history corrects a single completed session and preserves timestamps and legacy playtime', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-history-'));
  const db = new LibraryDatabase(path.join(temp, 'library.sqlite'));
  try {
    const game = db.upsert({name:'History', source:'manual', executable:process.execPath}).game;
    const start = '2026-11-10T18:00:00Z';
    const finish = '2026-11-10T18:05:00Z';
    db.db.prepare('INSERT INTO sessions (id,game_id,started_at,finished_at,seconds) VALUES (?,?,?,?,?)').run('saved-session',game.id,start,finish,137);
    db.db.prepare('UPDATE games SET total_play_seconds=? WHERE id=?').run(437,game.id);
    const active = db.startSession(game.id);
    assert.deepEqual(db.listSessions(game.id,0),{
      rows:[{id:'saved-session',started_at:start,finished_at:finish,seconds:137}], hasMore:false
    });
    assert.throws(()=>db.correctSession(game.id,active,30),/completed session/i);
    assert.throws(()=>db.correctSession(game.id,'saved-session',301),/duration/i);
    assert.throws(()=>db.correctSession(game.id,'saved-session',1.5),/duration/i);
    assert.equal(db.correctSession(game.id,'saved-session',80).total_play_seconds,380);
    assert.equal(db.correctSession(game.id,'saved-session',80).total_play_seconds,380);
    assert.equal(db.finishSession(active,0),true);
    const backup = db.exportBackup();
    assert.deepEqual({...backup.sessions.find(row=>row.id==='saved-session')},{id:'saved-session',game_id:game.id,started_at:start,finished_at:finish,seconds:80});
  } finally {
    db.close();
    fs.rmSync(temp,{recursive:true,force:true});
  }
});

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/ui/controller-mode.js'), 'utf8');

function fixture() {
  const events = [];
  const snapshot = {games:[{id:'game-5'}], runningIds:[], pendingLaunches:new Set()};
  const main = {scrollTop:242};
  const recent = {scrollLeft:97};
  const window = {OrbitControllerInput:{GamepadInput:class {}}};
  const document = {hidden:false, hasFocus:()=>true};
  vm.runInNewContext(source, {window, document, requestAnimationFrame:()=>1});
  const controller = window.OrbitControllerMode.create({
    api:{saveControllerReturn:async position=>events.push(['save', position])},
    snapshot:()=>snapshot,
    launch:async id=>{events.push(['launch', id]);return {tracked:true};},
  });
  controller.root = {querySelector:selector=>selector==='.tv-main'?main:recent};
  controller.active = true;
  controller.session = {previous:false};
  controller.filter = 'favorites';
  controller.page = 2;
  controller.snapshot = snapshot;
  controller.render = options=>events.push(['render', options.focusKey, options.restoreGameId]);
  return {controller, snapshot, main, recent, events, document};
}

test('a confirmed launch restores its library card, filter and scrolling when play ends', async () => {
  const {controller, snapshot, main, recent, events, document} = fixture();
  await controller.act('open', {dataset:{tvKey:'library:game-5', tvGame:'game-5'}});
  await controller.act('launch', {dataset:{tvGame:'game-5'}});
  const saved = events.find(([event])=>event==='save')[1];
  assert.equal(saved.focusKey, 'library:game-5');
  assert.equal(saved.scrollTop, 242);
  assert.equal(saved.recentScrollLeft, 97);
  assert(events.findIndex(([event])=>event==='save') < events.findIndex(([event])=>event==='launch'));

  document.hidden = true;
  snapshot.runningIds = ['game-5'];
  controller.update();
  snapshot.runningIds = [];
  controller.update();
  assert.equal(controller.detailId, 'game-5', 'wait for the player to return');
  main.scrollTop = 0;
  recent.scrollLeft = 0;
  document.hidden = false;
  controller.update();
  assert.equal(controller.detailId, null);
  assert.equal(controller.filter, 'favorites');
  assert.equal(controller.page, 2);
  assert.equal(main.scrollTop, 242);
  assert.equal(recent.scrollLeft, 97);
  await controller.returnWrites;
  assert.deepEqual(events.at(-2), ['render', 'library:game-5', 'game-5']);
  assert.deepEqual(events.at(-1), ['save', null]);
});

test('failure clears the checkpoint and leaves the controller on the detail view', async () => {
  const {controller, events} = fixture();
  controller.options.launch = async()=>undefined;
  await controller.act('open', {dataset:{tvKey:'recent:game-5', tvGame:'game-5'}});
  await controller.act('launch', {dataset:{tvGame:'game-5'}});
  assert.equal(controller.detailId, 'game-5');
  await controller.returnWrites;
  assert.deepEqual(events.at(-1), ['save', null]);
});

test('an external handoff keeps the checkpoint only while confirmation is pending', async () => {
  const {controller, snapshot, events} = fixture();
  controller.options.launch = async id=>{
    snapshot.pendingLaunches.add(id);
    return {confirmationTimeoutMs:90000};
  };
  await controller.act('open', {dataset:{tvKey:'recent:game-5', tvGame:'game-5'}});
  await controller.act('launch', {dataset:{tvGame:'game-5'}});
  assert.equal(events.filter(([type])=>type==='save').length, 1);
  snapshot.pendingLaunches.clear();
  controller.update();
  await controller.returnWrites;
  assert.equal(controller.detailId, 'game-5');
  assert.deepEqual(events.at(-1), ['save', null]);
});

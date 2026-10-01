'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('timeline camera controls: quiet defaults, shared camera, safe keys, persistence and mobile', { timeout: 90000 }, async t => {
  const { evaluate: ev, until, command, size, screenshot, exceptions } = await viewerBrowser(t);
  await until(`homeTimeline?.state.width > 0 && !$('helpOverlay').checkVisibility() && !document.querySelector('dialog[open]')`);
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const key = (key, extra = {}) => ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, bubbles: true, cancelable: true, ...extra })}))`);
  const cameraAt = scale => until(`Math.abs(homeTimeline.state.scale / PX_DAY_BASE - ${scale}) < 0.000001`, async () => `scale ${scale}: ` + JSON.stringify(await ev(`({camera:homeTimeline.state,zoom:ganttZoom,panel:$('timelineControlPanel').matches(':popover-open')})`)));
  assert.equal(await ev(`$('timelineControls').checkVisibility()`), true);
  assert.equal(await ev(`document.querySelector('.tc-inline').children.length`), 0);
  assert.equal(await ev(`(()=>{const b=document.querySelector('#timelineControls [data-action=help]'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`), true, 'Files toggle cannot cover the shortcut button');
  assert.equal(await ev(`$('timelineControlPanel').matches(':popover-open')`), false);
  await click('.tc-scale');
  assert.equal(await ev(`document.querySelector('.tc-scale').getAttribute('aria-expanded')`), 'true');
  await click('#timelineControlPanel [data-action=days]');
  await cameraAt(1);
  await ev(`window.cameraJumps=0; window.originalJump=homeTimeline.jump.bind(homeTimeline); homeTimeline.jump=(...args)=>{cameraJumps++;return originalJump(...args)}`);
  await click('#timelineControlPanel [data-action=hours]');
  await cameraAt(6);
  assert.equal(await ev(`cameraJumps`), 0, 'preset changes use camera zoom, never jump to now');
  assert.equal(await ev(`document.querySelector('.tc-scale').textContent`), 'Hours ▾');
  await click('#timelineControlPanel [data-action=out]');
  await cameraAt(6 / 1.4);
  assert.equal(await ev(`document.querySelector('.tc-scale').textContent`), 'Custom ▾');
  assert.equal(await ev(`document.querySelectorAll('.tc-camera [aria-pressed=true]').length`), 0);

  await click('[data-pin=controls]');
  assert.equal(await ev(`document.querySelector('.tc-inline .tc-camera') !== null`), true);
  await key('Escape');
  assert.equal(await ev(`document.activeElement.classList.contains('tc-scale')`), true, 'Escape returns focus');
  // Space remains native button activation rather than toggling a selected conversation.
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await until(`$('timelineControlPanel').matches(':popover-open')`);
  await key('Escape');
  await ev(`$('list').focus()`);
  await key('W', { shiftKey: true });
  await cameraAt(0.15);
  await key('t');
  assert.equal(await ev(`document.activeElement.type`), 'date');
  await ev(`document.activeElement.value='2026-09-01'; document.activeElement.dispatchEvent(new Event('change',{bubbles:true})); window.dateScale=homeTimeline.state.scale`);
  await key('D', { shiftKey: true });
  assert.equal(await ev(`homeTimeline.state.scale === dateScale`), true, 'date entry keeps its keystrokes');
  await key('Escape');
  await ev(`$('list').focus()`);
  await key('D', { shiftKey: true, ctrlKey: true });
  assert.equal(await ev(`homeTimeline.state.scale === dateScale`), true, 'browser modifiers keep their meaning');
  await key('D', { shiftKey: true });
  await cameraAt(1);

  await key('?');
  assert.equal(await ev(`document.querySelector('.tc-guide').checkVisibility() && $('helpOverlay').hidden`), true, 'chart-only help');
  await click('[data-pin=guide]');
  await ev(`$('list').focus(); $('list').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  assert.equal(await ev(`$('timelineControlPanel').matches(':popover-open')`), true, 'pinned guide stays while using the chart');
  await screenshot('timeline-controls-desktop.png');
  // Reload without a navigation shortcut: both preferences survive locally.
  await ev(`window.beforeControlsReload = true`);
  await command('Page.reload', {});
  await until(`!window.beforeControlsReload && homeTimeline?.state.width > 0 && document.querySelector('.tc-inline .tc-camera') && $('timelineControlPanel').matches(':popover-open')`);
  await ev(`open('pi:fixture/media.jsonl')`);
  await until(`viewKind === 'conversation'`);
  assert.equal(await ev(`$('timelineControlPanel').matches(':popover-open')`), false, 'guide leaves with its chart');
  await ev(`goHome()`);
  await until(`viewKind === 'home' && $('timelineControlPanel').matches(':popover-open')`);
  await click('.tc-close');
  assert.equal(await ev(`localStorage.getItem('chattering.timeline.guide')`), '0');

  for (const theme of ['light', 'dark', 'eink']) {
    await ev(`selectTheme(${JSON.stringify(theme)})`);
    await click('.tc-scale');
    assert.equal(await ev(`getComputedStyle($('timelineControlPanel')).color !== getComputedStyle($('timelineControlPanel')).backgroundColor`), true, theme + ' legible');
    await screenshot('timeline-controls-' + theme + '.png');
    await click('.tc-close');
  }
  await ev(`selectTheme('light')`);
  for (const [width, height, mobile] of [[760, 800, false], [390, 844, true], [640, 360, true]]) {
    await size(width, height, mobile);
    // CDP's resize acknowledgement precedes the media-query change callback.
    // Wait for the pinned controls to reach the expected layout; keep every
    // narrow-screen visibility, overflow and navigation assertion below.
    await until(`innerWidth === ${width} && document.querySelector('.tc-inline').children.length === ${width <= 700 ? 0 : 1}`);
    await click('.tc-scale');
    assert.equal(await ev(`(()=>{const r=$('timelineControlPanel').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()`), true, 'popover fits ' + width);
    assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth`), true, 'no page overflow ' + width);
    if (width <= 700) {
      assert.equal(await ev(`document.querySelector('.tc-inline').children.length`), 0, 'narrow screens keep controls in the menu');
      assert.equal(await ev(`$('timelineControls').checkVisibility()`), true);
      assert.equal(await ev(`$('timelineControlPanel').getBoundingClientRect().bottom <= $('phoneBar').getBoundingClientRect().top`), true, 'popover leaves phone navigation accessible');
      assert.equal(await ev(`document.querySelector('#timelineControls [data-action=now]').getBoundingClientRect().height>=44`), true);
    }
    await screenshot('timeline-controls-' + width + '.png');
    await click('.tc-close');
  }
  // Exercise the shared camera independently of app data refreshes. Resizes
  // during motion include the height change when a scrollbar disappears.
  await ev(`window.cameraHost=document.createElement('div');cameraHost.style.cssText='position:fixed;left:-2000px;width:600px;height:200px;overflow:auto';document.body.append(cameraHost);
    window.resizeCamera=new TimelineChart({scroller:cameraHost,scale:160});
    resizeCamera.setData({start:0,end:100*DAY_MS,marks:[],height:100,gutter:0,rightPad:0},{center:50*DAY_MS})`);
  await until(`resizeCamera.state.width===600 && resizeCamera.state.left>0`);
  await ev(`window.anchorBefore=resizeCamera.state.center;resizeCamera.zoomTo(960,{animate:true,duration:300});setTimeout(()=>{cameraHost.style.width='500px';cameraHost.style.height='240px'},40)`);
  await until(`Math.abs(resizeCamera.state.scale-960)<0.000001`);
  assert.equal(await ev(`Math.abs(resizeCamera.state.center-anchorBefore)<1`), true, 'resizing preserves the requested zoom and time anchor');
  await ev(`resizeCamera.destroy();cameraHost.remove()`);
  assert.deepEqual(exceptions, []);
});

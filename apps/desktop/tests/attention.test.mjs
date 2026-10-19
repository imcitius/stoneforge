import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionMonitor } from '../dist/attention.js';

function fixture() {
  const projects = new Map(['one', 'two'].map(id => [id, {id, name:id, state:'ready'}]));
  const instances = new Map(['one', 'two'].map(id => [id, {instanceId:id, endpoint:`http://${id}.test`} ]));
  const notices = [];
  const manager = {projects, instances, isCurrent:async () => true, headers:() => ({}), setNeedsInput(id, value) { projects.get(id).needsInput=value; }};
  return { manager, notices, monitor:new AttentionMonitor(manager, n => notices.push(n)) };
}
const waiting = (id, request='request1') => ({id, agentId:id, agentRole:'director', status:'running', attention:{id:request,kind:'input',since:new Date(Date.now()-10_000).toISOString()}});

test('all projects signal once; response clears badges and replacement instances rearm notification', async () => {
  const f=fixture(), original=globalThis.fetch;
  let sessions=[waiting('director')];
  globalThis.fetch=async () => ({ok:true,json:async () => ({sessions})});
  try {
    await f.monitor.poll(); await f.monitor.poll();
    assert.equal(f.notices.length,2);
    assert.equal(f.manager.projects.get('two').needsInput,true);
    sessions=[]; await f.monitor.poll();
    assert.equal(f.manager.projects.get('two').needsInput,false);
    sessions=[waiting('director','request2')]; await f.monitor.poll();
    assert.equal(f.notices.length,4);
  } finally { globalThis.fetch=original; }
});

test('in-flight responses cannot notify after stop or instance replacement', async () => {
  const f=fixture(), original=globalThis.fetch;
  let release; const gate=new Promise(resolve=>{release=resolve;});
  globalThis.fetch=async () => { await gate; return {ok:true,json:async()=>({sessions:[waiting('director')]})}; };
  try {
    const pending=f.monitor.poll();
    await new Promise(resolve=>setImmediate(resolve));
    f.manager.projects.get('one').state='stopping';
    f.manager.instances.set('two',{instanceId:'new',endpoint:'http://two.test'});
    release(); await pending;
    assert.equal(f.notices.length,0);
  } finally { globalThis.fetch=original; }
});

test('workers, stopped sessions and fresh signals cannot send immediate notifications', async () => {
  const f=fixture(), original=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,json:async()=>({sessions:[{...waiting('worker'),agentRole:'worker'},{...waiting('stopped'),status:'terminated'}, {...waiting('new'),attention:{id:'new',kind:'input',since:new Date().toISOString()}}]})});
  try { await f.monitor.poll(); assert.equal(f.notices.length,0); } finally {globalThis.fetch=original;}
});

test('stop prevents a notification from an already pending request', async () => {
  const f=fixture(), original=globalThis.fetch;
  let release; const gate=new Promise(resolve=>{release=resolve;});
  globalThis.fetch=async()=>{await gate;return {ok:true,json:async()=>({sessions:[waiting('director')]})};};
  try {
    const pending=f.monitor.poll(); await new Promise(resolve=>setImmediate(resolve));
    f.monitor.stop(); release(); await pending;
    assert.equal(f.notices.length,0);
  } finally {globalThis.fetch=original;}
});


test('a second request stays pending during cooldown and notifies once when it expires', async () => {
  const f=fixture(), original=globalThis.fetch, originalNow=Date.now;
  let now=originalNow(), request='first';
  Date.now=()=>now;
  globalThis.fetch=async()=>({ok:true,json:async()=>({sessions:[waiting('director',request)]})});
  try {
    await f.monitor.poll(); assert.equal(f.notices.length,2);
    request='second'; now+=10_000;
    await f.monitor.poll(); assert.equal(f.notices.length,2);
    assert.equal(f.manager.projects.get('one').needsInput,true);
    now+=50_000;
    await f.monitor.poll(); await f.monitor.poll();
    assert.equal(f.notices.length,4);
    assert.equal(f.notices.at(-1).attentionId,'second');
  } finally { globalThis.fetch=original; Date.now=originalNow; }
});

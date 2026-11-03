/** Verify packaged interactive providers with real PTYs, without model/API calls. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// process.execPath is a real path; DESKTOP_APP may go through a symlink (/tmp -> /private/tmp).
const app=realpathSync(resolve(process.env.DESKTOP_APP));
const resources=join(app,'Contents/Resources');
assert.equal(process.execPath,join(resources,'runtime/node'),'Run with the candidate bundled Node');
const temp=mkdtempSync(join(tmpdir(),'stoneforge-packaged-color-'));
const original=process.env.NO_COLOR;
const results=[];
try {
  const profile=join(temp,'profile'), executable=join(temp,'fake-provider');
  writeFileSync(profile,'export NO_COLOR=1 TERM=dumb COLORTERM=\n');
  writeFileSync(executable,'#!/bin/sh\nif [ -z "${NO_COLOR+x}" ] && [ "$TERM" = xterm-256color ] && [ "$COLORTERM" = truecolor ]; then\n printf "\\033[32mЦвет готов\\033[0m\\n"\nelse\n printf "MONOCHROME\\n"; exit 1\nfi\n',{mode:0o755});
  process.env.NO_COLOR='1';
  for(const [name,className] of [['claude','ClaudeInteractiveProvider'],['codex','CodexInteractiveProvider']]) {
    const Provider=(await import(pathToFileURL(join(resources,'backend/dist/providers',name,'interactive.js')).href))[className];
    for(const resume of [false,true]) {
      const session=await new Provider(executable).spawn({workingDirectory:temp,initialPrompt:'Проверь цвет',environmentVariables:{BASH_ENV:profile,TERM:'dumb',COLORTERM:'',LC_CTYPE:'en_US.UTF-8'},...(resume?{resumeSessionId:'12345678-1234-1234-1234-123456789abc'}:{})});
      try {
        const output=await new Promise((resolve,reject)=>{
          let text='';
          const timer=setTimeout(()=>reject(new Error('PTY did not exit')),5000);
          session.onData(data=>{text+=data;});
          session.onExit(code=>{clearTimeout(timer);if(code)reject(new Error(name+' exited '+code+': '+text));else resolve(text);});
        });
        assert(output.includes('\x1b[32mЦвет готов\x1b[0m'));
        results.push({provider:name,resume,colorAndUnicode:true});
      } finally {try{session.kill();}catch{}}
    }
  }
  assert.equal(process.env.NO_COLOR,'1');
  console.log(JSON.stringify({app,build:JSON.parse(readFileSync(join(resources,'app/build-info.json'),'utf8')),results},null,2));
} finally {
  if(original===undefined)delete process.env.NO_COLOR;else process.env.NO_COLOR=original;
  rmSync(temp,{recursive:true,force:true});
}

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import * as acorn from 'acorn';
import {curveValue, mappedSourceTime, mapAnchors} from '../web/common.js';
const root = fileURLToPath(new URL('../',import.meta.url));
function files(folder) {
  return fs.readdirSync(folder,{withFileTypes:true}).flatMap(entry=>{
    if(entry.name.startsWith('.')||['node_modules','__pycache__','workspace'].includes(entry.name))return [];
    const value=path.join(folder,entry.name);
    return entry.isDirectory()?files(value):[value];
  });
}
let checked=0;
for(const file of files(root)) {
  if(!/\.(js|mjs|py|ps1|css)$/.test(file))continue;
  const source=fs.readFileSync(file,'utf8');
  assert(source.split('\n').length<=500,`${file} exceeds 500 lines`);
  assert(!/[\u4e00-\u9fff]/u.test(source),`${file} has untranslated Chinese text`);
  if(/\.(js|mjs)$/.test(file))acorn.parse(source,{ecmaVersion:'latest',sourceType:'module'});
  checked++;
}
const points=[{source_time:0,delta_semitones:0},{source_time:1,delta_semitones:2},{source_time:2,delta_semitones:0}];
assert.equal(curveValue(points,-1),0);
assert.equal(curveValue(points,1),2);
assert.equal(curveValue(points,3),0);
assert.equal(curveValue(points,.5),1.5);
for(let t=0;t<=2;t+=.01)assert(curveValue(points,t)>=0&&curveValue(points,t)<=2);
assert.equal(mappedSourceTime(2,[[0,1],[1,2],[2,1]]),3);
assert.equal(mapAnchors([[0,0],[1,1.5],[2,3]],.5),.75);
assert.equal(mapAnchors([[0,0],[1,1.5],[2,3]],.75,true),.5);
console.log(`Checked ${checked} source files and pitch/time interpolation contracts.`);

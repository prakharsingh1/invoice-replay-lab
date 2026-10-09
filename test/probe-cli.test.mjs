import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const record = JSON.parse(readFileSync(new URL('../artifacts/paypal-sandbox-evidence.public.json', import.meta.url)));
function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'replay-probe-cli-'));
  for (const name of ['src','scripts','artifacts','.git']) mkdirSync(join(root, name));
  cpSync(new URL('../src/paypal.mjs', import.meta.url), join(root,'src/paypal.mjs'));
  cpSync(new URL('../scripts/sandbox-probe.mjs', import.meta.url), join(root,'scripts/sandbox-probe.mjs'));
  writeFileSync(join(root,'artifacts/paypal-sandbox-evidence.public.json'),JSON.stringify(record));
  writeFileSync(join(root,'network-forbidden.mjs'), "globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };\n");
  return root;
}
function run(root, args=[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PAYPAL_')));
  return spawnSync(process.execPath, ['--import',join(root,'network-forbidden.mjs'),join(root,'scripts/sandbox-probe.mjs'),...args], {env,encoding:'utf8',timeout:5000});
}
test('judge clone reads public observed evidence without credentials or network',()=>{
 const root=checkout(); try {const result=run(root); assert.equal(result.status,0); const value=JSON.parse(result.stdout); assert.equal(value.recorded,true);assert.equal(value.reused,true);assert.equal(value.requestsMadeByThisRun,0);assert.equal(value.observedAt,record.at);}finally{rmSync(root,{recursive:true,force:true});}
});
test('explicit create cannot repeat a checkout with previous authorized attempt',()=>{
 const root=checkout();try{writeFileSync(join(root,'.git/paypal-sandbox-authorized-attempt.json'),'{}'); const result=run(root,['--create-new-draft']); assert.equal(result.status,2);assert.match(result.stderr,/PRIOR_PROBE_ATTEMPT/);assert.doesNotMatch(result.stderr,/NETWORK_FORBIDDEN/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('invalid private evidence fails closed instead of using public fallback',()=>{
 const root=checkout();try{writeFileSync(join(root,'artifacts/paypal-sandbox-probe.json'),'{"executed":true}');const result=run(root);assert.equal(result.status,2);assert.match(result.stderr,/INVALID_RECORDED_EVIDENCE/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('persistent failed attempt prevents a blind create retry',()=>{
 const root=checkout();try{writeFileSync(join(root,'artifacts/probe-attempt.private.json'),'{"status":"failed-stop"}');const result=run(root,['--create-new-draft']);assert.equal(result.status,2);assert.match(result.stderr,/PRIOR_PROBE_ATTEMPT/);}finally{rmSync(root,{recursive:true,force:true});}
});

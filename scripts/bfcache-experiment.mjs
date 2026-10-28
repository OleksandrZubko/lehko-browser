// Controlled local BFCache experiment; never attaches to a personal browser/profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright';

const run=process.argv[2], mode=process.argv[3] ?? 'default';
if(!/^\d+$/.test(run ?? '') || !['default','two','four','off'].includes(mode)) throw Error('Usage: node scripts/bfcache-experiment.mjs <new numeric run> <default|two|four|off>');
const output=resolve('artifacts/bfcache');await mkdir(output,{recursive:true});
const resultPath=join(output,`result-${run}.json`);
if(await access(resultPath).then(()=>true,()=>false)) throw Error('Run already exists: '+run);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const payloadMiB=24, serverDelayMs=80, bootstrapMs=40;
const extraSettleMs=Number(process.env.BFCACHE_EXTRA_SETTLE_MS ?? 0);
if(!Number.isFinite(extraSettleMs)||extraSettleMs<0||extraSettleMs>60000)throw Error('Invalid extra settle duration');
const requests=[];
const fixture=index=>`<!doctype html><meta charset="utf-8"><title>History fixture ${index}</title>
<style>body{font:16px system-ui}li{height:24px}</style><body data-index="${index}">
<h1>History fixture ${index}</h1><input id="draft" aria-label="Draft"><ol id="rows"></ol>
<script>
globalThis.token=crypto.randomUUID();globalThis.logicalDraft=0;
globalThis.payload=new Uint8Array(${payloadMiB}*1024*1024).fill(${index}+10);
const until=performance.now()+${bootstrapMs};while(performance.now()<until){}
document.querySelector('#rows').innerHTML=Array.from({length:1000},(_,i)=>'<li>Document ${index}: row '+i+'</li>').join('');
globalThis.arrival={ready:false};
addEventListener('pagehide',()=>{arrival.ready=false});
addEventListener('pageshow',e=>{
 globalThis.arrival={ready:true,persisted:e.persisted,readyEpochMs:Date.now(),visibility:document.visibilityState};
});
globalThis.state=()=>({index:Number(document.body.dataset.index),token,logicalDraft,
 draft:document.querySelector('#draft').value,persisted:arrival.persisted,readyEpochMs:arrival.readyEpochMs,visibility:arrival.visibility,
 payloadBytes:payload.byteLength,payloadFirst:payload[0],payloadLast:payload[payload.length-1],
 notRestoredReasons:performance.getEntriesByType('navigation')[0]?.notRestoredReasons?.toJSON?.() ?? null});
</script>`;
const server=createServer(async(request,response)=>{
 const match=/^\/page\/(\d+)$/.exec(request.url);
 if(!match){response.writeHead(200,{'Content-Type':'text/html'});response.end('<!doctype html><title>Blank fixture</title>');return;}
 requests.push({index:Number(match[1]),time:Date.now()});
 await delay(serverDelayMs);
 response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});
 response.end(fixture(Number(match[1])));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const profile=await mkdtemp(join(tmpdir(),'lehko-bfcache-'));
const limit=mode==='two'?2:mode==='four'?4:null;
const flags=limit?[`--enable-features=BackForwardCacheSize:cache_size/${limit}/foreground_cache_size/${limit}`]:
 mode==='off'?['--disable-features=BackForwardCache']:[];
let child,browser,cdp;
const memory=[],visits=[],navigations=[],notUsed=[];
try {
 child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
  '--user-data-dir='+profile,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check',
  '--window-size=1100,850',...flags,'about:blank'],{stdio:'ignore'});
 let port;
 for(let i=0;i<150;i++){
  try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}
  catch{await delay(100);}
 }
 if(!port)throw Error('Isolated browser did not start');
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true});
 const context=browser.contexts()[0], page=context.pages()[0];
 cdp=await browser.newBrowserCDPSession();
 const version=await cdp.send('Browser.getVersion');
 const pageCdp=await context.newCDPSession(page);
 await pageCdp.send('Page.enable');
 pageCdp.on('Page.backForwardCacheNotUsed',event=>notUsed.push(event));
 async function waitReady(index){
  await page.waitForFunction(index=>Number(document.body?.dataset.index)===index && globalThis.arrival?.ready,index,{polling:10,timeout:20000});
  return page.evaluate(()=>state());
 }
 async function snapshot(name){
  let processInfo,data,path;
  const attempts=[];
  for(let attempt=1;attempt<=3;attempt++){
   ({processInfo}=await cdp.send('SystemInfo.getProcessInfo'));
   path=join(output,`footprint-${run}-${name}${attempt===1?'':'-attempt-'+attempt}.json`);
   execFileSync('/usr/bin/footprint',['--noCategories','--swapped','-j',path,...processInfo.flatMap(p=>['-p',String(p.id)])],{stdio:['ignore','ignore','pipe'],timeout:30000});
   data=JSON.parse(await readFile(path,'utf8'));
   const complete=data.processes.every(p=>typeof p.footprint==='number');
   attempts.push({path,errors:data.errors,complete});
   if(!data.errors.length && complete)break;
   await delay(250);
  }
  if(data.errors.length || !data.processes.every(p=>typeof p.footprint==='number'))throw Error('Incomplete footprint after retries: '+name);
  const renderers=new Set(processInfo.filter(p=>p.type==='renderer').map(p=>p.id));
  const value={name,footprintMiB:data['total footprint']/1048576,
   rendererFootprintMiB:data.processes.filter(p=>renderers.has(p.pid)).reduce((n,p)=>n+p.footprint/1048576,0),
   processInfo,errors:data.errors,attempts,systemSwap:execFileSync('/usr/sbin/sysctl',['-n','vm.swapusage'],{encoding:'utf8'}).trim()};
  memory.push(value);console.log(JSON.stringify({run,mode,phase:name,footprintMiB:value.footprintMiB,rendererMiB:value.rendererFootprintMiB}));
 }
 await snapshot('empty');
 for(let index=0;index<7;index++){
  await page.bringToFront();await page.goto(origin+'/page/'+index,{waitUntil:'load'});await waitReady(index);
  await page.locator('#draft').fill('Unsubmitted document '+index);
  await page.evaluate(index=>{logicalDraft=1000+index},index);
  visits.push(await page.evaluate(()=>state()));
  if(index===0){await delay(1000);await snapshot('one-document');}
 }
 await delay(3000);await snapshot('history-seven');
 if(extraSettleMs){await delay(extraSettleMs);await snapshot('history-settled');}
 const history=await pageCdp.send('Page.getNavigationHistory');
 const ids=new Map(history.entries.filter(e=>e.url.startsWith(origin+'/page/')).map(e=>[Number(e.url.split('/').at(-1)),e.id]));
 const latestStates=new Map(visits.map(state=>[state.index,state]));
 assert.equal(ids.size,7);
 async function traverse(index,pattern){
  await page.bringToFront();
  const currentState=await page.evaluate(()=>state());
  latestStates.set(currentState.index,currentState);
  const expected=latestStates.get(index);
  const beforeRequests=requests.length, beforeEvents=notUsed.length, started=Date.now();
  await pageCdp.send('Page.navigateToHistoryEntry',{entryId:ids.get(index)});
  let state;
  try {state=await waitReady(index);} catch(error){
   const debug=await pageCdp.send('Runtime.evaluate',{expression:'JSON.stringify({url:location.href,index:document.body?.dataset.index,arrival:globalThis.arrival,visibility:document.visibilityState})',returnByValue:true,timeout:2000}).catch(e=>({error:String(e)}));
   await writeFile(join(output,`failure-${run}.json`),JSON.stringify({run,mode,index,pattern,navigations,debug,notUsed},null,2));
   console.log(JSON.stringify({run,failure:debug}));throw error;
  }
  const row={pattern,index,persisted:state.persisted,
   commandToPageShowMs:state.readyEpochMs-started,driverObservedMs:Date.now()-started,visibility:state.visibility,
   sameToken:state.token===visits[index].token,
   logicalDraftPreserved:state.logicalDraft===visits[index].logicalDraft,
   htmlDraftPreserved:state.draft===visits[index].draft,
   latestTokenPreserved:state.token===expected.token,
   latestLogicalDraftPreserved:state.logicalDraft===expected.logicalDraft,
   requests:requests.length-beforeRequests,
   notRestoredReasons:state.notRestoredReasons,
   protocolReasons:notUsed.slice(beforeEvents).map(e=>e.notRestoredExplanations)};
  assert.equal(state.payloadBytes,payloadMiB*1024*1024);assert.equal(state.payloadFirst,index+10);assert.equal(state.payloadLast,index+10);
  assert.ok(row.commandToPageShowMs>=0 && row.commandToPageShowMs<20000);
  // A document may reload on a miss and later be cached again. A hit must
  // preserve that latest incarnation, not necessarily the first-ever visit.
  if(row.persisted){assert.ok(row.latestTokenPreserved);assert.ok(row.latestLogicalDraftPreserved);assert.equal(state.draft,expected.draft);assert.equal(row.requests,0);}
  if(mode==='off')assert.equal(row.persisted,false);
  navigations.push(row);
  latestStates.set(index,state);
 }
 // Frequent one-step return is the main responsiveness gate: 12 Back/Forward pairs.
 for(let i=0;i<12;i++){await traverse(5,'near');await traverse(6,'near');}
 // Direct jump to an older entry, then sequential traversal of older history.
 await traverse(2,'deep');await traverse(6,'deep');
 for(let index=5;index>=0;index--)await traverse(index,'walk-back');
 await snapshot('after-history-use');
 await writeFile(resultPath,JSON.stringify({run,mode,flags,version,
  fixture:{payloadMiB,documents:7,serverDelayMs,bootstrapMs,rowsPerPage:1000,extraSettleMs},
  memory,visits,navigations,notUsed,requests,
  conditions:'Fresh headed profile, normal sandbox/GPU defaults, no Playwright focus or background overrides',
  limitations:['Synthetic local workload, not personal tabs','Server delay and bootstrap work are simulated','PageShow timing includes command dispatch, excludes subsequent paint; not a perceptual study','Footprint includes compressed/swapped accounting; not resident RAM only','Memory deltas include process/cache/GC changes, not only BFCache']},null,2));
 console.log(JSON.stringify({run,mode,nearHits:navigations.filter(n=>n.pattern==='near'&&n.persisted).length,
  deep:navigations.filter(n=>n.pattern==='deep').map(n=>({index:n.index,hit:n.persisted,ms:n.commandToPageShowMs})),
  walkHits:navigations.filter(n=>n.pattern==='walk-back'&&n.persisted).length,checks:'passed'}));
}catch(error){
 await writeFile(join(output,`failure-${run}.json`),JSON.stringify({run,mode,error:String(error),memory,navigations,notUsed,requests},null,2));
 throw error;
}finally{
 await cdp?.send('Browser.close').catch(()=>{});await browser?.close().catch(()=>{});
 if(child && child.exitCode===null){await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(3000)]);if(child.exitCode===null)child.kill('SIGTERM');}
 await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true});
}

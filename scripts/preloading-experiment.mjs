// Local, isolated Chrome experiment. Never reads or changes personal profiles.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { connectCDP } from './lib/raw-cdp.mjs';

const [run,action='prefetch',mode='on']=process.argv.slice(2);
const headless=process.env.PRELOAD_HEADLESS==='1';
if(!/^\d+$/.test(run??'')||!['prefetch','prerender'].includes(action)||!['on','off'].includes(mode))throw Error('Usage: node scripts/preloading-experiment.mjs <new run> <prefetch|prerender> <on|off>');
const output=resolve('artifacts/preloading');await mkdir(output,{recursive:true});
const resultPath=join(output,`result-${run}.json`);
if(await access(resultPath).then(()=>true,()=>false))throw Error('Run exists');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profile=await mkdtemp(join(tmpdir(),'lehko-preloading-'));
await mkdir(join(profile,'Default'),{recursive:true});
const preference=mode==='on'?0:2;
await writeFile(join(profile,'Default','Preferences'),JSON.stringify({net:{network_prediction_options:preference}}));
const requests=[],events=[],memory=[],cpu=[];
const payloadMiB=24, appWorkMs=200;
const data=Buffer.alloc(3*1024*1024,71);
const source=`<!doctype html><meta charset="utf-8"><title>Preloading fixture: source</title><h1>Read this page</h1><input id="draft"><a id="target" href="/target">Open document</a><script>globalThis.sourceToken=crypto.randomUUID()</script>`;
const target=`<!doctype html><meta charset="utf-8"><title>Preloading fixture: destination</title><h1>Document</h1><div id="content"></div><script src="/bootstrap.js"></script>`;
const bootstrap=`globalThis.startedPrerendering=document.prerendering;globalThis.appReady=false;
function markReady(){if(appReady&&!document.prerendering)globalThis.visibleReady={epochMs:Date.now(),startedPrerendering,activationStart:performance.getEntriesByType('navigation')[0]?.activationStart??0,visibility:document.visibilityState,payloadBytes:payload.length,first:payload[0],last:payload[payload.length-1]}}
document.addEventListener('prerenderingchange',markReady);addEventListener('pageshow',markReady);
(async()=>{globalThis.download=await(await fetch('/data.bin')).arrayBuffer();
 globalThis.payload=new Uint8Array(${payloadMiB}*1024*1024).fill(83);
 const until=performance.now()+${appWorkMs};while(performance.now()<until){}
 document.querySelector('#content').innerHTML=Array.from({length:1000},(_,i)=>'<p>Document row '+i+'</p>').join('');
 appReady=true;markReady();})().catch(e=>globalThis.appError=String(e));`;
const server=createServer(async(req,res)=>{
 const entry={path:req.url,atMs:Date.now(),purpose:req.headers['sec-purpose']??'',bytes:0};requests.push(entry);
 if(req.url==='/source'){res.setHeader('Content-Type','text/html; charset=utf-8');entry.bytes=Buffer.byteLength(source);res.end(source);return;}
 if(req.url==='/target'){await delay(150);res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','max-age=3600');entry.bytes=Buffer.byteLength(target);res.end(target);return;}
 if(req.url==='/bootstrap.js'){await delay(90);res.setHeader('Content-Type','text/javascript');res.setHeader('Cache-Control','max-age=3600');entry.bytes=Buffer.byteLength(bootstrap);res.end(bootstrap);return;}
 if(req.url==='/data.bin'){await delay(120);res.setHeader('Content-Type','application/octet-stream');res.setHeader('Cache-Control','max-age=3600');entry.bytes=data.length;res.end(data);return;}
 res.writeHead(204);res.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let child,cdp,result;
const benchmarkFlags=['--disable-component-update','--disable-default-apps','--disable-extensions','--disable-component-extensions-with-background-pages'];
if(headless)benchmarkFlags.push('--headless=new');
try{
 child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
  '--user-data-dir='+profile,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--window-size=1100,850',...benchmarkFlags,'about:blank'],{stdio:'ignore'});
 let port,endpointPath;
 for(let i=0;i<150;i++){try{[port,endpointPath]=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n');port=Number(port);break;}catch{await delay(100);}}
 if(!port)throw Error('Isolated Chrome did not start');
 cdp=await connectCDP(`ws://127.0.0.1:${port}${endpointPath}`);
 const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false},{exclude:true}]});
 const initialTab=targetInfos.find(t=>t.type==='tab'&&t.url==='about:blank');
 assert.ok(initialTab,'Missing isolated initial tab target');
 function sessionFor(sessionId,targetId){
  return {targetId,send:(method,params={})=>cdp.send(method,params,sessionId),
   on:(method,listener)=>cdp.on(method,(value,sid)=>{if(sid===sessionId)listener(value);})};
 }
 const pageSessions=new Map();
 cdp.on('Target.attachedToTarget',value=>{
  if(value.targetInfo.type==='page'){
   const session=sessionFor(value.sessionId,value.targetInfo.targetId);
   pageSessions.set(value.targetInfo.targetId,{info:value.targetInfo,session});
   events.push({name:'targetAttached',atMs:Date.now(),value:{targetInfo:value.targetInfo,waitingForDebugger:value.waitingForDebugger}});
   session.send('Runtime.runIfWaitingForDebugger').catch(()=>{});
  }
 });
 const {sessionId:tabSessionId}=await cdp.send('Target.attachToTarget',{targetId:initialTab.targetId,flatten:true});
 const tabSession=sessionFor(tabSessionId,initialTab.targetId);
 // Attaching directly to a page is a legacy client and itself disables
 // prerender in current Chrome, even if setPrerenderingAllowed(true) is sent.
 // Child page sessions attached through the stable tab target support activation.
 await tabSession.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
 for(let i=0;i<100&&!pageSessions.size;i++)await delay(20);
 const initialPage=[...pageSessions.values()].find(p=>p.info.subtype!=='prerender');
 assert.ok(initialPage,'Missing page session under tab target');
 let pageCdp=initialPage.session;
 async function evaluate(fn,arg){
  const response=await pageCdp.send('Runtime.evaluate',{expression:`(${fn.toString()})(${JSON.stringify(arg)??''})`,returnByValue:true,awaitPromise:true,timeout:2000});
  if(response.exceptionDetails)throw Error(response.exceptionDetails.text+': '+response.exceptionDetails.exception?.description);
  return response.result.value;
 }
 async function waitFor(fn,timeout=20000){
  const started=Date.now();
  while(Date.now()-started<timeout){
   try{const value=await evaluate(fn);if(value)return value;}catch{}
   await delay(20);
  }throw Error('Timed out waiting for fixture readiness');
 }
 // DevTools attachment otherwise blocks prerender regardless of browser prefs.
 // This removes only that automation restriction; memory/saver eligibility stays native.
 await pageCdp.send('Page.setPrerenderingAllowed',{isAllowed:true});
 for(const name of ['preloadEnabledStateUpdated','prefetchStatusUpdated','prerenderStatusUpdated','ruleSetUpdated']){
  pageCdp.on('Preload.'+name,value=>events.push({name,atMs:Date.now(),value}));
 }
 await pageCdp.send('Preload.enable');
 await pageCdp.send('Page.bringToFront');await pageCdp.send('Page.navigate',{url:origin+'/source'});
 await waitFor(()=>document.readyState==='complete'&&globalThis.sourceToken);
 await evaluate(()=>{document.querySelector('#draft').value='Unsubmitted source document'});
 const sourceToken=await evaluate(()=>sourceToken);
 await delay(2000);
 const stateEvents=events.filter(e=>e.name==='preloadEnabledStateUpdated');
 assert.ok(stateEvents.length,'Missing enabled state event');
 assert.equal(stateEvents.at(-1).value.disabledByPreference,mode==='off','Preference did not take effect');

 async function footprint(name){
  let processInfo,measurement;
  const attempts=[];
  for(let attempt=1;attempt<=3;attempt++){
   ({processInfo}=await cdp.send('SystemInfo.getProcessInfo'));
   const path=join(output,`footprint-${run}-${name}-${attempt}.json`);
   execFileSync('/usr/bin/footprint',['--noCategories','--swapped','-j',path,...processInfo.flatMap(p=>['-p',String(p.id)])],{stdio:['ignore','ignore','pipe'],timeout:30000});
   measurement=JSON.parse(await readFile(path,'utf8'));
   const complete=measurement.processes.every(p=>typeof p.footprint==='number');
   attempts.push({path,errors:measurement.errors,complete});
   if(!measurement.errors.length&&complete)break;await delay(250);
  }
  assert.ok(!measurement.errors.length&&measurement.processes.every(p=>typeof p.footprint==='number'),'Incomplete footprint');
  const sample={name,atMs:Date.now(),footprintMiB:measurement['total footprint']/1048576,processInfo,attempts,
   swap:execFileSync('/usr/sbin/sysctl',['-n','vm.swapusage'],{encoding:'utf8'}).trim()};
  memory.push(sample);console.log(JSON.stringify({run,action,mode,phase:name,footprintMiB:sample.footprintMiB}));
 }
 async function cpuWindow(name,durationMs,work){
  const initial=(await cdp.send('SystemInfo.getProcessInfo')).processInfo;
  const base=new Map(initial.map(p=>[p.id,p.cpuTime]));
  const latest=new Map(initial.map(p=>[p.id,p]));
  const started=performance.now(),samples=[];
  // Invoke the action once, while the sampler remains active.
  const task=work().then(value=>({value}),error=>({error}));
  while(performance.now()-started<durationMs){
   await delay(200);
   const rows=(await cdp.send('SystemInfo.getProcessInfo')).processInfo;
   samples.push({elapsedMs:performance.now()-started,processInfo:rows});
   for(const p of rows){if(!base.has(p.id))base.set(p.id,0);latest.set(p.id,p);}
  }
  const outcome=await task;
  if(outcome.error)throw outcome.error;
  const final=(await cdp.send('SystemInfo.getProcessInfo')).processInfo;
  for(const p of final){if(!base.has(p.id))base.set(p.id,0);latest.set(p.id,p);}
  const elapsedMs=performance.now()-started;
  const seconds=[...latest].reduce((n,[id,p])=>n+Math.max(0,p.cpuTime-base.get(id)),0);
  const value={name,elapsedMs,cpuSeconds:seconds,meanPercentOneCore:seconds/(elapsedMs/1000)*100,samples,initial,final};
  assert.ok(Number.isFinite(seconds)&&seconds>=0);cpu.push(value);
  console.log(JSON.stringify({run,phase:name,cpuSeconds:seconds,meanPercentOneCore:value.meanPercentOneCore}));
  return outcome.value;
 }
 // Let the fresh browser's startup/idle cleanup run before the comparison window.
 await cpuWindow('startup-control',8000,async()=>{});
 await footprint('source');
 await pageCdp.send('Page.bringToFront');
 const visibilityAtInjection=await evaluate(()=>document.visibilityState);
 if(headless)assert.equal(visibilityAtInjection,'visible');
 const rules={ [action]:[{source:'list',urls:[origin+'/target'],eagerness:'immediate'}] };
 await cpuWindow('preparation',8000,()=>evaluate(rules=>{
  const script=document.createElement('script');script.type='speculationrules';script.textContent=JSON.stringify(rules);document.head.append(script);
 },rules));
 const beforeClick={atMs:Date.now(),requests:structuredClone(requests),events:structuredClone(events),
  source:await evaluate(()=>({token:sourceToken,draft:document.querySelector('#draft').value,visibility:document.visibilityState}))};
 assert.equal(beforeClick.source.token,sourceToken);assert.equal(beforeClick.source.draft,'Unsubmitted source document');
 if(headless)assert.equal(beforeClick.source.visibility,'visible');
 if(mode==='off')assert.equal(beforeClick.requests.filter(r=>r.path==='/target').length,0,'Disabled setting still issued speculative target request');
 await footprint('prepared-not-opened');
 const beforeClickEvents=events.length;
 let clickedAt,arrival;
 await pageCdp.send('Page.bringToFront');
 const point=await evaluate(()=>{const r=document.querySelector('#target').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
 await cpuWindow('follow-through',4000,async()=>{
  clickedAt=Date.now();
  await pageCdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
  await pageCdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
  // Activation can replace a page target; discover the active destination rather
  // than attaching to an invisible prerender while it is being prepared.
  const activatedAt=Date.now();
  while(Date.now()-activatedAt<20000){
   const {targetInfos}=await cdp.send('Target.getTargets');
   const current=targetInfos.find(t=>t.type==='page'&&t.url===origin+'/target'&&t.subtype!=='prerender');
   if(current&&pageSessions.has(current.targetId)){pageCdp=pageSessions.get(current.targetId).session;break;}
   await delay(20);
  }
  try{await waitFor(()=>globalThis.visibleReady||globalThis.appError);}catch(error){
   const {targetInfos}=await cdp.send('Target.getTargets');
   const diagnostic=[];
   for(const [id,item] of pageSessions){
    const state=await item.session.send('Runtime.evaluate',{expression:'JSON.stringify({url:location.href,prerendering:document.prerendering,appReady:globalThis.appReady,visibleReady:globalThis.visibleReady,visibility:document.visibilityState})',returnByValue:true,timeout:1000}).catch(e=>({error:String(e)}));
    diagnostic.push({id,state});
   }
   events.push({name:'navigationFailure',atMs:Date.now(),value:{targetInfos,diagnostic}});throw error;
  }
  const value=await evaluate(()=>({ready:visibleReady,error:globalThis.appError}));
  assert.equal(value.error,undefined);arrival=value.ready;
 });
 assert.equal(arrival.payloadBytes,payloadMiB*1024*1024);assert.equal(arrival.first,83);assert.equal(arrival.last,83);
 assert.ok(arrival.epochMs>=clickedAt);
 if(mode==='off')assert.equal(arrival.activationStart,0);
 await footprint('destination-opened');
 const gpuInfo=await cdp.send('SystemInfo.getInfo');
 result={run,action,mode,preference,benchmarkFlags,headless,visibilityAtInjection,
  hardwareRenderer:gpuInfo.gpu.auxAttributes?.glRenderer,
  measurementProtocol:headless?'headless-tab-cdp-v6':'tab-cdp-no-addons-v5',version:await cdp.send('Browser.getVersion'),
  fixture:{payloadMiB,downloadMiB:3,appWorkMs,serverDelaysMs:{document:150,bootstrap:90,data:120}},
  memory,cpu,beforeClick,requests,events,eventsAfterClick:events.slice(beforeClickEvents),arrival,
  clickToAppReadyMs:arrival.epochMs-clickedAt,
  conditions:'Fresh Chrome, same-origin loopback HTTP, sandbox/GPU and memory/saver guards unchanged; tab CDP; addons/default apps and component updates disabled in both lab modes only; headless field records window mode',
  limitations:['Synthetic workload, not a measurement of personal tabs or omnibox predictions','CPU sampling omits work after last observation of exited processes','CPU windows exclude footprint calls','Preparation is observed without navigation, then the same candidate is clicked; never-clicked cost is inferred from preparation already spent','Application-ready timing excludes final paint','Footprint includes compressed/swapped accounting, not only resident RAM']};
 console.log(JSON.stringify({run,action,mode,clickToAppReadyMs:result.clickToAppReadyMs,activated:arrival.activationStart>0,
  speculativeRequests:beforeClick.requests.filter(r=>r.path==='/target').map(r=>r.purpose),
  preloadStatuses:events.filter(e=>e.name.endsWith('StatusUpdated')).map(e=>({name:e.name,status:e.value.status,reason:e.value.prerenderStatus??e.value.prefetchStatus})),checks:'passed'}));
}catch(error){
 await writeFile(join(output,`failure-${run}.json`),JSON.stringify({run,action,mode,error:String(error),requests,events,memory,cpu},null,2));throw error;
}finally{
 await cdp?.send('Browser.close').catch(()=>{});cdp?.close();
 if(child&&child.exitCode===null){await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(3000)]);if(child.exitCode===null)child.kill('SIGTERM');}
 if(result){
  const prefs=JSON.parse(await readFile(join(profile,'Default','Preferences'),'utf8'));
  result.preferenceAfterClose=prefs.net?.network_prediction_options;
  assert.equal(result.preferenceAfterClose,preference);
  await writeFile(resultPath,JSON.stringify(result,null,2));
 }
 await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true});
}

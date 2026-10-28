// Isolated, synthetic Chrome experiment. Never attaches to personal Chrome.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright';

const output = resolve('artifacts/graphics-memory');
await mkdir(output, { recursive: true });
const run = process.argv[2] ?? '1';
if (!/^\d+$/.test(run)) throw Error('Expected numeric run');
const mode = process.argv[3] ?? 'pressure';
if(!['pressure','control'].includes(mode)) throw Error('Expected pressure or control');
const profile = await mkdtemp(join(tmpdir(), 'lehko-graphics-'));
const fixture = `<!doctype html><meta charset="utf-8"><title>Graphics memory fixture</title>
<style>canvas,img{width:320px;height:320px;display:block} .card{filter:drop-shadow(4px 6px 12px #444);transform:translateZ(0)}</style>
<h1>Disposable graphics experiment</h1><textarea id="draft">Unsubmitted draft</textarea><div id="gallery"></div>
<script>
globalThis.token = crypto.randomUUID();
globalThis.contextLosses = 0;
globalThis.assets = [];
globalThis.init = async () => {
 const gallery=document.querySelector('#gallery');
 for(let i=0;i<12;i++) {
  const c=document.createElement('canvas'); c.width=c.height=1024; c.className='card';
  const x=c.getContext('2d'); const g=x.createLinearGradient(0,0,1024,1024);
  g.addColorStop(0,'rgb('+((i*17)%255)+',80,160)'); g.addColorStop(1,'#26b');
  x.fillStyle=g;x.fillRect(0,0,1024,1024); x.fillStyle='white';x.font='64px sans-serif';x.fillText('Document '+i,80,200);
  gallery.append(c);assets.push(c);
 }
 const c=document.createElement('canvas');c.width=c.height=1024;gallery.prepend(c);
 const gl=c.getContext('webgl2',{preserveDrawingBuffer:true});
 if(!gl) throw Error('WebGL2 unavailable');
 c.addEventListener('webglcontextlost',e=>{e.preventDefault();contextLosses++});
 globalThis.gl=gl;globalThis.textures=[];
 for(let i=0;i<8;i++) {
  const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1024,1024,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(1024*1024*4).fill(i+32));
  textures.push(t);
 }
 gl.clearColor(0.25,0.5,0.75,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.finish();
 globalThis.ready=true;
};
globalThis.state = () => {
 const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
 const framebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
 gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,textures[0],0);
 const texturePixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,texturePixel);
 gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(framebuffer);
 return {token,draft:document.querySelector('#draft').value,contextLosses,visibility:document.visibilityState,
 pixel:[...pixel],texturePixel:[...texturePixel],texturesValid:textures.every(t=>gl.isTexture(t)),
 canvasPixel:[...assets[0].getContext('2d').getImageData(10,10,1,1).data]};
};
init().catch(e=>globalThis.failure=String(e));
</script>`;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(request.url === '/graphics' ? fixture : '<!doctype html><title>Foreground control</title><p>Blank control tab</p>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let context;
let browser;
let chromeProcess;
let browserCdp;
const phases = [];
const events = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  // Connect without Playwright's focus and background-policy overrides.
  // Chromium sandbox/GPU remain at their normal defaults.
  chromeProcess = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
    '--user-data-dir='+profile,'--remote-debugging-port=0','--no-first-run',
    '--no-default-browser-check','--window-size=1100,850','about:blank',
  ],{stdio:'ignore'});
  let port;
  for(let i=0;i<150;i++) {
    try { port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break; }
    catch {await delay(100);}
  }
  if(!port) throw Error('Isolated Chrome debug port did not start');
  browser = await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true});
  context = browser.contexts()[0];
  const cdp = browserCdp = await browser.newBrowserCDPSession();
  const info = await cdp.send('SystemInfo.getInfo');
  await writeFile(join(output, `gpu-info-${run}.json`), JSON.stringify(info, null, 2));
  const renderer = String(info.gpu.auxAttributes?.glRenderer ?? '');
  if (!/Apple|Metal/i.test(renderer) || /SwiftShader|llvmpipe/i.test(renderer)) {
    throw Error('Hardware Apple/Metal renderer not confirmed: '+renderer);
  }
  cdp.on('Tracing.dataCollected', data => events.push(...data.value));
  const graphics = await context.newPage();
  const graphicsCdp = await context.newCDPSession(graphics);
  let mainNavigations = 0;
  graphics.on('framenavigated', frame => {if(frame === graphics.mainFrame()) mainNavigations++;});
  async function snapshot(name) {
    // One trace per phase avoids trace-buffer loss and ambiguous rewritten dump IDs.
    events.length=0;
    await cdp.send('Tracing.start', {transferMode:'ReportEvents',traceConfig:{
      excludedCategories:['*'],includedCategories:['disabled-by-default-memory-infra'],
      memoryDumpConfig:{triggers:[]},recordMode:'recordUntilFull',traceBufferSizeInKb:32768,
    }});
    const dump = await cdp.send('Tracing.requestMemoryDump', {deterministic:false,levelOfDetail:'background'});
    if(!dump.success) throw Error('Memory dump failed at '+name);
    const traceComplete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));
    await cdp.send('Tracing.end');await traceComplete;
    await writeFile(join(output,`trace-${run}-${name}.json`),JSON.stringify({traceEvents:events}));
    const {processInfo} = await cdp.send('SystemInfo.getProcessInfo');
    const gpu = processInfo.find(p=>p.type === 'GPU');
    const path=join(output, `footprint-${run}-${name}.json`);
    const args=['--noCategories','--swapped','-j',path,...processInfo.flatMap(p=>['-p',String(p.id)])];
    execFileSync('/usr/bin/footprint',args,{stdio:['ignore','ignore','pipe'],timeout:30000});
    const memory=JSON.parse(await readFile(path,'utf8'));
    const gpuMemory=memory.processes.find(p=>p.pid===gpu?.id);
    const phase={name,dumpGuid:dump.dumpGuid,processInfo,totalFootprintBytes:memory['total footprint'],
      gpuPid:gpu?.id,gpuFootprintBytes:gpuMemory?.footprint,footprintErrors:memory.errors,mainNavigations};
    phases.push(phase);
    console.log(JSON.stringify({run,phase:name,totalMiB:phase.totalFootprintBytes/1048576,gpuMiB:phase.gpuFootprintBytes/1048576}));
  }
  await snapshot('empty');
  await graphics.goto(url+'/graphics');
  await graphics.waitForFunction(()=>globalThis.ready || globalThis.failure);
  assert.equal(await graphics.evaluate(()=>globalThis.failure),undefined);
  await graphics.locator('#draft').fill('Незбережений тестовий документ — '+run);
  await graphics.bringToFront();
  // Rasterize the full gallery, then return to the beginning.
  for(let y=0;y<4500;y+=700) {await graphics.evaluate(y=>scrollTo(0,y),y);await delay(150);}
  await graphics.evaluate(()=>scrollTo(0,0));
  const before=await graphics.evaluate(()=>state());
  assert.equal(before.visibility,'visible');
  await delay(1500);await snapshot('visible');
  const control=await context.newPage();
  const controlCdp=await context.newCDPSession(control);
  await control.goto(url+'/control');await control.bringToFront();
  try {
    await graphics.waitForFunction(()=>document.visibilityState==='hidden',{},{polling:100,timeout:5000});
  } catch(error) {
    const windows=[];
    for(const session of [graphicsCdp,controlCdp]) {
      const {targetInfo}=await session.send('Target.getTargetInfo');
      windows.push(await cdp.send('Browser.getWindowForTarget',{targetId:targetInfo.targetId}));
    }
    console.log(JSON.stringify({visibilityFailure:windows,graphics:await graphics.evaluate(()=>({visibility:document.visibilityState,focus:document.hasFocus()})),control:await control.evaluate(()=>({visibility:document.visibilityState,focus:document.hasFocus()}))}));
    throw error;
  }
  await delay(10000);await snapshot('hidden');
  // A second no-intervention sample distinguishes natural cache cleanup from pressure response.
  await delay(10000);await snapshot('hidden-control');
  if(mode==='pressure') await cdp.send('Memory.simulatePressureNotification',{level:'moderate'});
  await delay(5000);await snapshot('moderate');
  if(mode==='pressure') await cdp.send('Memory.simulatePressureNotification',{level:'critical'});
  await delay(5000);await snapshot('critical');
  const restoreStarted=performance.now();
  await graphics.bringToFront();
  await graphics.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const restoreTwoFramesMs=performance.now()-restoreStarted;
  const after=await graphics.evaluate(()=>state());
  for(const key of ['token','draft','contextLosses','pixel','texturePixel','texturesValid','canvasPixel']) assert.deepEqual(after[key],before[key],key);
  assert.equal(after.contextLosses,0);assert.equal(after.texturesValid,true);assert.equal(mainNavigations,1);
  await delay(1500);await snapshot('restored');
  await writeFile(join(output,`result-${run}.json`),JSON.stringify({run,mode,browser:browser.version(),
    hardwareRenderer:renderer,headless:false,synthetic:true,traceMethod:'one background-level memory trace per phase',phases,before,after,mainNavigations,restoreTwoFramesMs,
    checks:'Draft, JS token, WebGL context/textures/pixels, Canvas pixels preserved; no navigation',
    limitations:['Browser-wide pressure notification, not GPU-only cleanup','Synthetic headed workload, not personal Figma/Notion','Two-frame restore timing includes automation overhead, not user p95']},null,2));
  console.log(JSON.stringify({run,checks:'passed',restoreTwoFramesMs}));
} finally {
  await browserCdp?.send('Browser.close').catch(()=>{});
  await browser?.close().catch(()=>{});
  if(chromeProcess && chromeProcess.exitCode===null) {
    await Promise.race([new Promise(resolve=>chromeProcess.once('exit',resolve)),delay(3000)]);
    if(chromeProcess.exitCode===null) chromeProcess.kill('SIGTERM');
  }
  await new Promise(resolve=>server.close(resolve));
  await rm(profile,{recursive:true,force:true});
}

import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
const root='/bench', state=join(root,'native-cache-state');mkdirSync(state,{recursive:true});
const raw=readFileSync(join(root,'corpus.json')),capture=JSON.parse(raw),events=capture.events.map(row=>row.event);
assert.equal(createHash('sha256').update(raw).digest('hex'),'4ef33788757e84e614b35dd2509a942987b7e5350d634bc327a4055d5dd3e006');
const secret=randomBytes(32).toString('hex');
for(const name of ['stats','observe']){const c=JSON.parse(readFileSync(`/app/${name}.jsonc`));c.main=join('/app',c.main);if(c.assets)c.assets.directory=join('/app',c.assets.directory);delete c.vars.APPLICATION_EVENTS_RELEASE;c.vars.GATEWAY_SECRET=secret;c.vars.ENVIRONMENT='development';delete c.triggers;writeFileSync(join(state,`${name}.jsonc`),JSON.stringify(c),{mode:0o600});}
const headers={'Stats-Gateway-Secret':secret,'Stats-Tailnet-Identity':'user:benchmark@example.invalid','content-type':'application/json'};
let active,stopping=false;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
for(const signal of ['SIGINT','SIGTERM','SIGHUP','SIGQUIT'])process.once(signal,()=>{stopping=true;void stop().finally(()=>process.exit(128+({SIGINT:2,SIGTERM:15,SIGHUP:1,SIGQUIT:3}[signal])))});
async function start(ttl){let ready,failed;const begin=performance.now(),child=spawn(process.execPath,['/orange/node_modules/open-orange/dist/bin.js','dev','--json','--ip','127.0.0.1','--port','8787','--config',join(state,'stats.jsonc'),'--config',join(state,'observe.jsonc')],{cwd:state,env:{...process.env,OTEL_SDK_DISABLED:'true',RIVET_LOG_LEVEL:'error',RIVETKIT_SQLITE_OPT_VFS_STAGING_CACHE_TTL_MS:String(ttl)},stdio:['ignore','pipe','pipe']});active={child};let buffer='';child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const e=JSON.parse(line);if(e.type==='ready')ready=e.url;if(['error','fatal'].includes(e.type))failed=true;}catch{}}});child.stderr.on('data',()=>{});child.once('exit',()=>{if(!ready)failed=true});const deadline=Date.now()+120000;while(!ready&&!failed&&Date.now()<deadline&&!stopping)await pause(50);assert.ok(ready&&!stopping,'isolated runtime did not become ready');active.origin=ready.replace(/\/$/,'');return performance.now()-begin;}
async function stop(){if(!active)return;const {child}=active;active=undefined;if(child.exitCode!==null||child.signalCode!==null)return;await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),15000);timer.unref();child.once('exit',()=>clearTimeout(timer));});}
async function request(path,init={}){const started=performance.now();const response=await fetch(active.origin+path,{...init,headers:{...headers,...init.headers},signal:AbortSignal.timeout(60000)});const body=await response.json();return{status:response.status,body,ms:performance.now()-started,timing:response.headers.get('server-timing'),retry:response.headers.get('retry-after')};}
const from=Math.min(...events.map(e=>e.atMs)),to=Math.max(...events.map(e=>e.atMs))+1;
const windows=[1,6,24,168].map(hours=>({hours,path:`/api/observe/stats/external/telemetry/summary?from=${Math.max(from,to-hours*3600000)}&to=${to}`}));
const expected=new Map(),results=[];let keepAlive;
const report=()=>writeFileSync(join(root,'native-cache-trial.json'),JSON.stringify({diagnostic:true,setting:'RIVETKIT_SQLITE_OPT_VFS_STAGING_CACHE_TTL_MS',sourceSha256:createHash('sha256').update(raw).digest('hex'),events:events.length,from,to,node:process.version,results,memory:process.memoryUsage(),failures:0})+'\n',{mode:0o600});
try{
 await start(30000);
 const listed=await request('/api/v1/services');assert.equal(listed.status,200);
 if(!listed.body.services.some(s=>s.name==='stats')){
 const host=await request('/api/v1/admin/hosts',{method:'POST',body:JSON.stringify({name:'native-cache-benchmark'})});assert.equal(host.status,201);
 const service=await request('/api/v1/admin/services',{method:'POST',body:JSON.stringify({name:'stats',hostIds:[host.body.hostId],healthUrl:active.origin+'/health'})});assert.equal(service.status,201);let accepted=0;
 for(let offset=0;offset<events.length;){const batch=[];let bytes=12;while(batch.length<128&&offset+batch.length<events.length){const event=events[offset+batch.length],n=Buffer.byteLength(JSON.stringify(event))+1;if(bytes+n>60000)break;batch.push(event);bytes+=n;}assert.ok(batch.length);const r=await request('/ingest/observe/v1/stats/batches',{method:'POST',headers:{authorization:'Bearer '+service.body.ingestToken},body:JSON.stringify({events:batch})});if(r.status===429){await pause(61000);continue;}assert.equal(r.status,202);assert.equal(r.body.accepted,batch.length);accepted+=r.body.accepted;offset+=batch.length;if(offset%1024===0)console.log(JSON.stringify({preparing:offset,total:events.length}));}assert.equal(accepted,events.length);
 }
 for(const w of windows){const r=await request(w.path);assert.equal(r.status,200);expected.set(w.hours,r.body)}assert.equal(expected.get(168).totals.events,events.length);await stop();
 for(let round=0;round<5;round++)for(const ttl of(round%2?[300000,30000]:[30000,300000])){
  const readyMs=await start(ttl);for(const w of windows){const r=await request(w.path);assert.equal(r.status,200);assert.deepEqual(r.body,expected.get(w.hours));results.push({round,ttl,condition:'startup-sequence',hours:w.hours,ms:r.ms,timing:r.timing,readyMs});}
  let keepFailure;keepAlive=setInterval(()=>{void request('/api/observe/stats/health').then(r=>{if(r.status!==200)keepFailure=true}).catch(()=>{keepFailure=true})},2000);await pause(35000);assert.ok(!keepFailure,'keepalive failed');
  for(const w of windows){const r=await request(w.path);assert.equal(r.status,200);assert.deepEqual(r.body,expected.get(w.hours));results.push({round,ttl,condition:'awake-after-35s',hours:w.hours,ms:r.ms,timing:r.timing});}
  clearInterval(keepAlive);keepAlive=undefined;const rss=readdirSync('/proc').filter(name=>/^\d+$/.test(name)).reduce((sum,name)=>{try{return sum+Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${name}/status`,'utf8'))?.[1]??0)}catch{return sum}},0);results.push({round,ttl,condition:'resource',containerRssKiB:rss});report();console.log(JSON.stringify({round,ttl,completed:true,containerRssKiB:rss}));await stop();
 }
 report();
}finally{clearInterval(keepAlive);await stop();}

import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {freePort,startSession} from '../../../deploy/orange/session.mts';
const {values}=parseArgs({options:{source:{type:'string'},baseline:{type:'string'},candidate:{type:'string'},prepared:{type:'boolean',default:false}}});
assert.ok(values.source&&values.baseline&&values.candidate,'--source CAPTURE --baseline PACKAGED_DIRECTORY --candidate PACKAGED_DIRECTORY are required');
const captured=JSON.parse(readFileSync(values.source)).events.map(row=>row.event);
const from=Math.min(...captured.map(e=>e.atMs)),to=Math.max(...captured.map(e=>e.atMs))+1;
const variants=['baseline','candidate'].map(name=>{const root=resolve(values[name]),config=JSON.parse(readFileSync(root+'/stats.jsonc'));return{name,root,config,headers:{'Stats-Gateway-Secret':config.vars.GATEWAY_SECRET,'Stats-Tailnet-Identity':'user:benchmark@example.invalid','content-type':'application/json'}}});
let active;
const request=async(item,path,init={})=>{const response=await fetch(active.origin+path,{...init,headers:{...item.headers,...init.headers},signal:AbortSignal.timeout(60000)});const body=await response.json();assert.ok(response.ok,`${path}: ${response.status}`);return{response,body}};
let expected;
try{
 if(!values.prepared)for(const item of variants){
  delete item.config.vars.APPLICATION_EVENTS_RELEASE;writeFileSync(item.root+'/stats.jsonc',JSON.stringify(item.config));
  active=await startSession(item.root,await freePort(),{environment:{OTEL_SDK_DISABLED:'true'}});
  const host=(await request(item,'/api/v1/admin/hosts',{method:'POST',body:JSON.stringify({name:'benchmark-host'})})).body;
  const service=(await request(item,'/api/v1/admin/services',{method:'POST',body:JSON.stringify({name:'stats',hostIds:[host.hostId],healthUrl:active.origin+'/health'})})).body;
  for(let offset=0;offset<captured.length;offset+=64){const batch=captured.slice(offset,offset+64);const {body}=await request(item,'/ingest/observe/v1/stats/batches',{method:'POST',headers:{authorization:'Bearer '+service.ingestToken},body:JSON.stringify({events:batch})});assert.equal(body.accepted,batch.length)}
  await active.stop();active=undefined;item.config.vars.APPLICATION_EVENTS_RELEASE='burst-proof';writeFileSync(item.root+'/stats.jsonc',JSON.stringify(item.config));
 }
 const gate=flag=>{const r=spawnSync('perf-gate-ready',flag?[flag]:[],{encoding:'utf8'});writeFileSync(`.work/tmp/batching-${flag?'post':'pre'}-gate.json`,JSON.stringify({exitCode:r.status,detail:r.stderr}));return r.status===0};
 if(!gate())throw new Error('prepared; perf gate deferred: host busy');
 const results=[];
 for(let round=0;round<5;round++)for(const item of(round%2?[...variants].reverse():variants)){
  active=await startSession(item.root,await freePort(),{environment:{OTEL_SDK_DISABLED:'true'}});
  const startAt=Date.now(),start=performance.now();
  const capabilities=await Promise.all(Array.from({length:16},()=>request(item,'/api/v1/capabilities')));
  for(const result of capabilities)assert.deepEqual(result.body,capabilities[0].body);
  const {response,body}=await request(item,`/api/observe/stats/external/telemetry/summary?from=${from}&to=${to}`);
  const journeyMs=performance.now()-start;
  if(expected)assert.deepEqual(body,expected);else expected=body;assert.equal(body.totals.events,captured.length);
  let events=[];const deadline=Date.now()+15000;
  while(Date.now()<deadline){const {body:read}=await request(item,`/api/observe/stats/external?from=${startAt}&to=${Date.now()+1}&limit=5000`);events=read.events.filter(row=>row.event.operation==='http.get.capabilities');if(events.length===16)break;await new Promise(resolve=>setTimeout(resolve,50))}
  assert.equal(events.length,16);assert.equal(new Set(events.map(row=>row.event.eventId)).size,16);
  const batches=item.name==='baseline'?16:new Set(events.map(row=>`${row.event.delivery.id}:${row.event.delivery.accepted}`)).size;
  const memory=spawnSync('ps',['-A','-o','pid=,ppid=,rss='],{encoding:'utf8'}).stdout.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
  const ids=new Set([active.child.pid]);for(let n=0;n<8;n++)for(const[p,pp]of memory)if(ids.has(pp))ids.add(p);
  results.push({round,name:item.name,journeyMs,deliveryMs:performance.now()-start,ingestBatches:batches,events:events.length,serverTiming:response.headers.get('server-timing'),processTreeRssKiB:memory.filter(([p])=>ids.has(p)).reduce((sum,row)=>sum+row[2],0)});
  await active.stop();active=undefined;
 }
 const accepted=gate('-1');
 const disk=variants.map(v=>({name:v.name,bundleKiB:Number(spawnSync('du',['-sk',v.root+'/stats/bundle'],{encoding:'utf8'}).stdout.trim().split(/\s+/)[0])}));
 writeFileSync('.work/tmp/native-batching-results.json',JSON.stringify({accepted,node:process.version,events:captured.length,from,to,results,disk,harnessMemory:process.memoryUsage(),outputBytes:Buffer.byteLength(JSON.stringify(expected)),failures:0})+'\n',{mode:0o600});
 console.log(JSON.stringify({accepted,results,disk}));assert.ok(accepted,'perf gate deferred: host busy');
}finally{await active?.stop()}

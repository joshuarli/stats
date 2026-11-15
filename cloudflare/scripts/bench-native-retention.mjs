import {chromium} from '@playwright/test';
const usage='usage: node scripts/bench-native-retention.mjs --base URL --now MS [--service NAME] [--cycles N]';
const args=process.argv.slice(2);
if(args.length===1&&args[0]==='--help'){console.log(usage);process.exit(0);}
const options=new Map();
for(let i=0;i<args.length;i+=2){if(!['--base','--now','--service','--cycles'].includes(args[i])||options.has(args[i])||!args[i+1])throw new Error(usage);options.set(args[i],args[i+1]);}
const base=new URL(options.get('--base'));
const now=Number(options.get('--now'));
const service=options.get('--service')??'stats';
const cycles=Number(options.get('--cycles')??'30');
if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!Number.isSafeInteger(now)||now<=0||!Number.isInteger(cycles)||cycles<10||cycles>100||!/^[a-z][a-z0-9-]{0,31}$/.test(service))throw new Error(usage);
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1280,height:720}});
await page.clock.setFixedTime(now);
const failures=[];
page.on('response',response=>{if(response.status()>=400) failures.push({url:response.url(),status:response.status()});});
const cdp=await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
async function settle(){await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));await cdp.send('HeapProfiler.collectGarbage');await cdp.send('HeapProfiler.collectGarbage');}
async function sample(){await settle();const [{metrics},heap]=await Promise.all([cdp.send('Performance.getMetrics'),cdp.send('Runtime.getHeapUsage')]);const values=Object.fromEntries(metrics.map(row=>[row.name,row.value]));return{heapKb:heap.usedSize/1024,nodes:values.Nodes,listeners:values.JSEventListeners,plots:await page.locator('.uplot').count(),liveElements:await page.evaluate(()=>document.querySelectorAll('*').length)};}
async function project(){await page.evaluate(hash=>location.hash=hash,`#/project/${service}`);const handle=await page.waitForFunction(()=>document.querySelectorAll('.native-overview .uplot').length===3);await handle.dispose();}
async function projects(){await page.evaluate(()=>location.hash='#/projects');const handle=await page.waitForFunction(()=>document.querySelector('table[aria-label="Projects"] tbody tr')!==null&&document.querySelectorAll('.uplot').length===0);await handle.dispose();}
try{
await page.goto(new URL('/#/projects',base).href);
await page.locator('table[aria-label="Projects"] tbody tr').waitFor();
await project();await projects();
const before=await sample();
const checkpoints=[before];
for(let cycle=0;cycle<cycles;cycle++){await project();await projects();if([0,1,4,9,19,29].includes(cycle))checkpoints.push({cycle:cycle+1,...await sample()});}
const after=await sample();
const delta={heapKb:after.heapKb-before.heapKb,nodes:after.nodes-before.nodes,listeners:after.listeners-before.listeners};
const pass=failures.length===0&&after.plots===0&&delta.heapKb<2048&&delta.nodes<=50&&delta.listeners<=20;
console.log(JSON.stringify({browser:browser.version(),cycles,before,after,checkpoints,delta,failures,pass},null,2));
if(!pass)process.exitCode=1;
}finally{await browser.close();}

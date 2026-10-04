import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {createRunner} from '../runner.mjs';
import {defaultAgent,defaultRubric} from '../store.mjs';
import {validateConcurrency,taskConcurrency} from '../core.mjs';
import {authenticatedClient,testInitialPassword} from './auth-client.mjs';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
const close=s=>new Promise(r=>s.close(r));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,condition){for(let i=0;i<300;i++){const value=await fn();if(condition(value))return value;await sleep(10);}throw Error('fixture timeout');}
const judgment={score:100,passed:true,reason:'符合案例要求',evidence:[],uncertain:false,veto_triggered:false,dimensions:Object.fromEntries(['facts','materials','action','reply'].map(k=>[k,{score:25,reason:'符合规则',evidence:[]}]))};
async function fixture(delay=25){
 const stats={active:0,peak:0,agentCalls:[],judgeCalls:0};
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||'{}');stats.active++;stats.peak=Math.max(stats.peak,stats.active);let finished=false;const done=()=>{if(!finished){finished=true;stats.active--;}};res.on('close',done);res.on('finish',done);
  const isAgent=req.url==='/agent';if(isAgent)stats.agentCalls.push(body.case_id);else stats.judgeCalls++;
  const timer=setTimeout(()=>{if(res.destroyed)return;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(isAgent?{answer:`回答 ${body.case_id}`}:{choices:[{message:{content:JSON.stringify(judgment)}}]}));},typeof delay==='function'?delay(req.url):delay);
  res.on('close',()=>clearTimeout(timer));
 });
 const base=await listen(server);return {server,base,stats};
}
function mockTask(id,base,count,concurrency,mode='agent'){
 const agent={...defaultAgent,name:'fixture',url:base+'/agent',outputPath:'$.answer',requestTemplate:'{"case_id":"{{input.case_id}}","session":"{{session_id}}"}',retries:0};
 return {id,status:'running',mode,concurrency,answerColumn:'actual_output',snapshot:{agent, rubric:{...defaultRubric,baseUrl:base,model:'fixture'}},rows:Array.from({length:count},(_,i)=>({id:`${id}-${i}`,input:{case_id:`${id}-${i}`,user_input:`问题${i}`,criteria:'不编造',actual_output:`已有回答${i}`},answer:null,judgment:null,status:'pending'}))};
}
const memory=tasks=>({state:{tasks},save(){}});
test('并行数只接受1–50整数，旧任务兼容快照并行数',()=>{
 for(const value of [0,51,1.5,NaN,Infinity,null,true,false,'','3',{},[]])assert.throws(()=>validateConcurrency(value),/1到50的整数/);
 for(const value of [1,3,50])assert.equal(validateConcurrency(value),value);
 assert.equal(taskConcurrency({mode:'agent',snapshot:{agent:{concurrency:7}}}),7);
 assert.equal(taskConcurrency({mode:'existing',snapshot:{}}),2);
 assert.equal(taskConcurrency({mode:'agent',concurrency:50,snapshot:{agent:{sessionMode:'dataset'}}}),1);
});
test('一个案例的Agent及评分共用并行槽，峰值为配置的3条',async()=>{
 const f=await fixture(30),t=mockTask('three',f.base,12,3),runner=createRunner(memory([t]));
 try{await runner.run(t.id);assert.equal(t.status,'completed');assert.equal(f.stats.peak,3);assert.equal(f.stats.agentCalls.length,12);assert.equal(f.stats.judgeCalls,12);assert(t.rows.every(r=>r.judgment));}finally{await close(f.server);}
});
test('多个任务和Runner共享50条上限，已有回答支持并行评分',async()=>{
 const f=await fixture(100),a=mockTask('first',f.base,65,50,'existing'),b=mockTask('second',f.base,65,50,'existing');
 const ra=createRunner(memory([a])),rb=createRunner(memory([b]));
 try{await Promise.all([ra.run(a.id),rb.run(b.id)]);assert.equal(f.stats.peak,50);assert.equal(f.stats.agentCalls.length,0);assert.equal(f.stats.judgeCalls,130);assert.equal(a.status,'completed');assert.equal(b.status,'completed');}finally{await close(f.server);}
});
test('暂停取消排队准入，停止释放槽，继续不会重复已完成案例',async()=>{
 const f=await fixture(120),holder=mockTask('holder',f.base,80,50,'existing'),queued=mockTask('queued',f.base,8,3);
 const store=memory([holder,queued]),runner=createRunner(store);let first,second;
 try{
  first=runner.run(holder.id);await until(()=>f.stats.active,n=>n===50);
  second=runner.run(queued.id);runner.pause(queued.id);await second;assert.equal(queued.status,'paused');assert.equal(f.stats.agentCalls.length,0);
  runner.stop(holder.id);await first;assert.equal(holder.status,'stopped');await until(()=>f.stats.active,n=>n===0);
  await runner.resume(queued.id);assert.equal(queued.status,'completed');assert.equal(f.stats.agentCalls.length,8);assert.equal(new Set(f.stats.agentCalls).size,8);
  const doneBefore=holder.rows.filter(r=>r.judgment).length;await runner.resume(holder.id);assert.equal(holder.status,'completed');assert.equal(holder.rows.filter(r=>r.judgment).length,80);assert(f.stats.judgeCalls>=80-doneBefore);
 }finally{runner.stop(holder.id);runner.stop(queued.id);await Promise.allSettled([first,second]);await close(f.server);}
});
test('排队任务停止后不启动调用；停止评分后继续复用已有Agent答案',async()=>{
 const f=await fixture(path=>path==='/agent'?15:100),holder=mockTask('busy',f.base,50,50,'existing'),queued=mockTask('stop-queued',f.base,3,3);
 const runner=createRunner(memory([holder,queued]));let first,second;
 try{
  first=runner.run(holder.id);await until(()=>f.stats.active,n=>n===50);
  second=runner.run(queued.id);runner.stop(queued.id);await second;assert.equal(queued.status,'stopped');assert.equal(f.stats.agentCalls.length,0);
  await first;second=runner.resume(queued.id);await until(()=>queued.rows.filter(r=>r.answer).length,n=>n===3);
  runner.stop(queued.id);await second;assert.equal(queued.status,'stopped');assert.equal(f.stats.agentCalls.length,3);assert.equal(queued.rows.filter(r=>r.judgment).length,0);
  await until(()=>f.stats.active,n=>n===0);await runner.resume(queued.id);assert.equal(queued.status,'completed');assert.equal(f.stats.agentCalls.length,3,'继续评分不能再次调用已有答案的Agent');
 }finally{runner.stop(holder.id);runner.stop(queued.id);await Promise.allSettled([first,second]);await close(f.server);}
});
test('暂停等待当前流水线结束，继续保留答案与评分并且保持会话顺序',async()=>{
 const f=await fixture(40),t=mockTask('session',f.base,5,1);t.snapshot.agent.sessionMode='dataset';t.snapshot.agent.sessionColumn='session_id';for(const row of t.rows)row.input.session_id='shared-session';
 const runner=createRunner(memory([t]));let running;
 try{running=runner.run(t.id);await until(()=>f.stats.agentCalls.length,n=>n===1);runner.pause(t.id);await running;assert.equal(t.rows.filter(r=>r.judgment).length,1);assert.equal(f.stats.agentCalls.length,1);await runner.resume(t.id);assert.equal(t.status,'completed');assert.equal(f.stats.peak,1);assert.deepEqual(f.stats.agentCalls,t.rows.map(r=>r.input.case_id));}finally{runner.stop(t.id);await running;await close(f.server);}
});
test('HTTP并行参数校验、试跑继承、配置隔离、共享会话和控制操作',async()=>{
 const f=await fixture(15),dir=await mkdtemp(join(tmpdir(),'eval-concurrency-')),app=createApp({dataDir:dir,authOptions:{initialPassword:testInitialPassword}}),base=await listen(app.server),authed=await authenticatedClient(base);
 const req=async(path,data)=>{const r=await authed('/api'+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,body:await r.json()};};
 const completed=async id=>until(async()=>(await req('/tasks/'+id)).body,t=>['completed','completed_with_errors'].includes(t.status));
 try{
  const agent=(await req('/agents',{...defaultAgent,name:'并行测试',url:f.base+'/agent',requestTemplate:'{"case_id":"{{input.case_id}}"}',outputPath:'$.answer',retries:0})).body;
  const rubric=(await req('/rubrics',{...defaultRubric,baseUrl:f.base,model:'fixture'})).body;
  const dataset=(await req('/datasets',{name:'并行测试集',rows:Array.from({length:5},(_,i)=>({case_id:`C${i}`,user_input:`问题${i}`,criteria:'不编造',session_id:'same',actual_output:`已有回答${i}`}))})).body;
  const selection={agentId:agent.id,rubricId:rubric.id,datasetId:dataset.id};
  assert.equal((await req('/preflight',selection)).body.concurrency,3);
  const trial=await completed((await req('/preview',{...selection,concurrency:4})).body.id);assert.equal(trial.concurrency,4);assert.equal(trial.snapshot.execution.concurrency,4);
  const full=await completed((await req('/tasks',{...selection,reuseTrialId:trial.id})).body.id);assert.equal(full.concurrency,4);assert.equal(full.reusedCases,1);assert.equal(f.stats.agentCalls.length,5);
  for(const concurrency of [0,51,1.5,NaN,null,true,'','3']){
   for(const path of ['/preflight','/preview','/tasks'])assert.equal((await req(path,{...selection,concurrency})).status,400,`${path} ${concurrency}`);
   assert.equal((await req('/agents',{id:agent.id,concurrency})).status,400);
   assert.equal((await req('/tasks/'+full.id+'/control',{action:'retry',concurrency})).status,400);
  }
  assert.equal((await req('/agents',{id:agent.id,concurrency:50})).status,200);
  assert.equal((await req('/tasks/'+full.id)).body.concurrency,4);assert.equal((await req('/tasks/'+full.id)).body.snapshot.agent.concurrency,3);
  const retry=await req('/tasks/'+full.id+'/control',{action:'retry',concurrency:2});assert.equal(retry.status,200);assert.equal((await completed(full.id)).concurrency,2);assert.equal((await req('/tasks/'+full.id)).body.snapshot.execution.concurrency,4);assert.equal(f.stats.agentCalls.length,5);
  const shared=(await req('/agents',{...agent,id:undefined,name:'共享会话',sessionMode:'dataset',concurrency:3})).body;
  assert.equal((await req('/preflight',{...selection,agentId:shared.id})).body.concurrency,1);
  assert.equal((await req('/preflight',{...selection,agentId:shared.id,concurrency:3})).status,400);
  const ordered=await completed((await req('/tasks',{...selection,agentId:shared.id,concurrency:1})).body.id);assert.equal(ordered.concurrency,1);
  assert.equal((await req('/tasks/'+ordered.id+'/control',{action:'retry',concurrency:3})).status,400);
  const rescored=await completed((await req('/tasks/'+ordered.id+'/control',{action:'rescore',rubricId:rubric.id,concurrency:50})).body.id);assert.equal(rescored.mode,'existing');assert.equal(rescored.concurrency,50);assert.equal(f.stats.agentCalls.length,10);
  const started=(await req('/tasks',{...selection,concurrency:1})).body;const changed=await req('/tasks/'+started.id+'/control',{action:'retry',concurrency:50});assert.equal(changed.status,400);assert.equal((await req('/tasks/'+started.id)).body.concurrency,1);await completed(started.id);
 }finally{for(const t of app.store.state.tasks)if(app.runner.busy(t.id))app.runner.stop(t.id);await until(()=>app.store.state.tasks.some(t=>app.runner.busy(t.id)),busy=>!busy);await close(app.server);app.store.close();app.auth.close();await close(f.server);await rm(dir,{recursive:true,force:true});}
});

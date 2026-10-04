import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {authenticatedClient,testInitialPassword} from './auth-client.mjs';
import {defaultAgent,defaultRubric} from '../store.mjs';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
const close=s=>new Promise(r=>s.close(r));
async function until(fn,condition){for(let i=0;i<100;i++){const result=await fn();if(condition(result))return result;await new Promise(r=>setTimeout(r,20));}throw Error('task timeout');}
test('试跑持久化、只运行剩余案例、评分失败仍可复核与归因导出',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eval-workflow-'));let agentCalls=0,judgeCalls=0;
 const upstream=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw||'{}');res.setHeader('Content-Type','application/json');
  if(req.url==='/agent'){agentCalls++;res.end(JSON.stringify({answer:body.messages[1].content.includes('三号')?'三号的回答':'普通回答'}));return;}
  judgeCalls++;
  if(body.messages[1].content.includes('三号')){res.writeHead(503);res.end('{"error":"fixture judge unavailable"}');return;}
  res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({score:100,passed:true,reason:'符合要求',evidence:[],uncertain:false,veto_triggered:false,dimensions:Object.fromEntries(['facts','materials','action','reply'].map(k=>[k,{score:25,reason:'符合要求',evidence:[]}]))})}}]}));
 });
 const fixture=await listen(upstream);let app=createApp({dataDir:dir,authOptions:{initialPassword:testInitialPassword}}),base=await listen(app.server);const authed=await authenticatedClient(()=>base);
 async function request(path,data,method=data===undefined?'GET':'POST'){
  const r=await authed('/api'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  return {status:r.status,body:await r.json()};
 }
 try {
  const legacy={...defaultRubric,id:'legacy-custom',name:'旧自定义规则',dimensionRules:undefined,dimensions:'自定义10分规则',scoreMax:10,passThreshold:8,version:1};
  delete legacy.dimensionRules;app.store.state.rubrics.push(legacy);app.store.save();
  const savedLegacy=await request('/rubrics',{id:legacy.id,name:'旧规则改名'});
  assert.equal(savedLegacy.status,200);assert.deepEqual(savedLegacy.body.dimensionRules,[]);assert.equal(savedLegacy.body.scoreMax,10);
  const agent=(await request('/agents',{...defaultAgent,name:'试跑测试',url:fixture+'/agent',outputPath:'$.answer',concurrency:1})).body;
  const rubric=(await request('/rubrics',{...defaultRubric,baseUrl:fixture,model:'fixture-model'})).body;
  const dataset=(await request('/datasets',{name:'独立测试集',rows:['一号','二号','三号'].map((user_input,i)=>({case_id:`C${i+1}`,user_input,context:'',criteria:'不编造',category:'事实与来源'}))})).body;
  const selection={agentId:agent.id,rubricId:rubric.id,datasetId:dataset.id,mode:'agent',name:'试跑留存验证'};
  const checked=await request('/preflight',selection);assert.equal(checked.body.ready,true);assert.equal(agentCalls,0);
  const started=await request('/preview',selection);assert.equal(started.status,201);
  let trial=await until(async()=>(await request('/tasks/'+started.body.id)).body,t=>t.status==='completed');
  assert.equal(trial.isTrial,true);assert.equal(trial.rows.length,1);assert.equal(trial.snapshot.dataset.rows.length,3);assert.equal(agentCalls,1);
  assert.equal((await request('/boot')).body.tasks[0].isTrial,true);
  await close(app.server);app.store.close();app.auth.close();app=createApp({dataDir:dir,authOptions:{initialPassword:testInitialPassword}});base=await listen(app.server);
  trial=(await request('/tasks/'+trial.id)).body;assert.equal(trial.rows[0].answer,'普通回答');
  const continued=await request('/tasks',{...selection,reuseTrialId:trial.id});assert.equal(continued.status,201);
  const repeated=await request('/tasks',{...selection,reuseTrialId:trial.id});assert.equal(repeated.body.id,continued.body.id);
  const full=await until(async()=>(await request('/tasks/'+continued.body.id)).body,t=>t.status==='completed_with_errors');
  assert.equal(full.reusedCases,1);assert.equal(full.reusedScores,1);assert.equal(agentCalls,3);assert.equal(judgeCalls,3);
  assert.equal(full.summary.decided,2);assert.equal(full.summary.coverage,2/3);
  const errorRow=full.rows.find(r=>r.status==='error');assert(errorRow.answer&&!errorRow.judgment);
  const reviewed=await request('/tasks/'+full.id+'/review',{rowId:errorRow.id,decision:'bad',issueType:'事实编造',attribution:'从回答可见未提供的确定事实；内部环节待核实',attributionStatus:'pending'});
  assert.equal(reviewed.status,200);assert.equal(reviewed.body.summary.confirmed,1);
  assert.equal(reviewed.body.summary.issueBreakdown[0].label,'事实编造');
  const report=await(await authed('/api/tasks/'+full.id+'/export?format=md')).text();
  assert(report.includes('归因状态：待核实'));assert(report.includes('未完成评分'));assert(report.includes('三号的回答'));assert(report.includes('明确判定覆盖率'));
  await request('/datasets/'+dataset.id,{name:'已修改版本'},'PUT');
  const stale=await request('/tasks',{...selection,reuseTrialId:trial.id});assert.equal(stale.status,400);assert.match(stale.body.error,/版本/);
  const sales=(await request('/agents',{...agent,id:undefined,name:'改名的成交Agent',adapterType:'sales',inputBindings:'{"case_json":"case_json"}',requestTemplate:'{"case_json":"{{case_json}}"}'})).body;
  const incompatible=await request('/preflight',{...selection,agentId:sales.id});assert.equal(incompatible.body.ready,false);assert(incompatible.body.errors.every(e=>e.caseId&&e.field&&e.message));
  const blocked=await request('/preview',{...selection,agentId:sales.id});assert.equal(blocked.status,400);assert.equal(agentCalls,3);
 }finally{await close(app.server);app.store.close();app.auth.close();await close(upstream);await rm(dir,{recursive:true,force:true});}
});

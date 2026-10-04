import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {authenticatedClient,testInitialPassword} from './auth-client.mjs';
import {defaultAgent,defaultRubric} from '../store.mjs';
import {callAgent} from '../runner.mjs';
import {judgeJson} from '../core.mjs';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
const close=server=>new Promise(resolve=>server.close(resolve));
async function until(fn,check){for(let i=0;i<100;i++){const x=await fn();if(check(x))return x;await new Promise(r=>setTimeout(r,30));}throw Error('等待任务超时');}
test('实际HTTP执行、评分失败重试、人工复核、导出与版本快照',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eval-studio-test-'));let agentCalls=0,failJudge=true;
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const b=JSON.parse(raw||'{}');res.setHeader('Content-Type','application/json');
 if(req.url==='/agent'){agentCalls++;const msg=b.messages[1].content;res.end(JSON.stringify({answer:msg.includes('物理')?'物理课程280元/课时。':msg.includes('阅读')?'孩子现在只有40分。':'体验课99元/次。'}));}
 else {if(b.messages[0].content.includes('评测数据设计员')){const structured=b.messages[0].content.includes('case_json对象');const item={case_id:'G001',user_input:'体验课多少钱？',context:'体验课99元。',criteria:'不编造价格。'};if(structured)item.case_json={case_id:'G001',as_of:'2026-09-30',input:{intent:'analyze',customer:{name:'合成客户'},history:[{id:'m1',role:'customer',text:item.user_input}],knowledge:[],instruction:'',previous:null}};res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({cases:[item]})}}]}));return;}const prompt=b.messages[1].content;if(prompt.includes('阅读')&&failJudge){failJudge=false;res.statusCode=503;res.end('{"error":"temporary"}');return;}const bad=prompt.includes('物理')||prompt.includes('阅读');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({score:bad?40:100,passed:!bad,reason:bad?'回答编造或错误套用事实。':'有资料支持。',evidence:[bad?'回答中的确定事实无来源。':'体验课99元。'],veto_triggered:bad,uncertain:false,dimensions:Object.fromEntries(['facts','materials','action','reply'].map(k=>[k,{score:bad?10:25,reason:bad?'有错误证据，扣15分。':'符合要求。',evidence:bad?['回答无资料支持。']:[]}]))})}}],usage:{total_tokens:10}}));}});
 const fixture=await listen(upstream),app=createApp({dataDir:dir,authOptions:{initialPassword:testInitialPassword}}),base=await listen(app.server),authed=await authenticatedClient(base);
 async function request(path,data,method=data?'POST':'GET'){const r=await authed('/api'+path,{method,headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,body:await r.json()};}
 try{
 const boot=(await request('/boot')).body;assert.equal(boot.tasks.length,0);
 const agent=(await request('/agents',{...defaultAgent,name:'本地测试Agent',url:fixture+'/agent',outputPath:'$.answer',apiKey:'fixture-private-key',headers:'{"Content-Type":"application/json","X-Api-Key":"fixture-header-secret"}'})).body;
 assert.equal(agent.apiKey,undefined);assert.equal(agent.hasApiKey,true);assert(!agent.headers.includes('fixture-header-secret'));
 const rubric=(await request('/rubrics',{...defaultRubric,baseUrl:fixture+'/v1',model:'fixture-model',apiKey:'fixture-judge-key'})).body;
 const blockedPreview=await request('/preview',{datasetId:boot.datasets[0].id,agentId:agent.id,rubricId:boot.rubrics[0].id});assert.equal(blockedPreview.status,400);assert.equal(agentCalls,0,'评判模型未配置时不能调用Agent');
 const started=await request('/tasks',{datasetId:boot.datasets[0].id,agentId:agent.id,rubricId:rubric.id,name:'真实链路测试'});assert.equal(started.status,201);
 let task=await until(async()=> (await request('/tasks/'+started.body.id)).body,t=>t.status==='completed_with_errors');
 assert.equal(task.summary.answered,3);assert.equal(task.summary.graded,2);assert.equal(task.summary.failed,1);assert.equal(task.summary.passRate,.5);assert.equal(agentCalls,3);
 const updatedAgent=(await request('/agents',{...agent,name:'改名后Agent',apiKey:''})).body;assert.equal(updatedAgent.hasApiKey,true);
 await request('/tasks/'+task.id+'/control',{action:'retry'});task=await until(async()=> (await request('/tasks/'+task.id)).body,t=>t.status==='completed');
 assert.equal(agentCalls,3,'评分重试不应重复调用Agent');assert.equal(task.summary.graded,3);assert.equal(task.summary.passRate,1/3);
 const bad=task.rows.find(r=>!r.judgment.passed);const review=await request('/tasks/'+task.id+'/review',{rowId:bad.id,decision:'bad',issueType:'资料适用错误',attribution:'错误套用学科资料；具体内部模块待确认。'});assert.equal(review.body.summary.confirmed,1);
 const dispute=task.rows.find(r=>r.judgment&&!r.judgment.passed&&r.id!==bad.id);await request('/tasks/'+task.id+'/review',{rowId:dispute.id,decision:'disputed',note:'待复核'});
 task=(await request('/tasks/'+task.id)).body;assert.equal(task.summary.disputed,1);assert.equal(task.summary.reviewPending,0);
 const dataset=(await request('/datasets/'+boot.datasets[0].id)).body;dataset.rows[0].context='价格修改为199元';await request('/datasets/'+dataset.id,{rows:dataset.rows},'PUT');
 task=(await request('/tasks/'+task.id)).body;assert.equal(task.snapshot.agent.name,'本地测试Agent');assert(task.snapshot.dataset.rows[0].context.includes('99'));assert(!JSON.stringify(task).includes('fixture-private-key'));assert(!JSON.stringify(task).includes('fixture-header-secret'));
 const report=await (await authed('/api/tasks/'+task.id+'/export?format=md')).text();assert(report.includes('Agent回答原文'));assert(report.includes('33.3%'));assert(report.includes('归因'));assert(!report.includes('fixture-judge-key'));
 const excel=await authed('/api/tasks/'+task.id+'/export?format=xlsx');assert.equal(excel.status,200);assert.equal((await excel.arrayBuffer()).byteLength>1000,true);
 const existing=await request('/tasks',{mode:'existing',datasetId:dataset.id,rubricId:rubric.id});assert.equal(existing.status,400);
 const rerun=await request('/tasks/'+task.id+'/control',{action:'rescore',rubricId:rubric.id});const newTask=await until(async()=> (await request('/tasks/'+rerun.body.id)).body,t=>t.status==='completed');assert.equal(agentCalls,3);assert.equal(newTask.summary.reviewed,0);assert.equal(newTask.parentTaskId,task.id);
 const csvBody=Buffer.from('用户提问,判定要求\n你好,不编造\n').toString('base64');const imported=await request('/datasets',{name:'中文CSV',fileName:'中文.csv',file:csvBody});assert.equal(imported.status,201);assert.equal(imported.body.rows[0]['用户提问'],'你好');
 const preset=(await request('/presets/sales',{})).body;assert(preset.datasetId);assert.equal(preset.agentId,undefined);const salesAgent=(await request('/agents',{...defaultAgent,name:'结构化测试接口',adapterType:'sales',url:fixture+'/agent'})).body;const presetData=(await request('/datasets/'+preset.datasetId)).body;assert.equal(presetData.rows.length,50);assert(presetData.rows.every(r=>r.case_json&&r.criteria&&r.user_input));const generated=await request('/generate',{rubricId:rubric.id,agentId:salesAgent.id,count:1,scene:'销售课程价格场景'});assert.equal(generated.status,200);assert.equal(JSON.parse(generated.body.rows[0].case_json).input.intent,'analyze');
 const dupe=await request('/datasets',{name:'重复案例',rows:[{case_id:'1',user_input:'a'},{case_id:'1',user_input:'b'}]});assert.equal(dupe.status,400);
 await close(app.server);app.store.close();app.auth.close();const reopened=createApp({dataDir:dir,authOptions:{initialPassword:testInitialPassword}});assert.equal(reopened.store.state.tasks.length,2);assert.equal(reopened.store.state.agents[0].apiKey,'fixture-private-key');reopened.store.close();reopened.auth.close();
 }finally{if(app.server.listening)await close(app.server);await close(upstream);await rm(dir,{recursive:true,force:true});}
});
test('流式输出提取和结束信号校验',async()=>{const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n');});const base=await listen(server);try{const result=await callAgent({...defaultAgent,url:base,name:'流式测试',doneRequired:true},{user_input:'你好'});assert.equal(result.answer,'你好');assert.equal(typeof result.agentPrompt.user,'string');}finally{await close(server);}});
test('评分JSON必须合法且遵守阈值及否决条件',()=>{assert.throws(()=>judgeJson('{"score":100,"passed":true,"reason":"好","evidence":[]}',defaultRubric));const j=judgeJson(JSON.stringify({score:100,passed:true,reason:'越权承诺',evidence:['保证提升'],veto_triggered:true,uncertain:false,dimensions:Object.fromEntries(['facts','materials','action','reply'].map(k=>[k,{score:25,reason:'符合维度要求。',evidence:[]}]))}),defaultRubric);assert.equal(j.passed,false);});

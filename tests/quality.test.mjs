import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAgent, defaultRubric, createStore, migrateState, summary } from '../store.mjs';
import { validateRubric, judgeJson } from '../core.mjs';
import { createRunner, judge, rewriteStateCheck } from '../runner.mjs';

function goodJudgment(overrides={}) {
 return {score:100,passed:true,reason:'全部事实和动作有依据。',evidence:['输入原文与回复一致。'],veto_triggered:false,uncertain:false,
  dimensions:Object.fromEntries(defaultRubric.dimensionRules.map(rule=>[rule.key,{score:25,reason:'符合要求。',evidence:[]}])),...overrides};
}
function modelResponse(judgment=goodJudgment()) {
 return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(judgment)}}]}),{headers:{'Content-Type':'application/json'}});
}

test('严格分项校验拒绝总分矛盾、缺失维度与无扣分证据，并保留旧规则兼容标记',()=>{
 const valid=structuredClone(defaultRubric);
 assert.equal(validateRubric(valid).dimensionRules.length,4);
 assert.equal(judgeJson(JSON.stringify(goodJudgment()),valid).dimensionValidated,true);
 const mismatch=goodJudgment();mismatch.dimensions.facts={score:1,reason:'事实错误。',evidence:['无依据价格。']};
 assert.throws(()=>judgeJson(JSON.stringify(mismatch),valid),/分项得分之和/);
 const missing=goodJudgment();delete missing.dimensions.reply;
 assert.throws(()=>judgeJson(JSON.stringify(missing),valid),/全部配置分项/);
 const noEvidence=goodJudgment({score:99});noEvidence.dimensions.facts.score=24;
 assert.throws(()=>judgeJson(JSON.stringify(noEvidence),valid),/扣分时必须提供证据/);
 const invalidRules=structuredClone(valid);invalidRules.dimensionRules[0].max=20;
 assert.throws(()=>validateRubric(invalidRules),/满分之和/);
 const legacy=structuredClone(valid);delete legacy.dimensionRules;
 assert.equal(judgeJson(JSON.stringify(goodJudgment({dimensions:{facts:1}})),legacy).dimensionValidated,false);
 const shifted={...valid,scoreMin:10,scoreMax:110,passThreshold:90};
 assert.equal(judgeJson(JSON.stringify(goodJudgment({score:110})),shifted).score,110);
});

test('不确定与通过互斥，统计分母只含已确定结论，评分失败也可待复核',()=>{
 const unsure=judgeJson(JSON.stringify(goodJudgment({uncertain:true})),defaultRubric);
 assert.equal(unsure.passed,false);assert.equal(unsure.verdict,'uncertain');
 const fail=judgeJson(JSON.stringify(goodJudgment({passed:false})),defaultRubric);
 const pass=judgeJson(JSON.stringify(goodJudgment()),defaultRubric);
 const task={status:'completed_with_errors',rows:[
  {input:{category:'事实'},answer:'A',status:'done',judgment:pass},
  {input:{category:'事实'},answer:'B',status:'done',judgment:unsure},
  {input:{category:'动作'},answer:'C',status:'done',judgment:fail,review:{decision:'bad',issueType:'动作不合理',attributionStatus:'confirmed'}},
  {input:{category:'动作'},answer:'D',status:'error',judgment:null}
 ]};
 const s=summary(task);assert.equal(s.passed,1);assert.equal(s.notPassed,1);assert.equal(s.uncertain,1);
 assert.equal(s.graded,3);assert.equal(s.decided,2);assert.equal(s.passRate,.5);assert.equal(s.coverage,.5);assert.equal(s.reviewPending,2);
 assert.deepEqual(s.issueBreakdown,[{label:'动作不合理',count:1}]);assert.deepEqual(s.attributionBreakdown,[{label:'confirmed',count:1}]);
 assert.equal(s.scenarioBreakdown.find(x=>x.label==='事实').passRate,1);
 const legacyUncertain=summary({rows:[{status:'done',judgment:{...unsure,passed:true}}]});assert.equal(legacyUncertain.passRate,null);
 assert.equal(summary({status:'running',rows:[{answer:'A',status:'judging'}]}).reviewPending,0);
 assert.equal(summary({status:'paused',rows:[{answer:'A',status:'judging'}]}).reviewPending,0);
});

test('停止结束前禁止恢复，恢复后重新调度，不把pending误标为完成',async t=>{
 let first=true,abortObserved=false,markStarted;const started=new Promise(resolve=>{markStarted=resolve;});
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url.includes('/agent')){
   if(first){first=false;markStarted();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{abortObserved=true;reject(options.signal.reason);},{once:true}));}
   return new Response(JSON.stringify({answer:'正确回复。'}),{headers:{'Content-Type':'application/json'}});
  }
  return modelResponse();
 });
 const task={id:'memory-task',status:'running',mode:'agent',snapshot:{agent:{...defaultAgent,url:'https://mock.invalid/agent',outputPath:'$.answer',retries:0,concurrency:1},rubric:{...defaultRubric,baseUrl:'https://mock.invalid/v1',model:'mock'}},rows:[{input:{case_id:'C1',criteria:'准确'},status:'pending',answer:null,judgment:null}]};
 const runner=createRunner({state:{tasks:[task]},save(){}});
 const running=runner.run(task.id);await started;runner.stop(task.id);
 assert.equal(task.status,'stopping');assert.throws(()=>runner.resume(task.id),/正在结束/);
 await running;assert.equal(abortObserved,true);assert.equal(task.status,'stopped');assert.equal(task.rows[0].status,'pending');
 await runner.resume(task.id);assert.equal(task.status,'completed');assert.equal(task.rows[0].status,'done');assert.equal(summary(task).graded,1);
});

test('评分接收previous完整输入、忽略trace来源，并确定性识别改写状态变化',async t=>{
 let sent;
 t.mock.method(globalThis,'fetch',async(url,options)=>{sent=JSON.parse(options.body);return modelResponse();});
 const previous={understanding:{profile:{grade:'六年级'}},decision:{action:'核实阅读困难'}};
 const row={input:{case_id:'N43',user_input:'孩子六年级',criteria:'理解和决策保持原样',context:'简化上下文',case_json:JSON.stringify({case_id:'N43',input:{intent:'rewrite',previous,history:[{role:'customer',text:'孩子六年级'}]}})},
  answer:JSON.stringify({understanding:{profile:{grade:'高一'}},decision:previous.decision}),outputs:{trace:{fabricatedSource:'不要当作原话'}}};
 row.outputs.answer=row.answer;
 const result=await judge({...defaultRubric,baseUrl:'https://mock.invalid/v1',model:'mock'},row);
 assert(sent.messages[1].content.includes('"previous"'));assert(sent.messages[1].content.includes('六年级'));
 assert(!sent.messages[1].content.includes('fabricatedSource'));assert(sent.messages[0].content.includes('trace'));
 assert.equal(result.judgment.passed,false);assert.equal(result.judgment.verdict,'not_passed');assert.equal(result.judgment.deterministicViolation,true);
 assert.deepEqual(result.deterministicChecks[0].changedFields,['understanding']);
 assert.equal(rewriteStateCheck({...row,answer:JSON.stringify({decision:previous.decision,understanding:previous.understanding})}).status,'passed');
 const missing=await judge({...defaultRubric,baseUrl:'https://mock.invalid/v1',model:'mock'},{...row,answer:'只有话术',outputs:{answer:'只有话术'}});
 assert.equal(missing.judgment.verdict,'uncertain');
});

test('只迁移当前默认规则与旧适配配置，历史快照保持不变；重启恢复stopping',async()=>{
 const oldRubric={...structuredClone(defaultRubric),id:'r',version:3};delete oldRubric.dimensionRules;
 const oldAgent={...defaultAgent,id:'a',name:'任意改名',version:2,url:'http://127.0.0.1:4175/evaluate',inputBindings:'{"case_json":"case_json"}',requestTemplate:'{"case_json":"{{case_json}}"}'};delete oldAgent.adapterType;
 const snapshot=structuredClone({rubric:oldRubric,agent:oldAgent});
 const state={rubrics:[oldRubric,{...structuredClone(oldRubric),id:'custom',dimensions:'其他规则'}],agents:[oldAgent],tasks:[{snapshot:structuredClone(snapshot)}]};
 migrateState(state);assert.equal(state.rubrics[0].version,4);assert.equal(state.rubrics[0].dimensionRules.length,4);assert.equal(state.rubrics[1].dimensionRules,undefined);
 assert.equal(state.agents[0].adapterType,'sales');assert.equal(state.agents[0].version,3);assert.deepEqual(state.tasks[0].snapshot,snapshot);
 migrateState(state);assert.equal(state.rubrics[0].version,4);assert.equal(state.agents[0].version,3);
 const dir=await mkdtemp(join(tmpdir(),'eval-quality-'));
 let store;
 try{store=createStore(dir);store.state.tasks.push({id:'stopped-on-restart',status:'stopping',rows:[{status:'judging'}]});store.save();store.close();store=createStore(dir);assert.equal(store.state.tasks[0].status,'interrupted');assert.equal(store.state.tasks[0].rows[0].status,'pending');}
 finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

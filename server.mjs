import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import XLSX from 'xlsx';
import { createStore,uid,now,copy,publicConfig,configSecrets,summary,defaultAgent,defaultRubric } from './store.mjs';
import { fail,normalizeRows,importFile,csv,validateAgent,validateRubric,objectJson,urlCheck,validateConcurrency,taskConcurrency,DEFAULT_CONCURRENCY } from './core.mjs';
import { createRunner,completeModel } from './runner.mjs';
import { reconcileRows,preflightRows } from './cases.mjs';
import { reportRows,markdown } from './reports.mjs';
import { createAuth } from './auth.mjs';
import { probeAgentService } from './service-health.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const sampleColumns=['case_id','user_input','context','criteria','actual_output'];
export function createApp({dataDir=join(root,'.data'),authOptions={}}={}){const auth=createAuth({dataDir,...authOptions}),store=createStore(dataDir),runner=createRunner(store);
 // Upgrade derived fields only; historical task snapshots remain immutable.
 let migrated=false;
 for(const dataset of store.state.datasets){try{const rows=reconcileRows(dataset.rows);if(JSON.stringify(rows)!==JSON.stringify(dataset.rows)){dataset.rows=rows;dataset.columns=[...new Set(rows.flatMap(r=>Object.keys(r)))];dataset.version++;dataset.updatedAt=now();migrated=true;}}catch{/* invalid datasets remain editable and are rejected by preflight */}}
 if(migrated)store.save();
 const get=(collection,id)=>{const item=store.state[collection].find(x=>x.id===id);if(!item)fail('记录不存在。',404);return item;};
 const hideSecrets=(value,...configs)=>{let serialized=JSON.stringify(value);for(const secret of configs.flatMap(configSecrets))if(secret)serialized=serialized.replaceAll(JSON.stringify(secret).slice(1,-1),'[已隐藏]');return JSON.parse(serialized);};
 const cleanTask=t=>{const c=copy(t);c.snapshot.agent=c.snapshot.agent?publicConfig(c.snapshot.agent):null;c.snapshot.rubric=publicConfig(c.snapshot.rubric);c.concurrency=taskConcurrency(t);c.summary=summary(t);let serialized=JSON.stringify(c);for(const secret of [...configSecrets(t.snapshot.agent),...configSecrets(t.snapshot.rubric)])if(secret)serialized=serialized.replaceAll(JSON.stringify(secret).slice(1,-1),'[已隐藏]');return JSON.parse(serialized);};
 const saveConfig=(collection,data,defaults,validate)=>{const old=data.id?get(collection,data.id):null;const c={...defaults,...copy(old||{}),...data};if(collection==='rubrics'&&old&&old.dimensionRules==null&&data.dimensionRules==null)c.dimensionRules=[];delete c.hasApiKey;if(old?.headers&&c.headers){try{const h=JSON.parse(c.headers),previous=JSON.parse(old.headers);for(const[k,v]of Object.entries(h))if(v==='[已保存密钥]'&&previous[k])h[k]=previous[k];c.headers=JSON.stringify(h);}catch{}}if(!data.apiKey&&!data.clearApiKey)c.apiKey=old?.apiKey||'';if(data.clearApiKey)c.apiKey='';delete c.clearApiKey;validate(c);c.id=old?.id||uid();c.version=(old?.version||0)+1;c.updatedAt=now();if(old)Object.assign(old,c);else store.state[collection].push(c);store.save();return publicConfig(c);};

 function executionConcurrency(data,agent,mode,previous=null){
  const supplied=Object.hasOwn(data,'concurrency'),serial=mode==='agent'&&agent?.sessionMode==='dataset';
  const concurrency=supplied?validateConcurrency(data.concurrency):previous?taskConcurrency(previous):serial?1:DEFAULT_CONCURRENCY;
  if(serial&&concurrency!==1)fail('复用数据集会话时，并行条数必须为1，确保多轮消息按顺序执行。');
  return concurrency;
 }
 function applyConcurrency(task,value,action){if(taskConcurrency(task)!==value){task.executionChanges??=[];task.executionChanges.push({at:now(),action,from:taskConcurrency(task),to:value});}task.concurrency=value;}
 async function plan(data){
  const dataset=get('datasets',data.datasetId),rubric=get('rubrics',data.rubricId);
  const mode=data.mode==='existing'?'existing':'agent';
  const agent=mode==='agent'?get('agents',data.agentId):null,answerColumn=data.answerColumn||'actual_output';
  const concurrency=executionConcurrency(data,agent,mode,data.reuseTrialId?get('tasks',data.reuseTrialId):null);
  const result=preflightRows(dataset.rows,agent,rubric,mode,answerColumn);
  const checks=[{label:'案例字段与判定要求',status:result.ready?'pass':'error',message:result.ready?`${dataset.rows.length}条案例结构检查通过`:`发现${result.errors.length}项需要处理`}];
  if(agent){try{validateAgent(copy(agent));checks.push({label:'Agent接口配置',status:'pass',message:'配置格式有效；实际连接将在试跑时验证'});}catch(e){result.errors.push({caseId:'配置',field:'agent',message:e.message});checks.push({label:'Agent接口配置',status:'error',message:e.message});}}
  try{validateRubric(copy(rubric));if(!rubric.enabled||!rubric.baseUrl||!rubric.model)fail('请配置并启用评判模型，再开始评测。');checks.push({label:'评分标准与模型配置',status:'pass',message:'配置格式有效；模型可用性将在试跑时验证'});}catch(e){result.errors.push({caseId:'配置',field:'rubric',message:e.message});checks.push({label:'评分标准与模型配置',status:'error',message:e.message});}
  if(agent){const service=await probeAgentService(agent);if(service){checks.push(service);if(service.status==='error')result.errors.push({caseId:'配置',field:'agent.service',message:service.message});}}
  result.ready=result.errors.length===0;result.checks=checks;result.concurrency=concurrency;
  return {dataset,rubric,agent,mode,answerColumn,concurrency,result};
 }
 function requireIdle(task){if(runner.busy(task.id)||['running','stopping'].includes(task.status))fail('请等待当前调用结束后，再调整并行条数或重新运行。');}
 async function requireTaskService(task){if(task.mode==='agent'&&task.rows.some(row=>!row.answer&&!row.judgment)){const service=await probeAgentService(task.snapshot.agent);if(service?.status==='error')fail(service.message);}}
 function requireReady(p){if(!p.result.ready)fail(p.result.errors.slice(0,12).map(x=>`${x.caseId} · ${x.field}：${x.message}`).join('\n'));}
 async function startTask(data,isTrial=false){
  const p=await plan(data);requireReady(p);
  if(store.state.tasks.filter(t=>['running','paused','stopping'].includes(t.status)).length>=3)fail('最多同时运行3个任务。');
  const {dataset,rubric,agent,mode,answerColumn,concurrency}=p;
  let trial=null;
  if(data.reuseTrialId){
   trial=get('tasks',data.reuseTrialId);
   if(!trial.isTrial)fail('只能从试跑记录继续。');
   if(runner.busy(trial.id)||['running','paused','stopping'].includes(trial.status))fail('请等待试跑结束，再继续评测。');
   const equal=(a,b)=>a?.id===b?.id&&a?.version===b?.version;
   if(!equal(trial.snapshot.dataset,dataset)||!equal(trial.snapshot.rubric,rubric)||!equal(trial.snapshot.agent,agent)||trial.mode!==mode||trial.answerColumn!==answerColumn)fail('案例或配置版本已变化，无法复用这次试跑。请重新试跑或新建评测。');
   if(trial.continuedTaskId&&store.state.tasks.some(t=>t.id===trial.continuedTaskId))return get('tasks',trial.continuedTaskId);
  }
  const index=Number(data.index||0);
  if(isTrial&&(!Number.isInteger(index)||index<0||index>=dataset.rows.length))fail('案例不存在。');
  const selected=isTrial?[dataset.rows[index]]:dataset.rows;
  let reusedCases=0,reusedScores=0;
  const rows=selected.map(input=>{
   const old=trial?.rows.find(r=>r.input.case_id===input.case_id&&JSON.stringify(r.input)===JSON.stringify(input)&&r.answer?.trim());
   if(old){reusedCases++;if(old.judgment)reusedScores++;return {...copy(old),id:uid(),review:null,status:old.judgment?'done':'pending',error:null,errorPhase:null};}
   return {id:uid(),input:copy(input),status:'pending',answer:null,judgment:null,review:null};
  });
  const t={id:uid(),name:String(data.name||`${dataset.name} · 评测`).trim()+(isTrial?' · 试跑':''),status:'running',isTrial,mode,answerColumn,concurrency,createdAt:now(),snapshot:{dataset:copy(dataset),agent:agent?copy(agent):null,rubric:copy(rubric),execution:{concurrency}},rows,reusedCases,reusedScores,trialId:trial?.id||null};
  if(trial)trial.continuedTaskId=t.id;
  store.state.tasks.unshift(t);store.save();runner.run(t.id);return t;
 }
 async function body(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>12*1024*1024)fail('请求内容过大。',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{fail('提交的数据不是合法JSON。');}}
 const server=http.createServer(async(req,res)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
 const json=(n,x)=>{res.writeHead(n,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(x));};
 const download=(data,type,name)=>{res.writeHead(200,{'Content-Type':type,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(name)}`});res.end(data);};
 try{const url=new URL(req.url,'http://localhost'),path=url.pathname,parts=path.split('/').filter(Boolean);const host=req.headers.host||'';if(!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))fail('仅允许本地访问。',403);
 if(req.method!=='GET'&&((req.headers.origin&&req.headers.origin!==`http://${host}`)||req.headers['sec-fetch-site']==='cross-site'))fail('请求来源不匹配。',403);
 if(!path.startsWith('/api/')){const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css','/renderers.js':'renderers.js'};if(!files[path]||req.method!=='GET')fail('页面不存在。',404);const file=files[path];res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});res.end(await readFile(join(root,'public',file)));return;}
 if(path==='/api/auth/status'&&req.method==='GET')return json(200,auth.status(req));
 if(path==='/api/auth/login'&&req.method==='POST'){const result=await auth.login(req,await body(req));res.setHeader('Set-Cookie',result.setCookie);return json(200,result.body);}
 if(path==='/api/auth/logout'&&req.method==='POST'){const result=await auth.logout(req);res.setHeader('Set-Cookie',result.setCookie);return json(200,result.body);}
 if(path==='/api/auth/password'&&req.method==='POST'){const result=await auth.changePassword(req,await body(req));res.setHeader('Set-Cookie',result.setCookie);return json(200,result.body);}
 auth.requireSession(req,{mutation:!['GET','HEAD'].includes(req.method)});
 if(path==='/api/boot'&&req.method==='GET')return json(200,{datasets:store.state.datasets.map(d=>({...d,rows:undefined,rowCount:d.rows.length})),agents:store.state.agents.map(publicConfig),rubrics:store.state.rubrics.map(publicConfig),tasks:store.state.tasks.map(t=>({id:t.id,name:t.name,status:t.status,concurrency:taskConcurrency(t),isTrial:!!t.isTrial,reusedCases:t.reusedCases||0,continuedTaskId:t.continuedTaskId,createdAt:t.createdAt,agentName:t.snapshot.agent?.name||'已有回答',datasetName:t.snapshot.dataset.name,summary:summary(t)})),defaults:{agent:defaultAgent,rubric:defaultRubric}});
 if(path==='/api/template'&&req.method==='GET'){
  const agent=url.searchParams.get('agentId')?get('agents',url.searchParams.get('agentId')):null;
  let rows=[{case_id:'C01',user_input:'小学英语体验课多少钱？',context:'体验课99元/次。',criteria:'准确回答价格，不额外承诺。',actual_output:''}];
  if(agent?.adapterType==='sales')rows=reconcileRows([{...rows[0],case_json:JSON.stringify({case_id:'C01',as_of:new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}),input:{intent:'analyze',customer:{name:'合成客户'},history:[{id:'C01-m1',role:'customer',text:rows[0].user_input}],knowledge:[{id:'C01-price',title:'小学英语体验课',content:rows[0].context,enabled:true}],instruction:'',previous:null}})}]);
  return download(csv(rows,Object.keys(rows[0])),'text/csv; charset=utf-8','评测案例模板.csv');
 }
 if(parts[1]==='datasets'){
 if(parts[2]&&req.method==='GET'){const d=get('datasets',parts[2]);if(parts[3]==='export')return download(csv(d.rows,d.columns),'text/csv; charset=utf-8',`${d.name}.csv`);return json(200,d);}
 if(req.method==='POST'&&!parts[2]){const d=await body(req);const imported=d.file?importFile(d.fileName,d.file):{rows:normalizeRows(d.rows),columns:[...new Set(['case_id',...d.rows.flatMap(r=>Object.keys(r))])]};imported.rows=reconcileRows(imported.rows);imported.columns=[...new Set(imported.rows.flatMap(r=>Object.keys(r)))];const item={id:uid(),name:String(d.name||d.fileName||'新数据集').trim(),version:1,...imported,createdAt:now(),updatedAt:now()};store.state.datasets.push(item);store.save();return json(201,item);}
 if(req.method==='PUT'&&parts[2]){const old=get('datasets',parts[2]),d=await body(req);const rows=d.rows?reconcileRows(normalizeRows(d.rows),old.rows):old.rows;Object.assign(old,{name:String(d.name||old.name).trim(),rows,columns:[...new Set(['case_id',...rows.flatMap(r=>Object.keys(r))])],version:old.version+1,updatedAt:now()});store.save();return json(200,old);}
 if(req.method==='DELETE'&&parts[2]){get('datasets',parts[2]);store.state.datasets=store.state.datasets.filter(d=>d.id!==parts[2]);store.save();return json(200,{ok:true});}}
 if(['agents','rubrics'].includes(parts[1])){
 if(req.method==='POST'&&!parts[2])return json(200,saveConfig(parts[1],await body(req),parts[1]==='agents'?defaultAgent:defaultRubric,parts[1]==='agents'?validateAgent:validateRubric));
 if(req.method==='DELETE'&&parts[2]){get(parts[1],parts[2]);store.state[parts[1]]=store.state[parts[1]].filter(c=>c.id!==parts[2]);store.save();return json(200,{ok:true});}}
 if(path==='/api/presets/sales'&&req.method==='POST'){
 let dataset=store.state.datasets.find(d=>d.name==='成交转化Agent · 50条合成案例');if(!dataset){const rows=reconcileRows(normalizeRows(JSON.parse(await readFile(join(root,'templates','sales-cases.json'),'utf8'))));dataset={id:uid(),name:'成交转化Agent · 50条合成案例',version:1,rows,columns:Object.keys(rows[0]),createdAt:now(),updatedAt:now()};store.state.datasets.push(dataset);store.save();}
 return json(200,{datasetId:dataset.id});
 }
 if(path==='/api/import-curl'&&req.method==='POST'){const {curl}=await body(req);const value=String(curl||'');const u=value.match(/https?:\/\/[^\s'"\\]+/);if(!u)fail('cURL中未找到URL。');const headers={};for(const m of value.matchAll(/(?:-H|--header)\s+(['"])(.*?)\1/g)){const i=m[2].indexOf(':');if(i>0)headers[m[2].slice(0,i).trim()]=m[2].slice(i+1).trim();}const raw=value.match(/(?:--data-raw|--data|-d)\s+(['"])([\s\S]*?)\1/);if(raw)objectJson(raw[2],'cURL请求体');return json(200,{url:u[0],method:value.match(/(?:-X|--request)\s+([A-Z]+)/)?.[1]||(raw?'POST':'GET'),headers:JSON.stringify(headers,null,2),requestTemplate:raw?.[2]||'{}'});}
 if(path==='/api/preflight'&&req.method==='POST')return json(200,(await plan(await body(req))).result);
 if(path==='/api/preview'&&req.method==='POST'){const task=await startTask(await body(req),true);return json(201,{id:task.id});}
 if(path==='/api/generate'&&req.method==='POST'){const d=await body(req),rubric=get('rubrics',d.rubricId);const count=Number(d.count);if(!Number.isInteger(count)||count<1||count>100)fail('单次生成1–100条。');if(!d.scene?.trim())fail('请描述业务场景。');const target=d.agentId?get('agents',d.agentId):null;const structured=target?.adapterType==='sales';const messages=[{role:'system',content:'你是评测数据设计员。生成合成案例，覆盖正常、困难和边界场景。只返回JSON对象{"cases":[{"case_id":"C001","user_input":"用户原话","context":"本例模拟资料","criteria":"明确可核对的应做到及不得行为","category":"场景类别","difficulty":"normal或hard","instruction":"任务要求"}]}。不得生成Agent实际回答。困难案例不是已确认Bad Case。不得使用真实个人数据。每条资料按案例独立提供。'},{role:'user',content:`场景：${d.scene}\n生成${count}条不重复案例。包含资料缺失、过期、不适用、多轮状态、联系边界和事实一致性场景。案例中的预期行为需有业务依据。`}];if(structured)messages[0].content+=' 每条案例还必须有case_json对象，结构为{case_id,as_of:"'+new Date().toISOString().slice(0,10)+'",input:{intent:"analyze",instruction:"任务指令",customer:{name:"合成客户"},history:[{id:"m1",role:"customer",text:"与user_input一致的客户原话"}],knowledge:[{id:"独立资料ID",title:"标题",content:"资料正文",enabled:true,validUntil:"YYYY-MM-DD"}],previous:null}}。没有资料时knowledge为空数组。历史消息role只允许customer和sales，事实与来源明确；context应包含该案例所有模拟资料及状态，方便独立判题。';const r=await completeModel(rubric,messages);let parsed;try{parsed=JSON.parse(r.content.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{fail('模型未返回有效案例JSON，请调整场景后重试。');}const rows=normalizeRows(parsed.cases);if(rows.length!==count)fail(`模型生成${rows.length}条，与要求${count}条不一致，请重试。`);if(rows.some(r=>!r.user_input||!r.criteria))fail('生成案例缺少输入或判定要求。');if(structured)for(const row of rows){let c;try{c=JSON.parse(row.case_json);}catch{fail('模型未生成结构化Agent所需的case_json，请重试。');}const input=c?.input;if(!input||input.intent!=='analyze'||!input.customer||!Array.isArray(input.history)||!input.history.length||input.history.some(m=>!m.id||!['customer','sales'].includes(m.role)||!m.text?.trim())||!Array.isArray(input.knowledge)||!/^\d{4}-\d{2}-\d{2}$/.test(c.as_of||''))fail('生成的Agent案例结构不完整，请重试。');if(input.knowledge.some(k=>!k.id||!k.title||!k.content||typeof k.enabled!=='boolean'))fail('生成资料缺少有效字段，请重试。');c.case_id=row.case_id;row.case_json=JSON.stringify(c);}return json(200,{rows:reconcileRows(rows),usage:r.usage});}
 if(parts[1]==='tasks'){
 if(req.method==='POST'&&!parts[2]){const task=await startTask(await body(req));return json(201,{id:task.id});}
 if(parts[2]&&req.method==='GET'){const t=get('tasks',parts[2]);if(parts[3]==='export'){const type=url.searchParams.get('format')||'md',rows=reportRows(cleanTask(t));if(type==='csv')return download(csv(rows,Object.keys(rows[0])),'text/csv; charset=utf-8',`${t.name}.csv`);if(type==='xlsx'){const wb=XLSX.utils.book_new();const sheetRows=rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):v])));XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(sheetRows),'评测结果');return download(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',`${t.name}.xlsx`);}if(type==='json')return download(JSON.stringify(cleanTask(t),null,2),'application/json',`${t.name}.json`);return download(markdown(cleanTask(t)),'text/markdown; charset=utf-8',`${t.name}.md`);}return json(200,cleanTask(t));}
 if(parts[2]&&req.method==='POST'){const t=get('tasks',parts[2]),d=await body(req);if(parts[3]==='control'){
  const executionActions=['resume','retry','rescore'];
  if(Object.hasOwn(d,'concurrency')){validateConcurrency(d.concurrency);if(!executionActions.includes(d.action))fail('请暂停或停止任务后，再设置下次运行的并行条数。');}
  if(executionActions.includes(d.action))requireIdle(t);
  const concurrency=executionActions.includes(d.action)?executionConcurrency(d,t.snapshot.agent,d.action==='rescore'?'existing':t.mode,t):taskConcurrency(t);
  if(d.action==='pause'&&t.status==='running')runner.pause(t.id);
  else if(d.action==='stop')runner.stop(t.id);
  else if(d.action==='resume'&&['paused','interrupted','stopped'].includes(t.status)){await requireTaskService(t);requireIdle(t);applyConcurrency(t,concurrency,d.action);runner.resume(t.id);}
  else if(d.action==='retry'){await requireTaskService(t);requireIdle(t);applyConcurrency(t,concurrency,d.action);runner.retry(t.id);}
  else if(d.action==='rescore'){
   if(!d.rubricId)fail('请选择本次重评标准。');const r=get('rubrics',d.rubricId);if(!r.baseUrl||!r.model||!r.enabled)fail('评分标准尚未配置。');
   if(t.rows.some(row=>!String(row.input[r.referenceColumn]||'').trim()))fail('新评分标准对应的判定要求列缺失。');
   const fresh={...copy(t),continuedTaskId:null,trialId:null,reusedCases:0,reusedScores:0,id:uid(),name:t.name+' · 重新评分',createdAt:now(),completedAt:null,status:'running',mode:'existing',concurrency,executionChanges:[],parentTaskId:t.id};
   fresh.snapshot.rubric=copy(r);fresh.snapshot.execution={concurrency};fresh.rows=t.rows.map(row=>({...copy(row),id:uid(),judgment:null,review:null,judgeRaw:null,judgePrompt:null,error:row.answer?null:row.error||'无有效回答，无法重新评分。',status:row.answer?'pending':'error'}));store.state.tasks.unshift(fresh);store.save();runner.run(fresh.id);return json(200,{id:fresh.id});
  }else fail('当前状态不支持该操作。');return json(200,{ok:true,concurrency:taskConcurrency(t)});
 }
 if(parts[3]==='review'){const row=t.rows.find(r=>r.id===d.rowId);if(!row?.answer?.trim())fail('该案例尚未获得有效Agent回答。');if(!['bad','normal','disputed'].includes(d.decision))fail('请选择复核结论。');if(d.decision==='bad'&&(!d.issueType?.trim()||!d.attribution?.trim()))fail('确认Bad Case时，请填写问题类型与归因。');if(d.attributionStatus&&!['confirmed','pending'].includes(d.attributionStatus))fail('归因状态无效。');row.review={decision:d.decision,attributionStatus:d.attributionStatus||'pending',issueType:String(d.issueType||''),attribution:String(d.attribution||''),note:String(d.note||''),updatedAt:now()};store.save();return json(200,{ok:true,summary:summary(t)});}}
 if(parts[2]&&req.method==='DELETE'){get('tasks',parts[2]);if(runner.busy(parts[2]))fail('请先停止任务并等待调用结束。');store.state.tasks=store.state.tasks.filter(t=>t.id!==parts[2]);store.save();return json(200,{ok:true});}}
 fail('接口不存在。',404);
 }catch(e){if(e.retryAfterSeconds&&!res.headersSent)res.setHeader('Retry-After',String(e.retryAfterSeconds));if(!res.headersSent)json(e.status||400,{error:e.message||'操作失败。',...(e.code?{code:e.code}:{})});else res.end();}});
 return {server,store,runner,auth};}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const port=Number(process.env.EVAL_PORT||4189),app=createApp({dataDir:process.env.EVAL_DATA_DIR||join(root,'.data')});app.server.listen(port,'127.0.0.1',()=>console.log(`Eval Studio 已启动：http://127.0.0.1:${port}`));}

import XLSX from 'xlsx';
export const MAX_CASES=2000;
export const MAX_CONCURRENCY=50;
export const DEFAULT_CONCURRENCY=3;
export function validateConcurrency(value){if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>MAX_CONCURRENCY)fail('并行条数须为1到50的整数。');return value;}
export function taskConcurrency(task){const value=task.concurrency??task.snapshot?.agent?.concurrency??2;return task.mode==='agent'&&task.snapshot?.agent?.sessionMode==='dataset'?1:(Number.isInteger(value)&&value>=1&&value<=MAX_CONCURRENCY?value:2);}
export function fail(message,status=400){const e=new Error(message);e.status=status;throw e;}
export function objectJson(value,label){try{const result=typeof value==='string'?JSON.parse(value):value;if(!result||Array.isArray(result)||typeof result!=='object')throw Error();return result;}catch{fail(`${label}必须是合法的JSON对象。`);}}
export function getPath(obj,path){if(path==='$')return obj;let p=String(path||'').replace(/^\$\.?/,'').replace(/\[(\d+)\]/g,'.$1');if(/[\[\]*?]/.test(p))return undefined;return p.split('.').filter(Boolean).reduce((v,k)=>['__proto__','constructor','prototype'].includes(k)?undefined:v?.[k],obj);}
export function stringify(x){return typeof x==='string'?x:x==null?'':JSON.stringify(x);}
export function render(text,vars){return String(text??'').replace(/{{\s*([^{}]+?)\s*}}/g,(_,k)=>stringify(getPath(vars,k)));}
export function template(x,vars){if(typeof x==='string'){const m=x.match(/^{{\s*([^{}]+?)\s*}}$/);if(m){const v=getPath(vars,m[1]);if(v!==undefined)return v;}return render(x,vars);}if(Array.isArray(x))return x.map(v=>template(v,vars));if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,template(v,vars)]));return x;}
export function normalizeRows(rows){if(!Array.isArray(rows)||!rows.length)fail('至少需要一条案例。');if(rows.length>MAX_CASES)fail(`单批最多${MAX_CASES}条案例。`);const ids=new Set();return rows.map((r,i)=>{if(!r||Array.isArray(r)||typeof r!=='object')fail(`第${i+1}行不是有效案例。`);const clean=Object.fromEntries(Object.entries(r).filter(([k])=>k&&!['__proto__','constructor','prototype'].includes(k)).map(([k,v])=>[k,stringify(v)]));clean.case_id=String(clean.case_id||`C${String(i+1).padStart(3,'0')}`);if(ids.has(clean.case_id))fail(`案例ID重复：${clean.case_id}`);ids.add(clean.case_id);if(Object.values(clean).some(v=>v.length>100000))fail(`第${i+1}行内容过长。`);return clean;});}
export function importFile(name,base64){if(!/\.(csv|xlsx|xls)$/i.test(name||''))fail('支持CSV、XLSX和XLS文件。');const bytes=Buffer.from(base64||'','base64');if(bytes.length>6*1024*1024)fail('文件请控制在6MB以内。');try{const workbook=XLSX.read(bytes,{type:'buffer',codepage:65001});const sheet=workbook.Sheets[workbook.SheetNames[0]];const headers=XLSX.utils.sheet_to_json(sheet,{header:1,defval:''})[0]?.map(v=>String(v).trim())||[];if(!headers.length||headers.some(v=>!v)||new Set(headers).size!==headers.length)fail('表头不能为空或重复。');const rows=XLSX.utils.sheet_to_json(sheet,{header:headers,range:1,defval:'',raw:false});return {columns:[...new Set(['case_id',...headers])],rows:normalizeRows(rows.filter(r=>Object.values(r).some(v=>String(v).trim())))};}catch(e){if(e.status)throw e;fail('无法解析文件，请检查格式、首行表头和内容。');}}
export function csv(rows,columns){return '\ufeff'+[columns,...rows.map(r=>columns.map(k=>r[k]??''))].map(row=>row.map(v=>{let s=stringify(v);if(/^[=+\-@]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(',')).join('\r\n');}
export function numeric(v,min,max,label){const n=Number(v);if(!Number.isFinite(n)||n<min||n>max)fail(`${label}应在${min}到${max}之间。`);return n;}
export function urlCheck(u,label){try{const parsed=new URL(u);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw Error();}catch{fail(`${label}需要有效的HTTP或HTTPS地址。`);}}
export function validateAgent(c){if(c.adapterType!=null&&!['generic','sales'].includes(c.adapterType))fail('Agent适配类型无效。');if(!String(c.name||'').trim())fail('请填写Agent名称。');urlCheck(c.url,'Agent接口');if(!['POST','GET','PUT','PATCH'].includes(c.method))fail('请求方式无效。');objectJson(c.headers,'Header');objectJson(c.inputBindings,'输入绑定');objectJson(c.requestTemplate,'请求模板');objectJson(c.extractRules,'输出提取规则');if(!c.outputPath)fail('请填写回答提取路径。');c.timeoutMs=numeric(c.timeoutMs,1000,300000,'超时');c.idleTimeoutMs=numeric(c.idleTimeoutMs,1000,300000,'空闲超时');c.retries=numeric(c.retries,0,3,'重试次数');c.concurrency=validateConcurrency(c.concurrency);if(!['per_case','dataset'].includes(c.sessionMode))fail('会话策略无效。');if(!['auto','json','sse','ndjson','text'].includes(c.protocol))fail('响应协议无效。');return c;}
export function dimensionRules(config){
 if(config.dimensionRules==null)return [];
 let rules=config.dimensionRules;
 if(typeof rules==='string'){try{rules=JSON.parse(rules);}catch{fail('分项评分规则必须是JSON数组。');}}
 if(!Array.isArray(rules))fail('分项评分规则必须是数组。');
 const keys=new Set();
 for(const rule of rules){
  if(!rule||typeof rule!=='object'||!String(rule.key||'').trim()||['__proto__','constructor','prototype'].includes(rule.key)||keys.has(rule.key)||!String(rule.label||'').trim()||!String(rule.rule||'').trim())fail('每个评分分项须有唯一key、名称和判定规则。');
  if(typeof rule.max!=='number'||!Number.isFinite(rule.max)||rule.max<=0)fail('评分分项的满分必须是大于0的数值。');
  keys.add(rule.key);
 }
 if(rules.length&&Math.abs(rules.reduce((sum,rule)=>sum+rule.max,0)-(Number(config.scoreMax)-Number(config.scoreMin)))>1e-6)fail('各评分分项满分之和必须等于最高分减最低分。');
 return rules;
}
export function validateRubric(c){if(!c.name?.trim())fail('请填写评分标准名称。');if(c.baseUrl)urlCheck(c.baseUrl,'评判模型Base URL');c.scoreMin=numeric(c.scoreMin,-100000,100000,'最低分');c.scoreMax=numeric(c.scoreMax,-100000,100000,'最高分');if(c.scoreMax<=c.scoreMin)fail('最高分必须大于最低分。');c.passThreshold=numeric(c.passThreshold,c.scoreMin,c.scoreMax,'通过阈值');c.timeoutMs=numeric(c.timeoutMs,1000,300000,'评判超时');if(!c.systemPrompt?.trim()||!c.userPrompt?.trim()||!c.dimensions?.trim())fail('请填写评分维度和评判提示词。');if(c.dimensionRules!=null)c.dimensionRules=dimensionRules(c);return c;}
export function judgeJson(text,config){
 const s=String(text).trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');let j;
 try{j=JSON.parse(s);}catch{throw Error('评判模型未返回合法JSON，请调整提示词后只重试评分。');}
 if(!j||typeof j.score!=='number'||!Number.isFinite(j.score)||j.score<config.scoreMin||j.score>config.scoreMax||typeof j.passed!=='boolean'||typeof j.veto_triggered!=='boolean'||typeof j.uncertain!=='boolean'||typeof j.reason!=='string'||!j.reason.trim()||!Array.isArray(j.evidence)||j.evidence.some(x=>typeof x!=='string'))throw Error('评分结果缺少合法的score、passed、reason或evidence字段。');
 const rules=dimensionRules(config);
 const dimensions=j.dimensions&&typeof j.dimensions==='object'&&!Array.isArray(j.dimensions)?j.dimensions:{};
 if(rules.length){
  if(Object.keys(dimensions).length!==rules.length)throw Error('评分结果必须包含全部配置分项，且不能有额外分项。');
  let sum=Number(config.scoreMin);
  for(const rule of rules){const item=dimensions[rule.key];
   if(!item||Array.isArray(item)||typeof item.score!=='number'||!Number.isFinite(item.score)||item.score<0||item.score>rule.max||typeof item.reason!=='string'||!item.reason.trim()||!Array.isArray(item.evidence)||item.evidence.some(v=>typeof v!=='string'))throw Error(`评分分项「${rule.label}」须包含合法score、reason和evidence。`);
   if(item.score<rule.max&&!item.evidence.some(v=>v.trim()))throw Error(`评分分项「${rule.label}」扣分时必须提供证据。`);
   sum+=item.score;
  }
  if(Math.abs(sum-j.score)>1e-6)throw Error(`分项得分之和与总分不一致（应为${sum}，返回${j.score}）。请只重试评分。`);
 }
 const uncertain=j.uncertain===true,veto=j.veto_triggered===true,passed=!uncertain&&j.passed&&j.score>=config.passThreshold&&!veto;
 return {score:j.score,passed,verdict:uncertain?'uncertain':passed?'passed':'not_passed',reason:j.reason,evidence:j.evidence,veto_triggered:veto,uncertain,dimensions,dimensionValidated:rules.length>0};
}

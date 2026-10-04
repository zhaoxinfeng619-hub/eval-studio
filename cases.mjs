import { isDeepStrictEqual } from 'node:util';
import { fail, getPath, normalizeRows, render, stringify } from './core.mjs';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const blank = value => value == null || (typeof value === 'string' && !value.trim());
const same = isDeepStrictEqual;
const optionalBindings = new Set(['context', 'instruction']);
const reservedKeys = new Set(['__proto__', 'constructor', 'prototype']);
const inputDefaults = input => ({ ...input, instruction: input.instruction ?? '', previous: input.previous ?? null });
const lastCustomer = c => Array.isArray(c?.input?.history) ? c.input.history.findLast(m => m?.role === 'customer') : undefined;
const contextOf = c => ({ as_of: c.as_of, ...inputDefaults(c.input) });

function parseObject(value, label) {
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : structuredClone(value); }
  catch { fail(`${label}必须是合法的 JSON 对象。`); }
  if (!object(parsed)) fail(`${label}必须是合法的 JSON 对象。`);
  return parsed;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Return every structural error without changing the supplied sales case. */
export function validateCase(value) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  let c;
  try { c = parseObject(value, 'case_json'); }
  catch (error) { return [{ field: 'case_json', message: error.message }]; }
  if (!validDate(c.as_of)) add('case_json.as_of', '评测日期须是有效的 YYYY-MM-DD 日期。');
  if (!object(c.input)) {
    add('case_json.input', '缺少完整的 Agent 输入对象。');
    return errors;
  }
  const input = c.input;
  if (!['analyze', 'rewrite'].includes(input.intent)) add('case_json.input.intent', '任务类型须为 analyze 或 rewrite。');
  if (!object(input.customer)) add('case_json.input.customer', '客户背景须是对象。');
  if (!Array.isArray(input.history) || !input.history.length || input.history.length > 50) {
    add('case_json.input.history', '沟通历史须包含 1 至 50 条消息。');
  } else {
    const ids = new Set();
    input.history.forEach((message, index) => {
      const field = `case_json.input.history[${index}]`;
      if (!object(message)) { add(field, '消息须是对象。'); return; }
      if (typeof message.id !== 'string' || !message.id.trim()) add(`${field}.id`, '每条消息须有非空的字符串 ID。');
      else if (ids.has(message.id)) add(`${field}.id`, '消息 ID 重复，无法准确关联原话证据。');
      else ids.add(message.id);
      if (!['customer', 'sales'].includes(message.role)) add(`${field}.role`, '消息角色须为 customer 或 sales。');
      if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 4000) add(`${field}.text`, '消息正文须为 1 至 4000 个字符。');
    });
  }
  if (input.instruction != null && (typeof input.instruction !== 'string' || input.instruction.length > 500)) add('case_json.input.instruction', '任务指令须为字符串且不超过 500 个字符，以免接口截断。');
  if (input.intent === 'rewrite') {
    for (const key of ['understanding', 'decision', 'assistance']) {
      if (!object(input.previous?.[key])) add(`case_json.input.previous.${key}`, `改写案例须提供上一轮的 ${key}，用于核对哪些内容应保持不变。`);
    }
  }
  if (!Array.isArray(input.knowledge) || input.knowledge.length > 20) {
    add('case_json.input.knowledge', '资料须是最多 20 条的数组；无资料时填写 []。');
  } else {
    const ids = new Set();
    input.knowledge.forEach((document, index) => {
      const field = `case_json.input.knowledge[${index}]`;
      if (!object(document)) { add(field, '每条资料须是对象。'); return; }
      if (typeof document.enabled !== 'boolean') add(`${field}.enabled`, '资料启用状态须为 true 或 false。');
      if (!blank(document.validUntil) && !validDate(document.validUntil)) add(`${field}.validUntil`, '资料有效期须是有效的 YYYY-MM-DD 日期。');
      // The sales adapter excludes disabled and expired documents before use.
      const available = document.enabled === true && (!document.validUntil || document.validUntil >= c.as_of);
      if (available) {
        if (typeof document.id !== 'string' || !document.id.trim()) add(`${field}.id`, '可用资料须有字符串 ID。');
        if (typeof document.title !== 'string' || !document.title.trim()) add(`${field}.title`, '可用资料须有标题。');
        if (typeof document.content !== 'string' || !document.content.trim()) add(`${field}.content`, '可用资料须有正文。');
      }
      if (document.id) {
        if (ids.has(document.id)) add(`${field}.id`, '资料 ID 重复，无法准确关联引用。');
        ids.add(document.id);
      }
    });
  }
  return errors;
}

/** Keep editable display fields and the adapter payload on one source of truth. */
export function reconcileRows(rows, previousRows = []) {
  const previous = new Map(previousRows.map(row => [String(row.case_id), row]));
  return normalizeRows(rows).map(row => {
    if (own(row, 'reference_output') && own(row, 'criteria')) row.reference_output = row.criteria;
    if (blank(row.case_json)) return row;
    const label = `案例 ${row.case_id}`;
    const c = parseObject(row.case_json, `${label} 的 case_json`);
    if (!object(c.input)) fail(`${label} 的 case_json.input 须是对象。`);
    c.input = inputDefaults(c.input);
    const old = previous.get(row.case_id) ?? previous.get(String(c.case_id));
    let baseline;
    if (!blank(old?.case_json)) {
      baseline = parseObject(old.case_json, `${label} 原有的 case_json`);
      if (!object(baseline.input)) fail(`${label} 原有的 case_json.input 须是对象。`);
      baseline.input = inputDefaults(baseline.input);
    }
    const conflict = field => fail(`${label} 的 ${field} 与 case_json 同时修改且内容冲突，请保持两处一致后保存。`);
    if (baseline) {
      const changedCase = !same(c, baseline);
      const changedContext = own(row, 'context') && row.context !== stringify(old.context);
      if (changedContext) {
        const next = parseObject(row.context, `${label} 的 context`);
        if (own(next, 'input')) fail(`${label} 的 context 请直接填写 as_of、history、customer、knowledge、instruction、previous 等字段，不要再嵌套 input。`);
        let before;
        try { before = parseObject(old.context, '原有 context'); }
        catch { before = contextOf(baseline); }
        for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
          if (reservedKeys.has(key)) fail(`${label} 的 context 包含不支持的字段 ${key}。`);
          if (same(before[key], next[key]) && own(before, key) === own(next, key)) continue;
          const priorValue = key === 'as_of' ? baseline.as_of : baseline.input[key];
          const currentValue = key === 'as_of' ? c.as_of : c.input[key];
          if (changedCase && !same(priorValue, currentValue) && !same(currentValue, next[key])) conflict(`context.${key}`);
          const target = key === 'as_of' ? c : c.input;
          if (own(next, key)) target[key] = structuredClone(next[key]);
          else delete target[key];
        }
      }
      if (own(row, 'user_input') && row.user_input !== stringify(old.user_input)) {
        const current = lastCustomer(c), original = lastCustomer(baseline);
        if (!current) fail(`${label} 没有客户消息，无法同步用户输入；请在沟通历史中添加 customer 消息。`);
        if (current.text !== original?.text && current.text !== row.user_input) conflict('user_input');
        current.text = row.user_input;
      }
    }
    c.case_id = row.case_id;
    c.input = inputDefaults(c.input);
    const errors = validateCase(c);
    if (errors.length) fail(`${label}：${errors.map(error => `${error.field}：${error.message}`).join('；')}`);
    row.case_json = JSON.stringify(c);
    row.user_input = lastCustomer(c)?.text ?? '';
    row.context = JSON.stringify(contextOf(c));
    if (own(row, 'as_of')) row.as_of = c.as_of;
    if (own(row, 'instruction')) row.instruction = c.input.instruction;
    return row;
  });
}

const placeholders = value => [...String(value ?? '').matchAll(/{{\s*([^{}]+?)\s*}}/g)].map(match => match[1]);

/** Check the entire batch before any Agent/model request is made. */
export function preflightRows(rows, agent, rubric, mode = 'agent', answerColumn = 'actual_output') {
  const errors = [], warnings = [], seen = new Set();
  const add = (caseId, field, message) => {
    const key = JSON.stringify([caseId, field, message]);
    if (!seen.has(key)) { seen.add(key); errors.push({ caseId, field, message }); }
  };
  if (!Array.isArray(rows) || !rows.length) return { ready: false, errors: [{ caseId: '', field: 'dataset', message: '评测集至少需要一条案例。' }], warnings };
  const referenceColumn = rubric?.referenceColumn || 'criteria';
  let bindings = {}, templateFields = [];
  if (mode !== 'existing') {
    if (!agent) add('', 'agent', '请选择待评测 Agent。');
    else {
      try { bindings = parseObject(agent.inputBindings ?? '{}', 'Agent 输入字段绑定'); }
      catch (error) { add('', 'inputBindings', error.message); }
      for (const field of ['headers', 'requestTemplate']) {
        try { parseObject(agent[field] ?? '{}', `Agent ${field}`); }
        catch (error) { add('', field, error.message); }
      }
      templateFields = ['systemPrompt', 'userPrompt', 'headers', 'requestTemplate'].flatMap(field => placeholders(agent[field]).map(variable => ({ field, variable })));
    }
  }
  const caseIds = new Set();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], caseId = String(row?.case_id || `第 ${index + 1} 条`);
    if (!object(row)) { add(caseId, 'case', '案例须是对象。'); continue; }
    if (caseIds.has(caseId)) add(caseId, 'case_id', '案例 ID 重复。');
    caseIds.add(caseId);
    if (blank(row[referenceColumn])) add(caseId, referenceColumn, `缺少判定要求列「${referenceColumn}」的内容。`);
    if (mode === 'existing') {
      if (blank(row[answerColumn])) add(caseId, answerColumn, `已有回答列「${answerColumn}」为空。`);
      continue;
    }
    if (!agent) continue;
    const vars = { input: row, api_key: agent.apiKey || '', session_id: '独立会话' };
    const invalidBindings = new Set();
    for (const [key, column] of Object.entries(bindings)) {
      if (reservedKeys.has(key) || typeof column !== 'string' || !column.trim()) {
        add(caseId, `inputBindings.${key}`, '绑定值须为非空的数据集字段路径。');
        invalidBindings.add(key);
        continue;
      }
      vars[key] = getPath(row, column);
      if (blank(vars[key]) && !optionalBindings.has(key)) {
        add(caseId, column, `Agent 变量「${key}」所需的列「${column}」缺失或为空。`);
        invalidBindings.add(key);
      }
    }
    if (agent.sessionMode === 'dataset') {
      const column = agent.sessionColumn || 'session_id';
      vars.session_id = row[column];
      if (blank(vars.session_id)) add(caseId, column, `复用会话需要非空的「${column}」。`);
    }
    vars.system_prompt = render(agent.systemPrompt, vars);
    vars.user_prompt = render(agent.userPrompt, vars);
    for (const { field, variable } of templateFields) {
      const normalized = variable.replace(/^\$\.?/, '');
      const top = normalized.split(/[.[]/)[0];
      if (invalidBindings.has(top)) continue;
      const optional = ['api_key', 'system_prompt', 'user_prompt'].includes(normalized) || optionalBindings.has(normalized) || ['input.context', 'input.instruction'].includes(normalized);
      if (!optional && blank(getPath(vars, variable))) add(caseId, `${field}.${variable}`, `模板变量「${variable}」未取得有效值，请检查输入绑定或数据列。`);
    }
    if (agent.adapterType === 'sales') {
      if (blank(row.case_json)) {
        if (!invalidBindings.has('case_json')) add(caseId, 'case_json', '成交 Agent 需要结构化 case_json，请使用对应模板或重新生成案例。');
      } else {
        for (const error of validateCase(row.case_json)) add(caseId, error.field, error.message);
        let c;
        try { c = parseObject(row.case_json, 'case_json'); } catch { continue; }
        if (object(c.input)) {
          if (own(row, 'user_input') && row.user_input !== (lastCustomer(c)?.text ?? '')) add(caseId, 'user_input', '页面用户输入与 case_json 中最后一条客户消息不一致，请重新保存案例以同步。');
          try {
            const context = parseObject(row.context, 'context'), canonical = contextOf(c);
            for (const [key, value] of Object.entries(context)) {
              if (!same(value, canonical[key])) add(caseId, `context.${key}`, '页面上下文与 Agent 实际输入不一致，请重新保存案例以同步。');
            }
            const missing = Object.keys(canonical).filter(key => !own(context, key));
            if (missing.length) warnings.push({ caseId, field: 'context', message: `上下文未展开 ${missing.join('、')}，请使用完整案例输入进行评分。` });
          } catch { add(caseId, 'context', '结构化案例的上下文须与 case_json 同步，请重新保存案例。'); }
          for (let i = 0; i < (c.input.knowledge?.length || 0); i++) {
            if (typeof c.input.knowledge[i]?.content === 'string' && c.input.knowledge[i].content.length > 6000) warnings.push({ caseId, field: `case_json.input.knowledge[${i}].content`, message: '资料正文超过 6000 个字符，成交 Agent 接口只读取前 6000 个字符。' });
          }
        }
      }
    }
  }
  return { ready: errors.length === 0, errors, warnings };
}

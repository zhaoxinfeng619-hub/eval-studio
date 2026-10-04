import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reconcileRows, validateCase, preflightRows } from '../cases.mjs';

const sales = {
  name: '可以任意改名', adapterType: 'sales', inputBindings: '{"case_json":"case_json"}',
  headers: '{}', requestTemplate: '{"case_json":"{{case_json}}"}', systemPrompt: '', userPrompt: '',
};
const rubric = { referenceColumn: 'criteria' };
const sample = () => ({
  case_id: 'N01', as_of: '2026-09-30', input: {
    intent: 'analyze', instruction: '', customer: { name: '合成客户' },
    history: [{ id: 'm1', role: 'customer', text: '孩子五年级，英语阅读慢。' }],
    knowledge: [{ id: 'k1', title: '课表', content: '英语课每周六。', enabled: true, validUntil: '2026-12-31' }],
    previous: null,
  },
});
const row = () => reconcileRows([{
  case_id: 'N01', case_json: JSON.stringify(sample()), user_input: '待派生', context: '待派生',
  criteria: '准确保留学段与需求，不编造。', reference_output: '过时判据', custom_tag: '保留此列',
}])[0];

test('结构化案例统一来源：初始导入、用户输入修改、资料修改与判据同步', () => {
  const old = row();
  assert.equal(old.user_input, '孩子五年级，英语阅读慢。');
  assert.equal(old.reference_output, old.criteria);
  assert.equal(old.custom_tag, '保留此列');
  assert.deepEqual(JSON.parse(old.context), { as_of: sample().as_of, ...sample().input });
  const changed = { ...old, user_input: '孩子六年级，数学几何薄弱。', criteria: '保留六年级数学需求。' };
  const saved = reconcileRows([changed], [old])[0];
  assert.equal(JSON.parse(saved.case_json).input.history[0].text, changed.user_input);
  assert.equal(JSON.parse(saved.context).history[0].text, changed.user_input);
  assert.equal(saved.reference_output, changed.criteria);
  assert.equal(JSON.parse(old.case_json).input.history[0].text, '孩子五年级，英语阅读慢。', '不得修改传入的旧行');

  const context = JSON.parse(saved.context);
  context.knowledge[0].content = '数学课每周日。';
  context.instruction = '根据本例资料回答。';
  const updated = reconcileRows([{ ...saved, context: JSON.stringify(context) }], [saved])[0];
  assert.equal(JSON.parse(updated.case_json).input.knowledge[0].content, context.knowledge[0].content);
  assert.equal(JSON.parse(updated.case_json).input.instruction, context.instruction);
  assert.equal(preflightRows([updated], sales, rubric).ready, true);
});

test('仅有 reference_output 的上传表保留原判据，显式 criteria 修改才同步', () => {
  const imported = reconcileRows([{ case_id: 'C1', user_input: '课程价格是多少？', reference_output: '依据资料报价。' }])[0];
  assert.equal(imported.reference_output, '依据资料报价。');
  assert.equal(Object.hasOwn(imported, 'criteria'), false);
  const structured = reconcileRows([{ case_id: 'N01', case_json: JSON.stringify(sample()), reference_output: '保留客户事实。' }])[0];
  assert.equal(structured.reference_output, '保留客户事实。');
  assert.equal(preflightRows([structured], sales, { referenceColumn: 'reference_output' }).ready, true);
  const changed = reconcileRows([{ ...imported, criteria: '新的判据' }], [imported])[0];
  assert.equal(changed.reference_output, '新的判据');
});

test('同时重命名案例 ID 与修改输入时，按结构中原 ID 找到旧值并同步', () => {
  const old = row();
  const renamed = reconcileRows([{ ...old, case_id: 'N51', user_input: '孩子初二，物理概念不清楚。' }], [old])[0];
  assert.equal(renamed.case_id, 'N51');
  assert.equal(JSON.parse(renamed.case_json).case_id, 'N51');
  assert.equal(JSON.parse(renamed.case_json).input.history[0].text, renamed.user_input);
  assert.equal(JSON.parse(renamed.context).history[0].text, renamed.user_input);
  assert.equal(preflightRows([renamed], sales, rubric).ready, true);
});

test('结构与显示同时编辑：拒绝冲突，接受相同值和不相交的修改', () => {
  const old = row();
  const c = JSON.parse(old.case_json);
  c.input.history[0].text = '孩子初一，数学基础薄弱。';
  assert.throws(() => reconcileRows([{ ...old, case_json: JSON.stringify(c), user_input: '孩子初二，英语困难。' }], [old]), /user_input.*冲突/);
  const same = reconcileRows([{ ...old, case_json: JSON.stringify(c), user_input: c.input.history[0].text }], [old])[0];
  assert.equal(same.user_input, c.input.history[0].text);

  const context = JSON.parse(old.context);
  context.knowledge[0].content = '数学课每周日。';
  const merged = reconcileRows([{ ...old, case_json: JSON.stringify(c), context: JSON.stringify(context) }], [old])[0];
  assert.equal(merged.user_input, c.input.history[0].text);
  assert.equal(JSON.parse(merged.case_json).input.knowledge[0].content, context.knowledge[0].content);

  const conflictingContext = JSON.parse(old.context);
  conflictingContext.history[0].text = '孩子三年级。';
  assert.throws(() => reconcileRows([{ ...old, case_json: JSON.stringify(c), context: JSON.stringify(conflictingContext) }], [old]), /context.history.*冲突/);
  assert.throws(() => reconcileRows([{ ...old, context: JSON.stringify(conflictingContext), user_input: '孩子四年级。' }], [old]), /user_input.*冲突/);
  assert.throws(() => reconcileRows([{ ...old, context: '英语价格99元' }], [old]), /context.*JSON/);
});

test('保留改写前结果，兼容旧版只包含部分字段的 context', () => {
  const c = sample();
  c.input.intent = 'rewrite';
  c.input.previous = { understanding: { summary: '原理解' }, decision: { action: '原动作' }, assistance: { suggestedReply: '原话术' } };
  const old = { ...row(), case_json: JSON.stringify(c), context: JSON.stringify({ as_of: c.as_of, history: c.input.history, knowledge: c.input.knowledge, customer: c.input.customer, instruction: '' }) };
  const context = JSON.parse(old.context);
  context.instruction = '缩短到一句话。';
  const saved = reconcileRows([{ ...old, context: JSON.stringify(context) }], [old])[0];
  assert.deepEqual(JSON.parse(saved.context).previous, c.input.previous);
  assert.deepEqual(JSON.parse(saved.case_json).input.previous, c.input.previous);
  assert.equal(JSON.parse(saved.case_json).input.instruction, context.instruction);
  const incomplete = JSON.parse(saved.context);
  delete incomplete.history;
  assert.throws(() => reconcileRows([{ ...saved, context: JSON.stringify(incomplete) }], [saved]), /history/);
});

test('预检一次报告所有缺失项，普通可选上下文与指令允许留空', () => {
  const generic = {
    inputBindings: '{"user_input":"question","context":"context","instruction":"instruction"}',
    headers: '{"Authorization":"Bearer {{api_key}}"}',
    systemPrompt: '', userPrompt: '{{user_input}}\n{{context}}\n{{instruction}}',
    requestTemplate: '{"messages":[{"content":"{{user_prompt}}"}]}',
  };
  assert.equal(preflightRows([{ case_id: 'C1', question: '你好', criteria: '不编造' }], generic, rubric).ready, true);
  const failed = preflightRows([{ case_id: 'C1', criteria: '' }, { case_id: 'C2', criteria: '不编造' }], generic, rubric);
  assert.equal(failed.ready, false);
  assert.equal(failed.errors.length, 3);
  assert(failed.errors.some(error => error.caseId === 'C1' && error.field === 'criteria'));
  assert(failed.errors.some(error => error.caseId === 'C1' && error.field === 'question'));
  assert(failed.errors.some(error => error.caseId === 'C2' && error.field === 'question'));
  const unknown = preflightRows([{ case_id: 'C1', question: '你好', criteria: '不编造' }], { ...generic, requestTemplate: '{"input":"{{input.missing}}"}' }, rubric);
  assert(unknown.errors.some(error => error.message.includes('input.missing')));
  const existing = preflightRows([{ case_id: 'C1', criteria: '' }, { case_id: 'C2', criteria: '不编造', answer: '回答' }], null, rubric, 'existing', 'answer');
  assert.equal(existing.errors.length, 2);
  assert(existing.errors.every(error => error.caseId === 'C1'));
});

test('sales 预检使用适配器类型，拦截缺失结构、显示错配、会话缺失', () => {
  const missing = preflightRows([{ case_id: 'C1', user_input: '你好', criteria: '不编造' }], sales, rubric);
  assert(missing.errors.some(error => error.field === 'case_json'));
  const bad = sample();
  bad.input.intent = 'rewrite';
  bad.input.previous = null;
  bad.input.history[0].role = 'assistant';
  bad.as_of = '2026-02-30';
  const errors = validateCase(bad);
  assert(errors.some(error => error.field === 'case_json.as_of'));
  assert(errors.some(error => error.field.endsWith('.role')));
  assert.equal(errors.filter(error => error.field.includes('.previous.')).length, 3);
  const mismatch = preflightRows([{ ...row(), user_input: '被单独修改的输入' }], sales, rubric);
  assert(mismatch.errors.some(error => error.field === 'user_input'));
  const session = preflightRows([row()], { ...sales, sessionMode: 'dataset', sessionColumn: 'conversation_id' }, rubric);
  assert(session.errors.some(error => error.field === 'conversation_id'));
});

test('全部 50 条既有案例可迁移，改写案例裁判上下文完整', async () => {
  const original = JSON.parse(await readFile(new URL('../templates/sales-cases.json', import.meta.url), 'utf8'));
  const rows = reconcileRows(original);
  assert.equal(rows.length, 50);
  assert.deepEqual(preflightRows(rows, sales, rubric), { ready: true, errors: [], warnings: [] });
  for (const id of ['N41', 'N42', 'N43', 'N44', 'N45']) {
    const row = rows.find(value => value.case_id === id);
    assert.deepEqual(JSON.parse(row.context).previous, JSON.parse(row.case_json).input.previous);
    assert.equal(JSON.parse(row.context).intent, 'rewrite');
  }
});

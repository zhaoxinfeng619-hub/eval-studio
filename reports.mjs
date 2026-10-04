import { summary } from './store.mjs';
export const verdict = j => !j ? '未完成评分' : j.uncertain ? '待确认' : j.passed ? '通过' : '未通过';
const percent = n => n == null ? '—' : `${(n * 100).toFixed(1)}%`;
export function reportRows(task) {
  return task.rows.map(r => ({
    case_id:r.input.case_id, category:r.input.category||r.input.scenario||'未分类',
    user_input:r.input.user_input||'', input_json:JSON.stringify(r.input), context:r.input.context||'',
    criteria:r.input[task.snapshot.rubric.referenceColumn]||'', actual_output:r.answer||'',
    score:r.judgment?.score??'', auto_verdict:verdict(r.judgment), auto_passed:r.judgment ? (!r.judgment.uncertain && r.judgment.passed) : '',
    uncertain:r.judgment?.uncertain??'', dimensions:r.judgment?.dimensions||{},
    reason:r.judgment?.reason||'', evidence:r.judgment?.evidence||[],
    review_decision:r.review?.decision||'', issue_type:r.review?.issueType||'',
    attribution:r.review?.attribution||'', attribution_status:r.review?.attributionStatus||'pending',
    review_note:r.review?.note||'', error:r.error||'', status:r.status
  }));
}
function quote(value) { return String(value||'无').split('\n').map(line=>'> '+line).join('\n'); }
function dimensionText(rubric) {
  return rubric.dimensionRules?.length ? rubric.dimensionRules.map(d=>`- ${d.label}：${d.max}分。${d.rule}`).join('\n') : rubric.dimensions;
}
export function markdown(t) {
  const s=summary(t), lines=[`# ${t.name}`, '', '## 背景与范围', '',
    `类型：${t.isTrial?'试跑':'正式评测'}；数据集：${t.snapshot.dataset.name}，版本${t.snapshot.dataset.version}；本次${s.total}条案例。`,
    `评测对象：${t.snapshot.agent?.name||'上传的已有回答'}；评分标准：${t.snapshot.rubric.name}，版本${t.snapshot.rubric.version}。`,
    `创建时间：${t.createdAt}；任务状态：${t.status}。`,
    `并行数量设置：${t.concurrency??t.snapshot.agent?.concurrency??2}条；实际同时处理数受剩余案例和全站50条上限约束。`,
    t.reusedCases?`复用试跑有效回答：${t.reusedCases}条。`:'', '', '## 指标与评分标准', '', dimensionText(t.snapshot.rubric), '',
    `必须失败条件：${t.snapshot.rubric.veto||'无'}。`,
    `分数范围：${t.snapshot.rubric.scoreMin}–${t.snapshot.rubric.scoreMax}，通过阈值：${t.snapshot.rubric.passThreshold}。`, '',
    `自动通过率 = 通过数 ÷ 明确判定数 = ${s.passed} ÷ ${s.decided} = ${percent(s.passRate)}。`,
    `明确判定覆盖率 = ${s.decided} ÷ ${s.total} = ${percent(s.coverage)}。`,
    `通过：${s.passed}；未通过：${s.notPassed}；待确认：${s.uncertain}。三种结论互斥，待确认不计入通过率分子或分母。`,
    `完成合法评分：${s.graded}/${s.total}；执行错误：${s.failed}；未完成：${s.pending}。`,
    `人工复核：${s.reviewed}；确认Bad Case：${s.confirmed}；争议：${s.disputed}；待复核：${s.reviewPending}。`,
    `人工确认问题比例（仅已复核子集） = ${s.confirmed} ÷ ${s.reviewed} = ${s.reviewed?percent(s.confirmed/s.reviewed):'—'}。`, '',
    '这些指标仅代表本批案例，不代表线上成交转化率。', '', '## 问题与场景分布', '',
    ...(s.issueBreakdown?.length?s.issueBreakdown.map(x=>`- ${x.label}：${x.count}条人工确认问题。`):['尚无人工确认问题。']), '',
    ...(s.attributionBreakdown||[]).map(x=>`- 归因${x.label==='confirmed'?'已确认':'待核实'}：${x.count}条。`), '',
    ...(s.scenarioBreakdown||[]).map(x=>`- ${x.label}：${x.total}条；通过${x.passed}、未通过${x.notPassed}、待确认${x.uncertain}；人工确认问题${x.confirmed}。`), '',
    '## Bad Case 与归因', ''
  ];
  for(const r of t.rows.filter(r=>['bad','disputed'].includes(r.review?.decision))) {
    lines.push(`### ${r.input.case_id} · ${r.review.issueType||'未分类'}`, '',
      `复核结论：${r.review.decision==='bad'?'确认Bad Case':'有争议'}。`, '', '用户输入原文：', '', quote(r.input.user_input||JSON.stringify(r.input)), '',
      '完整案例与改写前内容：', '', quote(r.input.case_json||JSON.stringify(r.input)), '',
      '资料原文：', '', quote(r.input.context), '', '案例判定要求：', '', quote(r.input[t.snapshot.rubric.referenceColumn]), '',
      'Agent回答原文：', '', quote(r.answer), '',
      `自动评分：${r.judgment?.score??'未完成'}；结论：${verdict(r.judgment)}。`,
      `判定理由：${r.judgment?.reason||r.error||'未完成自动判定'}。`, '', '各项分数与扣分证据：', '', quote(JSON.stringify(r.judgment?.dimensions||{},null,2)), '',
      '证据：', '', quote((r.judgment?.evidence||[]).join('\n')), '',
      `归因状态：${r.review.attributionStatus==='confirmed'?'已确认':'待核实'}。`, '', quote(r.review.attribution), '', '复核备注：', '', quote(r.review.note), '');
  }
  lines.push('## 全部案例', '');
  for(const r of t.rows)lines.push(`- ${r.input.case_id}：${r.judgment?.score??'未评分'}，${verdict(r.judgment)}；复核：${({bad:'确认问题',normal:'正常',disputed:'争议'})[r.review?.decision]||'未复核'}${r.error?`；错误：${r.error}`:''}。`);
  return lines.join('\n');
}

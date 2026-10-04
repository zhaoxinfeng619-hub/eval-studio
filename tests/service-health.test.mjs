import test from 'node:test';
import assert from 'node:assert/strict';
import { probeAgentService } from '../service-health.mjs';

test('本项目服务缺失时预检阻止运行，健康检查不调用评测接口', async () => {
  const agent = { adapterType: 'sales', url: 'http://127.0.0.1:4175/evaluate' };
  const down = await probeAgentService(agent, { fetchImpl: async url => {
    assert.equal(url.pathname, '/health'); throw new Error('connection refused');
  } });
  assert.equal(down.status, 'error');
  assert.match(down.message, /4175/);
  const ready = await probeAgentService(agent, { fetchImpl: async url => {
    assert.equal(url.pathname, '/health'); return { ok: true, json: async () => ({ ready: true }) };
  } });
  assert.equal(ready.status, 'pass');
  assert.match(ready.message, /试跑/);
  assert.equal(await probeAgentService({ ...agent, url: 'https://example.com/evaluate' }), null);
});

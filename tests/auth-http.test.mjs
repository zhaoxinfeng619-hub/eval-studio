import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { authenticatedClient, testInitialPassword } from './auth-client.mjs';

test('HTTP登录保护覆盖数据、配置、任务、导出和写操作；跨站与无CSRF写入被拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eval-auth-http-'));
  const app = createApp({ dataDir: dir, authOptions: { initialPassword: testInitialPassword } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for (const path of ['/api/boot', '/api/datasets/private-id', '/api/tasks/private-id/export?format=md', '/api/template']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 401, path);
    }
    const mutation = await fetch(base + '/api/datasets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(mutation.status, 401);
    assert.equal((await (await fetch(base + '/api/auth/status')).json()).authenticated, false);
    const crossSite = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: testInitialPassword }) });
    assert.equal(crossSite.status, 403);
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: testInitialPassword }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const initial = await login.json();
    assert.equal(initial.user.mustChangePassword, true);
    const restricted = await fetch(base + '/api/boot', { headers: { Cookie: cookie } });
    assert.equal(restricted.status, 403);
    assert.equal((await restricted.json()).code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await fetch(base + '/api/auth/password', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const authed = await authenticatedClient(base);
    const boot = await authed('/api/boot');
    assert.equal(boot.status, 200);
    assert(!JSON.stringify(await boot.json()).includes(testInitialPassword));
    const logout = await authed('/api/auth/logout', { method: 'POST' });
    assert.equal(logout.status, 200);
    assert.equal((await authed('/api/boot')).status, 401);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    app.store.close(); app.auth.close();
    await rm(dir, { recursive: true, force: true });
  }
});

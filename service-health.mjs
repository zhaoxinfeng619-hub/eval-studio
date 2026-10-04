// The built-in adapter exposes a free readiness endpoint; generic Agent APIs do not.
export async function probeAgentService(agent, { fetchImpl = fetch } = {}) {
  let url;
  try { url = new URL(agent.url); } catch { return null; }
  if (agent.adapterType !== 'sales' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.port !== '4175' || url.pathname !== '/evaluate') return null;
  const label = '本地 Agent 评测服务';
  try {
    const response = await fetchImpl(new URL('/health', url), { signal: AbortSignal.timeout(2000), redirect: 'error' });
    const body = await response.json();
    if (!response.ok || body.ready !== true) throw new Error('not ready');
    return { label, status: 'pass', message: '本地服务已启动；扣子和评分模型的实际可用性由试跑验证。' };
  } catch {
    return { label, status: 'error', message: '本机 Agent 评测服务未启动或不可用（4175端口）。请启动你配置的 Agent 服务，再点击重新检查。' };
  }
}

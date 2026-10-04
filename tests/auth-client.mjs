// Isolated test credentials, never used for the local administrator account.
export const testInitialPassword = 'Fixture-start-password!48';
export const testNewPassword = 'Fixture-changed-password!93';
export async function authenticatedClient(base) {
  let cookie = '', csrf = '';
  const fetchWithSession = async (path, options = {}) => {
    const headers = { ...options.headers, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) };
    const response = await fetch((typeof base === 'function' ? base() : base) + path, { ...options, headers });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  const post = async (path, body) => {
    const response = await fetchWithSession(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (result.csrfToken) csrf = result.csrfToken;
    return result;
  };
  await post('/api/auth/login', { username: 'admin', password: testInitialPassword });
  await post('/api/auth/password', { currentPassword: testInitialPassword, newPassword: testNewPassword });
  return fetchWithSession;
}

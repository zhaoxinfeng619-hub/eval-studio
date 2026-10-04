import { createApp } from './server.mjs';
import { fileURLToPath } from 'node:url';
const port = Number(process.env.EVAL_STUDIO_PORT || process.env.EVAL_PORT || 4189);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('网站端口应为 1–65535 的整数。');
const app = createApp({dataDir: process.env.EVAL_DATA_DIR || fileURLToPath(new URL('./.data', import.meta.url))});
app.server.on('error', error => { console.error(error.message); app.store.close(); app.auth.close(); process.exitCode = 1; });
app.server.listen(port, '127.0.0.1', () => console.log(`Eval Studio 已启动：http://127.0.0.1:${port}`));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  if (stopping) return;
  stopping = true;
  app.server.close(() => { app.store.close(); app.auth.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
});

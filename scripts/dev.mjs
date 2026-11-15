// npm run dev: the hub API (tsx watch) plus the Vite dev server with hot reload.
import { spawn } from 'node:child_process';

const port = process.env.HUB_PORT ?? '4319';
const procs = [
  spawn('npx', ['tsx', 'watch', 'src/cli.ts', 'serve', '--no-open', '--port', port], { stdio: 'inherit' }),
  spawn('npx', ['vite'], { stdio: 'inherit', env: { ...process.env, HUB_PORT: port } }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { stop(); process.exitCode = code ?? 0; });

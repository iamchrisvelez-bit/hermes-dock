// Runs the control plane (watch mode) and the Vite dev server together.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npm', ['run', 'dev', '-w', '@hdw/control-plane'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev', '-w', '@hdw/mobile-client'], { stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => code && stop()));

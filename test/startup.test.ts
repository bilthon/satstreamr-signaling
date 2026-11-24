import { expect, test } from '@jest/globals';
import { spawn } from 'child_process';
import * as path from 'path';

test('piped startup emits JSON on stdout without a stderr banner', async () => {
  const child = spawn(process.execPath, [
    process.env.STARTUP_SERVER ?? path.resolve(__dirname, '../dist/server.js'),
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { HOST: '127.0.0.1', PORT: '0', NODE_PATH: process.env.NODE_PATH },
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let shutdownRequested = false;
  // Only this owned child is terminated; no polling or fixed readiness sleeps.
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 5000);
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (!shutdownRequested && stdout.includes('\n')) {
        shutdownRequested = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal });
    });
  });
  expect({ timedOut, ...result }).toEqual({ timedOut: false, code: 0, signal: null });
  expect(stdout.endsWith('\n')).toBe(true);
  const entries = stdout.slice(0, -1).split('\n').map((line) => JSON.parse(line));
  expect(entries).toEqual([{
    timestamp: expect.any(String),
    event: 'server_started',
    messageType: 'server_start',
    host: '127.0.0.1',
    port: 0,
    level: 'info',
    category: 'system',
    direction: 'outbound',
    peerId: 'server',
    role: 'server',
    details: { host: '127.0.0.1', port: 0 },
  }, {
    timestamp: expect.any(String),
    event: 'server_stopping',
    messageType: 'server_stopping',
    level: 'info',
    category: 'system',
    peerId: 'server',
    role: 'server',
    details: { signal: 'SIGTERM', activeSessions: 0, connectedClients: 0 },
  }, {
    timestamp: expect.any(String),
    event: 'server_stopped',
    messageType: 'server_stopped',
    level: 'info',
    category: 'system',
    peerId: 'server',
    role: 'server',
  }]);
  for (const entry of entries) {
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
  }
  expect(stderr).toBe('');
});

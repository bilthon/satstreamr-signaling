import { WebSocket } from 'ws';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';

const PORT = 8095;
const SERVER_URL = `ws://localhost:${PORT}`;
const DIST_SERVER = path.resolve(__dirname, '../dist/server.js');

function startServer(): Promise<{ proc: ChildProcess; stdout: () => string }> {
  return new Promise((resolve, reject) => {
    let out = '';
    const proc = spawn('node', [DIST_SERVER], {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    let attempts = 0;
    const tryConnect = () => {
      const ws = new WebSocket(SERVER_URL);
      ws.once('open', () => { ws.close(); resolve({ proc, stdout: () => out }); });
      ws.once('error', () => {
        if (++attempts > 20) { proc.kill('SIGKILL'); reject(new Error('Server did not start')); return; }
        setTimeout(tryConnect, 200);
      });
    };
    setTimeout(tryConnect, 300);
  });
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function logEntries(stdout: string): Array<Record<string, any>> {
  return stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l));
}

describe.each(['SIGTERM', 'SIGINT'] as const)('graceful shutdown on %s', (signal) => {
  it('ends sessions, closes clients with 1001 and exits 0', async () => {
    const { proc, stdout } = await startServer();

    const tutor = await connect();
    const created = new Promise<Record<string, any>>((resolve) =>
      tutor.once('message', (d) => resolve(JSON.parse(d.toString()))),
    );
    tutor.send(JSON.stringify({ type: 'create_session' }));
    const { sessionId } = await created;

    const received: Array<Record<string, any>> = [];
    tutor.on('message', (d) => received.push(JSON.parse(d.toString())));
    const closed = new Promise<number>((resolve) => tutor.once('close', (code) => resolve(code)));
    const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));

    proc.kill(signal);

    expect(await closed).toBe(1001);
    expect(await exited).toBe(0);
    expect(received).toEqual([{ type: 'session_ended' }]);

    const entries = logEntries(stdout());
    const summary = entries.find((e) => e.event === 'session_summary' && e.sessionId === sessionId);
    expect(summary?.details?.endedReason).toBe('server_shutdown');
    expect(entries.some((e) => e.event === 'server_stopping' && e.details?.signal === signal)).toBe(true);
    expect(entries.some((e) => e.event === 'server_stopped')).toBe(true);
  });
});

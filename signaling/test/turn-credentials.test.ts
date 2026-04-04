/**
 * turn-credentials.test.ts
 *
 * Integration tests for TURN credential injection and mintUrl relay in
 * session_created responses.
 *
 * Each describe block spawns its own server process so TURN_SHARED_SECRET
 * and TURN_HOST can be injected into the child environment independently.
 */

import { WebSocket } from 'ws';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';

const DIST_SERVER = path.resolve(__dirname, '../dist/server.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timeout waiting for message')),
      5000,
    );
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function send(ws: WebSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message));
}

/**
 * Spawns the compiled server on the given port with the supplied extra env
 * vars merged on top of the current process environment.
 */
function spawnServer(
  port: number,
  extraEnv: Record<string, string> = {},
): ChildProcess {
  const child = spawn('node', [DIST_SERVER], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: {
      ...process.env,
      PORT: String(port),
      ...extraEnv,
    },
  });

  child.stdout?.on('data', (_data: Buffer) => {
    // suppress — uncomment for debugging: process.stdout.write(_data)
  });
  child.stderr?.on('data', (data: Buffer) => {
    // eslint-disable-next-line no-console
    console.error('Server error:', data.toString());
  });

  return child;
}

/**
 * Polls until the server at `url` accepts a WebSocket connection or we time
 * out after `attempts * 200 ms`.
 */
function waitForServer(
  url: string,
  attempts = 30,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let remaining = attempts;
    const tryConnect = () => {
      const ws = new WebSocket(url);
      ws.once('open', () => {
        ws.close();
        resolve();
      });
      ws.once('error', () => {
        remaining -= 1;
        if (remaining <= 0) {
          reject(new Error(`Server at ${url} did not start in time`));
          return;
        }
        setTimeout(tryConnect, 200);
      });
    };
    setTimeout(tryConnect, 300);
  });
}

// ---------------------------------------------------------------------------
// NOTE ON PORT CONFIGURATION
//
// The compiled server.js reads process.env.PORT to decide which port to bind
// (falling back to 8080 when PORT is not set). The tests in protocol.test.ts
// already occupy 8080, so we use 8081 here to avoid conflicts when both test
// files are run together via `npm test`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test suite 1 — TURN credential injection
// ---------------------------------------------------------------------------

describe('TURN credentials in session_created', () => {
  let serverProcess: ChildProcess;
  const PORT = 9001;
  const URL = `ws://localhost:${PORT}`;

  beforeAll(async () => {
    serverProcess = spawnServer(PORT, {
      TURN_SHARED_SECRET: 'test-secret',
      TURN_HOST: 'turn.example.com',
    });
    await waitForServer(URL);
  }, 15000);

  afterAll((done) => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
    setTimeout(done, 500);
  });

  test('session_created includes a TURN entry when TURN_SHARED_SECRET is set', async () => {
    const ws = await connect(URL);
    send(ws, { type: 'create_session' });
    const msg = await nextMessage(ws);

    expect(msg.type).toBe('session_created');

    const iceServers = msg.iceServers as Array<Record<string, unknown>>;
    expect(Array.isArray(iceServers)).toBe(true);
    expect(iceServers.length).toBeGreaterThanOrEqual(2);

    // First entry must be the Google STUN server
    expect((iceServers[0] as Record<string, unknown>).urls).toBe(
      'stun:stun.l.google.com:19302',
    );

    // Second entry must be a TURN server on the configured host
    const turnEntry = iceServers[1] as Record<string, unknown>;
    expect(typeof turnEntry.urls).toBe('string');
    expect((turnEntry.urls as string).startsWith('turn:turn.example.com')).toBe(true);
    expect(typeof turnEntry.username).toBe('string');
    expect((turnEntry.username as string).length).toBeGreaterThan(0);
    expect(typeof turnEntry.credential).toBe('string');
    expect((turnEntry.credential as string).length).toBeGreaterThan(0);

    ws.close();
  });

  test('session_created TURN username is time:userId format', async () => {
    const ws = await connect(URL);
    send(ws, { type: 'create_session' });
    const msg = await nextMessage(ws);

    const iceServers = msg.iceServers as Array<Record<string, unknown>>;
    const turnEntry = iceServers[1] as Record<string, unknown>;

    // Username format: "<unix_timestamp>:<uuid>"
    const username = turnEntry.username as string;
    const parts = username.split(':');
    expect(parts.length).toBeGreaterThanOrEqual(2);

    const timestamp = parseInt(parts[0] as string, 10);
    const nowSecs = Math.floor(Date.now() / 1000);
    // Timestamp should be in the future (TTL is 3600 s by default)
    expect(timestamp).toBeGreaterThan(nowSecs);
    // And not unreasonably far in the future (say, within 2 hours)
    expect(timestamp).toBeLessThan(nowSecs + 7201);

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// Test suite 2 — No TURN when secret is absent
// ---------------------------------------------------------------------------

describe('No TURN entry when TURN_SHARED_SECRET is unset', () => {
  let serverProcess: ChildProcess;
  const PORT = 9002;
  const URL = `ws://localhost:${PORT}`;

  beforeAll(async () => {
    // Spawn without TURN_SHARED_SECRET; explicitly unset it in case it
    // happens to be present in the ambient environment.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { TURN_SHARED_SECRET: _omitted, ...restEnv } = process.env;
    const env = { ...restEnv, PORT: String(PORT) };

    const child = spawn('node', [DIST_SERVER], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env,
    });

    child.stdout?.on('data', (_data: Buffer) => { /* suppress */ });
    child.stderr?.on('data', (data: Buffer) => {
      // eslint-disable-next-line no-console
      console.error('Server error:', data.toString());
    });

    serverProcess = child;
    await waitForServer(URL);
  }, 15000);

  afterAll((done) => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
    setTimeout(done, 500);
  });

  test('session_created iceServers contains only the STUN entry', async () => {
    const ws = await connect(URL);
    send(ws, { type: 'create_session' });
    const msg = await nextMessage(ws);

    expect(msg.type).toBe('session_created');

    const iceServers = msg.iceServers as Array<Record<string, unknown>>;
    expect(Array.isArray(iceServers)).toBe(true);
    expect(iceServers).toHaveLength(1);

    const stunEntry = iceServers[0] as Record<string, unknown>;
    expect(stunEntry.urls).toBe('stun:stun.l.google.com:19302');
    expect(stunEntry.username).toBeUndefined();
    expect(stunEntry.credential).toBeUndefined();

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// Test suite 3 — mintUrl relay in session_created
// ---------------------------------------------------------------------------

describe('mintUrl relay in session_created', () => {
  let serverProcess: ChildProcess;
  const PORT = 9003;
  const URL = `ws://localhost:${PORT}`;

  beforeAll(async () => {
    serverProcess = spawnServer(PORT);
    await waitForServer(URL);
  }, 15000);

  afterAll((done) => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
    setTimeout(done, 500);
  });

  test('session_created echoes the mintUrl supplied in create_session', async () => {
    const ws = await connect(URL);
    const mintUrl = 'http://mint.example.com:3338';
    send(ws, { type: 'create_session', mintUrl });
    const msg = await nextMessage(ws);

    expect(msg.type).toBe('session_created');
    expect(msg.mintUrl).toBe(mintUrl);

    ws.close();
  });

  test('session_created mintUrl is absent when not provided in create_session', async () => {
    const ws = await connect(URL);
    // Intentionally omit mintUrl
    send(ws, { type: 'create_session' });
    const msg = await nextMessage(ws);

    expect(msg.type).toBe('session_created');
    // Should be undefined or falsy — the server must not invent a value
    expect(msg.mintUrl == null || msg.mintUrl === '').toBe(true);

    ws.close();
  });

  // Also verify the viewer receives the mintUrl when joining
  test('viewer receives the mintUrl in the session_created message upon joining', async () => {
    const mintUrl = 'http://mint.example.com:3338';

    const tutor = await connect(URL);
    send(tutor, { type: 'create_session', mintUrl });
    const created = await nextMessage(tutor);
    expect(created.type).toBe('session_created');
    const sessionId = created.sessionId as string;

    const viewer = await connect(URL);
    send(viewer, { type: 'join_session', sessionId });

    // tutor gets viewer_joined
    await nextMessage(tutor);

    // viewer gets session_created carrying the mintUrl
    const viewerMsg = await nextMessage(viewer);
    expect(viewerMsg.type).toBe('session_created');
    expect(viewerMsg.mintUrl).toBe(mintUrl);

    tutor.close();
    viewer.close();
  });
});

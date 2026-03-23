import { WebSocket } from 'ws';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';

const SERVER_URL = 'ws://localhost:8080';
const DIST_SERVER = path.resolve(__dirname, '../dist/server.js');

let serverProcess: ChildProcess;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for message')), 5000);
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

beforeAll((done) => {
  // Start the compiled server as a child process
  serverProcess = spawn('node', [DIST_SERVER], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  serverProcess.stdout?.on('data', (_data: Buffer) => {
    // Server logs — suppress in test output
  });

  serverProcess.stderr?.on('data', (data: Buffer) => {
    // eslint-disable-next-line no-console
    console.error('Server error:', data.toString());
  });

  // Wait for server to be ready
  let attempts = 0;
  const tryConnect = () => {
    const ws = new WebSocket(SERVER_URL);
    ws.once('open', () => {
      ws.close();
      done();
    });
    ws.once('error', () => {
      attempts++;
      if (attempts > 20) {
        done(new Error('Server did not start in time'));
        return;
      }
      setTimeout(tryConnect, 200);
    });
  };
  setTimeout(tryConnect, 300);
});

afterAll((done) => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
  setTimeout(done, 500);
});

describe('ping / pong', () => {
  test('server responds to ping with pong', async () => {
    const ws = await connect();
    send(ws, { type: 'ping' });
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('pong');
    ws.close();
  });
});

describe('create_session', () => {
  test('server returns session_created with a sessionId', async () => {
    const ws = await connect();
    send(ws, { type: 'create_session' });
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('session_created');
    expect(typeof msg.sessionId).toBe('string');
    expect((msg.sessionId as string).length).toBeGreaterThan(0);
    ws.close();
  });
});

describe('join_session', () => {
  test('second peer joins and tutor receives viewer_joined', async () => {
    const tutor = await connect();
    send(tutor, { type: 'create_session' });
    const created = await nextMessage(tutor);
    expect(created.type).toBe('session_created');
    const sessionId = created.sessionId as string;

    const viewer = await connect();
    send(viewer, { type: 'join_session', sessionId });

    // Tutor should receive viewer_joined
    const notification = await nextMessage(tutor);
    expect(notification.type).toBe('viewer_joined');
    expect(typeof notification.viewerId).toBe('string');

    tutor.close();
    viewer.close();
  });

  test('third peer is rejected with SESSION_FULL', async () => {
    const tutor = await connect();
    send(tutor, { type: 'create_session' });
    const created = await nextMessage(tutor);
    const sessionId = created.sessionId as string;

    const viewer1 = await connect();
    send(viewer1, { type: 'join_session', sessionId });
    await nextMessage(tutor); // viewer_joined

    const viewer2 = await connect();
    send(viewer2, { type: 'join_session', sessionId });
    const error = await nextMessage(viewer2);
    expect(error.type).toBe('error');
    expect(error.code).toBe('SESSION_FULL');

    tutor.close();
    viewer1.close();
    viewer2.close();
  });
});

describe('offer / answer relay', () => {
  test('offer is relayed from tutor to viewer', async () => {
    const tutor = await connect();
    send(tutor, { type: 'create_session' });
    const created = await nextMessage(tutor);
    const sessionId = created.sessionId as string;

    const viewer = await connect();
    send(viewer, { type: 'join_session', sessionId });
    await nextMessage(tutor); // viewer_joined

    const sdp = { type: 'offer', sdp: 'v=0\r\n...' };
    send(tutor, { type: 'offer', sessionId, sdp });

    const relayed = await nextMessage(viewer);
    expect(relayed.type).toBe('offer');
    expect(relayed.sdp).toEqual(sdp);

    tutor.close();
    viewer.close();
  });

  test('answer is relayed from viewer to tutor', async () => {
    const tutor = await connect();
    send(tutor, { type: 'create_session' });
    const created = await nextMessage(tutor);
    const sessionId = created.sessionId as string;

    const viewer = await connect();
    send(viewer, { type: 'join_session', sessionId });
    await nextMessage(tutor); // viewer_joined

    const sdp = { type: 'answer', sdp: 'v=0\r\n...' };
    send(viewer, { type: 'answer', sessionId, sdp });

    const relayed = await nextMessage(tutor);
    expect(relayed.type).toBe('answer');
    expect(relayed.sdp).toEqual(sdp);

    tutor.close();
    viewer.close();
  });
});

describe('ice_candidate relay', () => {
  test('ICE candidate is relayed to the other peer', async () => {
    const tutor = await connect();
    send(tutor, { type: 'create_session' });
    const created = await nextMessage(tutor);
    const sessionId = created.sessionId as string;

    const viewer = await connect();
    send(viewer, { type: 'join_session', sessionId });
    await nextMessage(tutor); // viewer_joined

    const candidate = { candidate: 'candidate:1 1 UDP ...', sdpMid: '0', sdpMLineIndex: 0 };
    send(tutor, { type: 'ice_candidate', sessionId, candidate });

    const relayed = await nextMessage(viewer);
    expect(relayed.type).toBe('ice_candidate');
    expect(relayed.candidate).toEqual(candidate);

    tutor.close();
    viewer.close();
  });
});

describe('end_session', () => {
  test('end_session sends session_ended to both peers', async () => {
    const tutor = await connect();
    send(tutor, { type: 'create_session' });
    const created = await nextMessage(tutor);
    const sessionId = created.sessionId as string;

    const viewer = await connect();
    send(viewer, { type: 'join_session', sessionId });
    await nextMessage(tutor); // viewer_joined

    // Both peers listen for session_ended
    const tutorEndPromise = nextMessage(tutor);
    const viewerEndPromise = nextMessage(viewer);

    send(tutor, { type: 'end_session', sessionId });

    const [tutorEnd, viewerEnd] = await Promise.all([tutorEndPromise, viewerEndPromise]);
    expect(tutorEnd.type).toBe('session_ended');
    expect(viewerEnd.type).toBe('session_ended');

    tutor.close();
    viewer.close();
  });
});

describe('reconnect grace period', () => {
  test('peer can rejoin within 30s grace period and receive buffered messages', async () => {
    // Setup: tutor creates session, viewer joins
    const tutor = await connect();
    send(tutor, { type: 'create_session' });
    const created = await nextMessage(tutor);
    const sessionId = created.sessionId as string;

    const viewer = await connect();
    send(viewer, { type: 'join_session', sessionId });
    await nextMessage(tutor); // viewer_joined

    // Tutor sends an offer while viewer is about to disconnect
    const sdp = { type: 'offer', sdp: 'v=0\r\nreconnect-test' };

    // Close viewer connection to trigger grace period
    viewer.close();

    // Wait briefly for close event to be processed
    await sleep(200);

    // Tutor sends offer — viewer is gone, message should be buffered
    send(tutor, { type: 'offer', sessionId, sdp });

    // Wait 2 seconds (well within 30s grace period)
    await sleep(2000);

    // Viewer reconnects with rejoin_session
    const viewerNew = await connect();
    send(viewerNew, { type: 'rejoin_session', sessionId });

    // Should receive the buffered offer
    const bufferedMsg = await nextMessage(viewerNew);
    expect(bufferedMsg.type).toBe('offer');
    expect(bufferedMsg.sdp).toEqual(sdp);

    tutor.close();
    viewerNew.close();
  }, 15000);

  test('rejoin fails with SESSION_NOT_FOUND for unknown session', async () => {
    const ws = await connect();
    send(ws, { type: 'rejoin_session', sessionId: 'nonexistent-session-id' });
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('SESSION_NOT_FOUND');
    ws.close();
  });
});

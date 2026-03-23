import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import {
  InboundMessage,
  OutboundMessage,
  SessionRecord,
  LogEntry,
} from './types';

const PORT = 8080;
const GRACE_PERIOD_MS = 30_000;

// In-memory session store
const sessions = new Map<string, SessionRecord>();
// Map from peerId -> sessionId for quick reverse lookup
const peerSession = new Map<string, string>();

function log(entry: LogEntry): void {
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function sendTo(ws: WebSocket, message: OutboundMessage, peerId: string, sessionId?: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    log({
      timestamp: new Date().toISOString(),
      direction: 'outbound',
      messageType: message.type,
      peerId,
      sessionId,
    });
  }
}

/**
 * Deliver a message to a peer — send it directly if the peer is connected,
 * otherwise buffer it for delivery when they reconnect.
 */
function deliverToPeer(
  session: SessionRecord,
  targetPeerId: string,
  message: OutboundMessage,
  sessionId: string,
): void {
  const ws = session.peers.get(targetPeerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendTo(ws, message, targetPeerId, sessionId);
  } else {
    // Peer is disconnected — buffer the message
    if (!session.peerBuffers.has(targetPeerId)) {
      session.peerBuffers.set(targetPeerId, []);
    }
    session.peerBuffers.get(targetPeerId)!.push(message);
    log({
      timestamp: new Date().toISOString(),
      direction: 'outbound',
      messageType: message.type,
      peerId: targetPeerId,
      sessionId,
      note: 'buffered (peer disconnected)',
    });
  }
}

/**
 * Return all peerIds in this session (active + grace-period peers), excluding the given peerId.
 */
function getOtherPeerIds(session: SessionRecord, excludePeerId: string): string[] {
  const result: string[] = [];
  for (const id of session.peers.keys()) {
    if (id !== excludePeerId) result.push(id);
  }
  for (const id of session.disconnectedPeers) {
    if (id !== excludePeerId) result.push(id);
  }
  return result;
}

/**
 * Return the total number of peers in the session (active + grace-period).
 */
function totalPeerCount(session: SessionRecord): number {
  return session.peers.size + session.disconnectedPeers.size;
}

const wss = new WebSocketServer({ port: PORT });

wss.on('listening', () => {
  log({
    timestamp: new Date().toISOString(),
    direction: 'outbound',
    messageType: 'server_start',
    peerId: 'server',
    port: PORT,
  });
});

wss.on('connection', (ws: WebSocket) => {
  const peerId = uuidv4();

  log({
    timestamp: new Date().toISOString(),
    direction: 'inbound',
    messageType: 'connection',
    peerId,
  });

  ws.on('message', (rawData: Buffer) => {
    let message: InboundMessage;
    try {
      message = JSON.parse(rawData.toString()) as InboundMessage;
    } catch {
      sendTo(ws, { type: 'error', code: 'INVALID_JSON', message: 'Could not parse JSON' }, peerId);
      return;
    }

    const sessionId = 'sessionId' in message ? message.sessionId : undefined;

    log({
      timestamp: new Date().toISOString(),
      direction: 'inbound',
      messageType: message.type,
      peerId,
      sessionId,
    });

    switch (message.type) {
      case 'ping': {
        sendTo(ws, { type: 'pong' }, peerId);
        break;
      }

      case 'create_session': {
        const newSessionId = uuidv4();
        const tutorPubkey = message.tutorPubkey ?? '';
        const session: SessionRecord = {
          peers: new Map([[peerId, ws]]),
          disconnectedPeers: new Set(),
          buffer: [],
          peerBuffers: new Map(),
          tutorPeerId: peerId,
          tutorPubkey,
          graceTimers: new Map(),
          peerRoles: new Map([[peerId, 'tutor']]),
        };
        sessions.set(newSessionId, session);
        peerSession.set(peerId, newSessionId);
        sendTo(ws, { type: 'session_created', sessionId: newSessionId, tutorPubkey }, peerId, newSessionId);
        break;
      }

      case 'join_session': {
        const { sessionId: sid } = message;
        const session = sessions.get(sid);
        if (!session) {
          sendTo(ws, { type: 'error', code: 'SESSION_NOT_FOUND', message: `Session ${sid} not found` }, peerId, sid);
          break;
        }
        if (totalPeerCount(session) >= 2) {
          sendTo(ws, { type: 'error', code: 'SESSION_FULL', message: 'Session already has 2 peers' }, peerId, sid);
          break;
        }
        session.peers.set(peerId, ws);
        session.peerRoles.set(peerId, 'viewer');
        peerSession.set(peerId, sid);

        // Notify tutor about new viewer; include tutorPubkey for viewer
        const tutorId = session.tutorPeerId;
        const sessionTutorPubkey = session.tutorPubkey ?? '';
        if (tutorId) {
          deliverToPeer(session, tutorId, { type: 'viewer_joined', viewerId: peerId, tutorPubkey: sessionTutorPubkey }, sid);
        }
        // Send viewer a session_created message so it learns the tutorPubkey
        sendTo(ws, { type: 'session_created', sessionId: sid, tutorPubkey: sessionTutorPubkey }, peerId, sid);
        break;
      }

      case 'offer': {
        const { sessionId: sid, sdp } = message;
        const session = sessions.get(sid);
        if (!session) {
          sendTo(ws, { type: 'error', code: 'SESSION_NOT_FOUND' }, peerId, sid);
          break;
        }
        for (const otherId of getOtherPeerIds(session, peerId)) {
          deliverToPeer(session, otherId, { type: 'offer', sdp, fromPeerId: peerId }, sid);
        }
        break;
      }

      case 'answer': {
        const { sessionId: sid, sdp } = message;
        const session = sessions.get(sid);
        if (!session) {
          sendTo(ws, { type: 'error', code: 'SESSION_NOT_FOUND' }, peerId, sid);
          break;
        }
        for (const otherId of getOtherPeerIds(session, peerId)) {
          deliverToPeer(session, otherId, { type: 'answer', sdp, fromPeerId: peerId }, sid);
        }
        break;
      }

      case 'ice_candidate': {
        const { sessionId: sid, candidate } = message;
        const session = sessions.get(sid);
        if (!session) {
          sendTo(ws, { type: 'error', code: 'SESSION_NOT_FOUND' }, peerId, sid);
          break;
        }
        for (const otherId of getOtherPeerIds(session, peerId)) {
          deliverToPeer(session, otherId, { type: 'ice_candidate', candidate, fromPeerId: peerId }, sid);
        }
        break;
      }

      case 'end_session': {
        const { sessionId: sid } = message;
        const session = sessions.get(sid);
        if (!session) {
          sendTo(ws, { type: 'error', code: 'SESSION_NOT_FOUND' }, peerId, sid);
          break;
        }
        // Notify all active peers
        for (const [pid, peerWs] of session.peers) {
          sendTo(peerWs, { type: 'session_ended' }, pid, sid);
          peerSession.delete(pid);
        }
        // Cancel all grace timers
        for (const [, timer] of session.graceTimers) {
          clearTimeout(timer);
        }
        // Remove peerSession entries for disconnected peers too
        for (const pid of session.disconnectedPeers) {
          peerSession.delete(pid);
        }
        sessions.delete(sid);
        break;
      }

      case 'rejoin_session': {
        const { sessionId: sid } = message;
        const session = sessions.get(sid);
        if (!session) {
          sendTo(ws, { type: 'error', code: 'SESSION_NOT_FOUND', message: `Session ${sid} not found or expired` }, peerId, sid);
          break;
        }

        // Find a disconnected peer slot to restore (grace period)
        if (session.disconnectedPeers.size === 0) {
          // No grace-period slots — check if session is full with active peers
          if (session.peers.size >= 2) {
            sendTo(ws, { type: 'error', code: 'SESSION_FULL' }, peerId, sid);
            break;
          }
          // Session has room but no grace slot — treat as a fresh join
          // (edge case: session with 1 active peer and the rejoining peer is unexpected)
        }

        // Take the first grace-period slot
        let rejoiningOldPeerId: string | undefined;
        for (const pid of session.disconnectedPeers) {
          rejoiningOldPeerId = pid;
          break;
        }

        if (rejoiningOldPeerId) {
          // Cancel the grace timer
          const timer = session.graceTimers.get(rejoiningOldPeerId);
          if (timer) clearTimeout(timer);
          session.graceTimers.delete(rejoiningOldPeerId);

          // Remove from disconnected set
          session.disconnectedPeers.delete(rejoiningOldPeerId);
          peerSession.delete(rejoiningOldPeerId);

          // Restore the old peer's role
          const role = session.peerRoles.get(rejoiningOldPeerId) ?? 'viewer';
          session.peerRoles.delete(rejoiningOldPeerId);

          // Register new connection with the restored role
          session.peers.set(peerId, ws);
          session.peerRoles.set(peerId, role);
          peerSession.set(peerId, sid);
          session.expiresAt = undefined;

          if (role === 'tutor') {
            session.tutorPeerId = peerId;
          }

          // Flush buffered messages intended for the old peerId
          const buffered = session.peerBuffers.get(rejoiningOldPeerId) ?? [];
          session.peerBuffers.delete(rejoiningOldPeerId);

          // Confirm session rejoin before flushing buffered messages
          sendTo(ws, { type: 'session_rejoined', sessionId: sid, bufferedCount: buffered.length }, peerId, sid);

          for (const msg of buffered) {
            sendTo(ws, msg, peerId, sid);
          }

          log({
            timestamp: new Date().toISOString(),
            direction: 'outbound',
            messageType: 'rejoin_ack',
            peerId,
            sessionId: sid,
            restoredFrom: rejoiningOldPeerId,
            flushedMessages: buffered.length,
          });
        }
        break;
      }

      default: {
        sendTo(ws, { type: 'error', code: 'UNKNOWN_MESSAGE_TYPE' }, peerId);
      }
    }
  });

  ws.on('close', () => {
    log({
      timestamp: new Date().toISOString(),
      direction: 'inbound',
      messageType: 'disconnection',
      peerId,
    });

    const sid = peerSession.get(peerId);
    if (!sid) return;

    const session = sessions.get(sid);
    if (!session) return;

    // Remove from active peers map
    session.peers.delete(peerId);

    // Add to disconnected peers set (grace period tracking)
    session.disconnectedPeers.add(peerId);

    // Set expiry on session
    session.expiresAt = Date.now() + GRACE_PERIOD_MS;

    // Start grace timer
    const timer = setTimeout(() => {
      log({
        timestamp: new Date().toISOString(),
        direction: 'outbound',
        messageType: 'session_grace_expired',
        peerId,
        sessionId: sid,
      });
      session.graceTimers.delete(peerId);
      session.disconnectedPeers.delete(peerId);
      session.peerRoles.delete(peerId);
      session.peerBuffers.delete(peerId);
      peerSession.delete(peerId);

      // If no more active or grace-period peers, evict session
      if (session.peers.size === 0 && session.disconnectedPeers.size === 0) {
        sessions.delete(sid);
        log({
          timestamp: new Date().toISOString(),
          direction: 'outbound',
          messageType: 'session_evicted',
          peerId: 'server',
          sessionId: sid,
        });
      }
    }, GRACE_PERIOD_MS);

    session.graceTimers.set(peerId, timer);
  });

  ws.on('error', (err: Error) => {
    log({
      timestamp: new Date().toISOString(),
      direction: 'inbound',
      messageType: 'ws_error',
      peerId,
      error: err.message,
    });
  });
});

export { wss, sessions, peerSession };

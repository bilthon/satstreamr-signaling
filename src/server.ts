import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import { networkInterfaces } from 'os';
import {
  InboundMessage,
  OutboundMessage,
  SessionCreatedMessage,
  SessionRecord,
  LogEntry,
  LogEvent,
  IceServer,
} from './types';
import { generateTurnCredentials } from './turn-credentials';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const HOST = process.env.HOST ?? '0.0.0.0';
const GRACE_PERIOD_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;
let shuttingDown = false;

const TURN_SHARED_SECRET = process.env.TURN_SHARED_SECRET ?? '';
const TURN_HOST = process.env.TURN_HOST ?? 'localhost';

function readFreeSeconds(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function buildIceServers(userId: string): IceServer[] {
  const servers: IceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
  ];
  if (TURN_SHARED_SECRET) {
    const { username, credential } = generateTurnCredentials(TURN_SHARED_SECRET, userId);
    servers.push({
      urls: `turn:${TURN_HOST}:3478`,
      username,
      credential,
    });
  }
  return servers;
}

// In-memory session store
const sessions = new Map<string, SessionRecord>();
// Map from peerId -> sessionId for quick reverse lookup
const peerSession = new Map<string, string>();

function generateSessionId(): string {
  let id: string;
  do {
    id = crypto.randomBytes(3).toString('hex');
  } while (sessions.has(id));
  return id;
}

function log(entry: LogEntry): void {
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function getSessionRole(session: SessionRecord | undefined, peerId: string): 'tutor' | 'viewer' | undefined {
  if (!session) return undefined;
  return session.peerRoles.get(peerId);
}

function logEvent(params: {
  event: LogEvent;
  level?: 'info' | 'warn' | 'error';
  category: 'connection' | 'protocol' | 'session' | 'transport' | 'error' | 'system';
  direction?: 'inbound' | 'outbound';
  peerId?: string;
  sessionId?: string;
  role?: 'tutor' | 'viewer' | 'server';
  details?: Record<string, unknown>;
}): void {
  const legacyAliases: Partial<Record<LogEvent, string>> = {
    server_started: 'server_start',
    ws_connected: 'connection',
    session_rejoined: 'rejoin_ack',
    ws_disconnected: 'disconnection',
  };
  log({
    messageType: legacyAliases[params.event] ??
      (typeof params.details?.messageType === 'string' ? params.details.messageType : params.event),
    ...(params.event === 'ws_error' && typeof params.details?.error === 'string'
      ? { error: params.details.error } : {}),
    ...(params.event === 'server_started' ? {
      host: params.details?.host as string,
      port: params.details?.port as number,
    } : {}),
    timestamp: new Date().toISOString(),
    event: params.event,
    level: params.level ?? 'info',
    category: params.category,
    direction: params.direction,
    peerId: params.peerId,
    sessionId: params.sessionId,
    role: params.role,
    details: params.details,
  });
}

function buildSessionSummary(session: SessionRecord, endedAtMs: number): Record<string, unknown> {
  const createdAtMs = session.createdAtMs;
  const durationMs = Math.max(0, endedAtMs - createdAtMs);
  const billingStartedAtMs = session.firstViewerJoinedAtMs ?? createdAtMs;
  const billableDurationMs = Math.max(0, endedAtMs - billingStartedAtMs);
  const rateSatsPerInterval = session.rateSatsPerInterval ?? 2;
  const intervalSeconds = session.intervalSeconds ?? 10;
  const freeSeconds = session.freeSeconds ?? 0;
  const chargedDurationMs = Math.max(0, billableDurationMs - freeSeconds * 1000);
  const billableIntervalsFloat = chargedDurationMs / (intervalSeconds * 1000);

  return {
    createdAtMs,
    endedAtMs,
    durationMs,
    viewerPresentDurationMs: billableDurationMs,
    rateSatsPerInterval,
    intervalSeconds,
    freeSeconds,
    estimatedSatsEarned: billableIntervalsFloat * rateSatsPerInterval,
    estimatedSatsSpent: billableIntervalsFloat * rateSatsPerInterval,
    viewerJoinCount: session.viewerJoinCount,
    rejoinCount: session.rejoinCount,
    relayOfferCount: session.relayOfferCount,
    relayAnswerCount: session.relayAnswerCount,
    relayIceCandidateCount: session.relayIceCandidateCount,
    bufferedMessageCount: session.bufferedMessageCount,
  };
}

function sendTo(ws: WebSocket, message: OutboundMessage, peerId: string, sessionId?: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    logEvent({
      event: 'ws_message_outbound',
      category: 'protocol',
      direction: 'outbound',
      peerId,
      sessionId,
      details: {
        messageType: message.type,
      },
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
    session.bufferedMessageCount += 1;
    logEvent({
      event: 'ws_message_buffered',
      category: 'transport',
      direction: 'outbound',
      peerId: targetPeerId,
      sessionId,
      details: {
        messageType: message.type,
        reason: 'peer_disconnected',
      },
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

const wss = new WebSocketServer({ host: HOST, port: PORT });

function getLanAddresses(): string[] {
  const addrs: string[] = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        addrs.push(net.address);
      }
    }
  }
  return addrs;
}

wss.on('listening', () => {
  if (process.stderr.isTTY) {
    const banner: string[] = [];
    banner.push('');
    banner.push('╭────────────────────────────────────────────╮');
    banner.push('│  satstreamr signaling server               │');
    banner.push('╰────────────────────────────────────────────╯');
    banner.push(`  bind:    ${HOST}:${PORT}`);
    banner.push(`  local:   ws://localhost:${PORT}`);
    const lan = getLanAddresses();
    if (lan.length > 0 && (HOST === '0.0.0.0' || HOST === '::')) {
      for (const ip of lan) {
        banner.push(`  lan:     ws://${ip}:${PORT}`);
      }
    }
    banner.push('');
    process.stderr.write(banner.join('\n') + '\n');
  }

  logEvent({
    event: 'server_started',
    category: 'system',
    direction: 'outbound',
    peerId: 'server',
    role: 'server',
    details: {
      host: HOST,
      port: PORT,
    },
  });
});

wss.on('connection', (ws: WebSocket) => {
  const peerId = crypto.randomUUID();

  logEvent({
    event: 'ws_connected',
    category: 'connection',
    direction: 'inbound',
    peerId,
  });

  ws.on('message', (rawData: Buffer) => {
    let message: InboundMessage;
    try {
      message = JSON.parse(rawData.toString()) as InboundMessage;
    } catch {
      sendTo(ws, { type: 'error', code: 'INVALID_JSON', message: 'Could not parse JSON' }, peerId);
      logEvent({
        event: 'invalid_json',
        level: 'warn',
        category: 'protocol',
        direction: 'inbound',
        peerId,
      });
      return;
    }

    const sessionId = 'sessionId' in message ? message.sessionId : undefined;

    const existingSession = sessionId ? sessions.get(sessionId) : undefined;
    logEvent({
      event: 'ws_message_inbound',
      category: 'protocol',
      direction: 'inbound',
      peerId,
      sessionId,
      role: getSessionRole(existingSession, peerId),
      details: {
        messageType: message.type,
      },
    });

    switch (message.type) {
      case 'ping': {
        sendTo(ws, { type: 'pong' }, peerId);
        break;
      }

      case 'create_session': {
        const newSessionId = generateSessionId();
        const mintUrl = message.mintUrl ?? '';
        const rateSatsPerInterval = message.rateSatsPerInterval ?? 2;
        const intervalSeconds = message.intervalSeconds ?? 10;
        const freeSeconds = readFreeSeconds(message.freeSeconds);
        const session: SessionRecord = {
          peers: new Map([[peerId, ws]]),
          disconnectedPeers: new Set(),
          buffer: [],
          peerBuffers: new Map(),
          tutorPeerId: peerId,
          mintUrl,
          rateSatsPerInterval,
          intervalSeconds,
          freeSeconds,
          graceTimers: new Map(),
          peerRoles: new Map([[peerId, 'tutor']]),
          createdAtMs: Date.now(),
          viewerJoinCount: 0,
          rejoinCount: 0,
          relayOfferCount: 0,
          relayAnswerCount: 0,
          relayIceCandidateCount: 0,
          bufferedMessageCount: 0,
        };
        sessions.set(newSessionId, session);
        peerSession.set(peerId, newSessionId);
        const tutorCreatedMsg: SessionCreatedMessage = {
          type: 'session_created',
          sessionId: newSessionId,
          iceServers: buildIceServers(peerId),
          ...(mintUrl ? { mintUrl } : {}),
          rateSatsPerInterval,
          intervalSeconds,
          freeSeconds,
        };
        sendTo(ws, tutorCreatedMsg, peerId, newSessionId);
        logEvent({
          event: 'session_created',
          category: 'session',
          sessionId: newSessionId,
          peerId,
          role: 'tutor',
          details: {
            hasTurn: Boolean(TURN_SHARED_SECRET),
            mintUrlPresent: Boolean(mintUrl),
            rateSatsPerInterval,
            intervalSeconds,
          },
        });
        break;
      }

      case 'join_session': {
        const { sessionId: sid } = message;
        const session = sessions.get(sid);
        if (!session) {
          sendTo(ws, { type: 'error', code: 'SESSION_NOT_FOUND', message: `Session ${sid} not found` }, peerId, sid);
          logEvent({
            event: 'session_join_rejected',
            level: 'warn',
            category: 'session',
            peerId,
            sessionId: sid,
            details: {
              reason: 'session_not_found',
            },
          });
          break;
        }
        // Evict any stale disconnected viewer peers before the capacity check.
        // A viewer with a new peerId (fresh join) should replace the old disconnected
        // viewer slot rather than being rejected with SESSION_FULL.
        for (const disconnectedPeerId of session.disconnectedPeers) {
          const role = session.peerRoles.get(disconnectedPeerId);
          if (role !== 'tutor') {
            const timer = session.graceTimers.get(disconnectedPeerId);
            if (timer) clearTimeout(timer);
            session.graceTimers.delete(disconnectedPeerId);
            session.disconnectedPeers.delete(disconnectedPeerId);
            session.peerRoles.delete(disconnectedPeerId);
            session.peerBuffers.delete(disconnectedPeerId);
            peerSession.delete(disconnectedPeerId);
            logEvent({
              event: 'stale_viewer_evicted',
              category: 'session',
              direction: 'outbound',
              peerId: disconnectedPeerId,
              sessionId: sid,
              role: 'viewer',
              details: {
                reason: 'replaced_by_new_viewer',
              },
            });
          }
        }

        if (totalPeerCount(session) >= 2) {
          sendTo(ws, { type: 'error', code: 'SESSION_FULL', message: 'Session already has 2 peers' }, peerId, sid);
          logEvent({
            event: 'session_join_rejected',
            level: 'warn',
            category: 'session',
            peerId,
            sessionId: sid,
            details: {
              reason: 'session_full',
            },
          });
          break;
        }
        session.peers.set(peerId, ws);
        session.peerRoles.set(peerId, 'viewer');
        peerSession.set(peerId, sid);
        session.viewerJoinCount += 1;
        if (!session.firstViewerJoinedAtMs) {
          session.firstViewerJoinedAtMs = Date.now();
        }

        // Notify tutor about new viewer; include iceServers for tutor
        const tutorId = session.tutorPeerId;
        if (tutorId) {
          deliverToPeer(
            session,
            tutorId,
            {
              type: 'viewer_joined',
              viewerId: peerId,
              iceServers: buildIceServers(tutorId),
            },
            sid,
          );
        }
        // Send viewer a session_created message so it learns the iceServers, mintUrl, and rate fields
        const viewerCreatedMsg: SessionCreatedMessage = {
          type: 'session_created',
          sessionId: sid,
          iceServers: buildIceServers(peerId),
          ...(session.mintUrl ? { mintUrl: session.mintUrl } : {}),
          rateSatsPerInterval: session.rateSatsPerInterval ?? 2,
          intervalSeconds: session.intervalSeconds ?? 10,
          freeSeconds: session.freeSeconds ?? 0,
        };
        sendTo(ws, viewerCreatedMsg, peerId, sid);
        logEvent({
          event: 'session_joined',
          category: 'session',
          sessionId: sid,
          peerId,
          role: 'viewer',
          details: {
            activePeerCount: session.peers.size,
            disconnectedPeerCount: session.disconnectedPeers.size,
            tutorRateSatsPerInterval: session.rateSatsPerInterval ?? 2,
            intervalSeconds: session.intervalSeconds ?? 10,
            mintUrlPresent: Boolean(session.mintUrl),
          },
        });
        break;
      }

      case 'offer': {
        const { sessionId: sid, sdp } = message;
        const session = sessions.get(sid);
        if (!session) {
          sendTo(ws, { type: 'error', code: 'SESSION_NOT_FOUND' }, peerId, sid);
          logEvent({
            event: 'session_not_found',
            level: 'warn',
            category: 'session',
            sessionId: sid,
            peerId,
            details: {
              sourceMessageType: 'offer',
            },
          });
          break;
        }
        session.relayOfferCount += 1;
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
          logEvent({
            event: 'session_not_found',
            level: 'warn',
            category: 'session',
            sessionId: sid,
            peerId,
            details: {
              sourceMessageType: 'answer',
            },
          });
          break;
        }
        session.relayAnswerCount += 1;
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
          logEvent({
            event: 'session_not_found',
            level: 'warn',
            category: 'session',
            sessionId: sid,
            peerId,
            details: {
              sourceMessageType: 'ice_candidate',
            },
          });
          break;
        }
        session.relayIceCandidateCount += 1;
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
          logEvent({
            event: 'session_not_found',
            level: 'warn',
            category: 'session',
            sessionId: sid,
            peerId,
            details: {
              sourceMessageType: 'end_session',
            },
          });
          break;
        }
        const endedAtMs = Date.now();
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
        logEvent({
          event: 'session_ended',
          category: 'session',
          sessionId: sid,
          peerId,
          role: getSessionRole(session, peerId),
          details: {
            reason: 'explicit_end_session',
          },
        });
        logEvent({
          event: 'session_summary',
          category: 'session',
          sessionId: sid,
          details: {
            ...buildSessionSummary(session, endedAtMs),
            endedReason: 'explicit_end_session',
          },
        });
        sessions.delete(sid);
        break;
      }

      case 'rejoin_session': {
        const { sessionId: sid } = message;
        const session = sessions.get(sid);
        if (!session) {
          sendTo(ws, { type: 'error', code: 'SESSION_NOT_FOUND', message: `Session ${sid} not found or expired` }, peerId, sid);
          logEvent({
            event: 'session_rejoin_rejected',
            level: 'warn',
            category: 'session',
            sessionId: sid,
            peerId,
            details: {
              reason: 'session_not_found_or_expired',
            },
          });
          break;
        }

        // Find a disconnected peer slot to restore (grace period)
        if (session.disconnectedPeers.size === 0) {
          // No grace-period slots — check if session is full with active peers
          if (session.peers.size >= 2) {
            sendTo(ws, { type: 'error', code: 'SESSION_FULL' }, peerId, sid);
            logEvent({
              event: 'session_rejoin_rejected',
              level: 'warn',
              category: 'session',
              sessionId: sid,
              peerId,
              details: {
                reason: 'session_full',
              },
            });
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
          session.rejoinCount += 1;

          if (role === 'tutor') {
            session.tutorPeerId = peerId;
          }

          // Flush buffered messages intended for the old peerId
          const buffered = session.peerBuffers.get(rejoiningOldPeerId) ?? [];
          session.peerBuffers.delete(rejoiningOldPeerId);

          // Send acknowledgement first, then flush buffer
          sendTo(ws, { type: 'session_rejoined', sessionId: sid, bufferedCount: buffered.length }, peerId, sid);

          for (const msg of buffered) {
            sendTo(ws, msg, peerId, sid);
          }

          logEvent({
            event: 'session_rejoined',
            category: 'session',
            direction: 'outbound',
            peerId,
            sessionId: sid,
            role,
            details: {
              restoredFromPeerId: rejoiningOldPeerId,
              flushedBufferedMessages: buffered.length,
            },
          });
        }
        break;
      }

      default: {
        sendTo(ws, { type: 'error', code: 'UNKNOWN_MESSAGE_TYPE' }, peerId);
        logEvent({
          event: 'unknown_message_type',
          level: 'warn',
          category: 'protocol',
          direction: 'inbound',
          peerId,
          sessionId,
          details: {
            messageType: (message as { type?: unknown }).type,
          },
        });
      }
    }
  });

  ws.on('close', () => {
    if (shuttingDown) return;
    const sid = peerSession.get(peerId);
    const session = sid ? sessions.get(sid) : undefined;
    logEvent({
      event: 'ws_disconnected',
      category: 'connection',
      direction: 'inbound',
      peerId,
      sessionId: sid,
      role: getSessionRole(session, peerId),
    });

    if (!sid) return;
    if (!session) return;

    // Remove from active peers map
    session.peers.delete(peerId);

    // Add to disconnected peers set (grace period tracking)
    session.disconnectedPeers.add(peerId);

    // Set expiry on session
    session.expiresAt = Date.now() + GRACE_PERIOD_MS;

    // Start grace timer
    const timer = setTimeout(() => {
      logEvent({
        event: 'session_grace_expired',
        category: 'session',
        direction: 'outbound',
        peerId,
        sessionId: sid,
        role: getSessionRole(session, peerId),
      });
      session.graceTimers.delete(peerId);
      session.disconnectedPeers.delete(peerId);
      session.peerRoles.delete(peerId);
      session.peerBuffers.delete(peerId);
      peerSession.delete(peerId);

      // If no more active or grace-period peers, evict session
      if (session.peers.size === 0 && session.disconnectedPeers.size === 0) {
        const endedAtMs = Date.now();
        logEvent({
          event: 'session_summary',
          category: 'session',
          sessionId: sid,
          details: {
            ...buildSessionSummary(session, endedAtMs),
            endedReason: 'grace_expired_all_peers',
          },
        });
        sessions.delete(sid);
        logEvent({
          event: 'session_evicted',
          category: 'session',
          direction: 'outbound',
          peerId: 'server',
          sessionId: sid,
          role: 'server',
          details: {
            reason: 'grace_expired_all_peers',
          },
        });
      }
    }, GRACE_PERIOD_MS);

    session.graceTimers.set(peerId, timer);
  });

  ws.on('error', (err: Error) => {
    const sid = peerSession.get(peerId);
    const session = sid ? sessions.get(sid) : undefined;
    logEvent({
      event: 'ws_error',
      level: 'error',
      category: 'error',
      direction: 'inbound',
      peerId,
      sessionId: sid,
      role: getSessionRole(session, peerId),
      details: {
        error: err.message,
      },
    });
  });
});

export { wss, sessions, peerSession };

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent({
    event: 'server_stopping',
    category: 'system',
    peerId: 'server',
    role: 'server',
    details: { signal, activeSessions: sessions.size, connectedClients: wss.clients.size },
  });

  const endedAtMs = Date.now();
  for (const [sid, session] of sessions) {
    for (const [pid, peerWs] of session.peers) {
      sendTo(peerWs, { type: 'session_ended' }, pid, sid);
    }
    for (const timer of session.graceTimers.values()) clearTimeout(timer);
    logEvent({
      event: 'session_summary',
      category: 'session',
      sessionId: sid,
      details: { ...buildSessionSummary(session, endedAtMs), endedReason: 'server_shutdown' },
    });
  }
  sessions.clear();
  peerSession.clear();

  for (const client of wss.clients) client.close(1001, 'server shutting down');

  const finish = () => {
    logEvent({ event: 'server_stopped', category: 'system', peerId: 'server', role: 'server' });
    process.exit(0);
  };
  setTimeout(() => {
    for (const client of wss.clients) client.terminate();
    finish();
  }, SHUTDOWN_TIMEOUT_MS).unref();
  wss.close(finish);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

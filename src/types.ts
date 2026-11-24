import { WebSocket } from 'ws';

// Inbound message types (client -> server)
export type InboundMessageType =
  | 'create_session'
  | 'join_session'
  | 'offer'
  | 'answer'
  | 'ice_candidate'
  | 'end_session'
  | 'ping'
  | 'rejoin_session';

// Outbound message types (server -> client)
export type OutboundMessageType =
  | 'session_created'
  | 'viewer_joined'
  | 'session_ended'
  | 'session_rejoined'
  | 'pong'
  | 'error'
  | 'offer'
  | 'answer'
  | 'ice_candidate';

// Inbound messages
export interface CreateSessionMessage {
  type: 'create_session';
  /** Cashu mint URL — relayed verbatim to both tutor and viewer in session_created. */
  mintUrl?: string;
  /** Rate in satoshis per interval — relayed to viewer in session_created. */
  rateSatsPerInterval?: number;
  /** Payment interval in seconds — relayed to viewer in session_created. */
  intervalSeconds?: number;
}

export interface JoinSessionMessage {
  type: 'join_session';
  sessionId: string;
}

export interface OfferMessage {
  type: 'offer';
  sessionId: string;
  sdp: unknown;
}

export interface AnswerMessage {
  type: 'answer';
  sessionId: string;
  sdp: unknown;
}

export interface IceCandidateMessage {
  type: 'ice_candidate';
  sessionId: string;
  candidate: unknown;
}

export interface EndSessionMessage {
  type: 'end_session';
  sessionId: string;
}

export interface PingMessage {
  type: 'ping';
}

export interface RejoinSessionMessage {
  type: 'rejoin_session';
  sessionId: string;
}

export type InboundMessage =
  | CreateSessionMessage
  | JoinSessionMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | EndSessionMessage
  | PingMessage
  | RejoinSessionMessage;

// ICE server descriptor (STUN or TURN)
export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

// Outbound messages
export interface SessionCreatedMessage {
  type: 'session_created';
  sessionId: string;
  iceServers?: IceServer[];
  /** Echoed from create_session.mintUrl — forwarded to both tutor and viewer. */
  mintUrl?: string;
  /** Rate in satoshis per interval — forwarded to viewer. */
  rateSatsPerInterval?: number;
  /** Payment interval in seconds — forwarded to viewer. */
  intervalSeconds?: number;
}

export interface ViewerJoinedMessage {
  type: 'viewer_joined';
  viewerId: string;
  iceServers?: IceServer[];
}

export interface SessionEndedMessage {
  type: 'session_ended';
}

export interface SessionRejoinedMessage {
  type: 'session_rejoined';
  sessionId: string;
  bufferedCount: number;
}

export interface PongMessage {
  type: 'pong';
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message?: string;
}

export interface RelayOfferMessage {
  type: 'offer';
  sdp: unknown;
  fromPeerId: string;
}

export interface RelayAnswerMessage {
  type: 'answer';
  sdp: unknown;
  fromPeerId: string;
}

export interface RelayIceCandidateMessage {
  type: 'ice_candidate';
  candidate: unknown;
  fromPeerId: string;
}

export type OutboundMessage =
  | SessionCreatedMessage
  | ViewerJoinedMessage
  | SessionEndedMessage
  | SessionRejoinedMessage
  | PongMessage
  | ErrorMessage
  | RelayOfferMessage
  | RelayAnswerMessage
  | RelayIceCandidateMessage;

// Session state
export interface SessionRecord {
  // Active (connected) peer sockets
  peers: Map<string, WebSocket>;
  // Set of peerIds that have disconnected but are within grace period
  disconnectedPeers: Set<string>;
  // Buffer of messages to flush on reconnect, keyed by the peerId they are intended for
  peerBuffers: Map<string, OutboundMessage[]>;
  // Legacy single buffer (kept for compatibility, use peerBuffers going forward)
  buffer: OutboundMessage[];
  expiresAt?: number;
  // Track which peerId is the tutor (session creator)
  tutorPeerId?: string;
  // Cashu mint URL relayed to viewers (set from create_session.mintUrl)
  mintUrl?: string;
  // Rate fields relayed to viewers (set from create_session)
  rateSatsPerInterval?: number;
  intervalSeconds?: number;
  // Track grace period timers keyed by peerId
  graceTimers: Map<string, ReturnType<typeof setTimeout>>;
  // Peer roles: map peerId -> 'tutor' | 'viewer'
  peerRoles: Map<string, 'tutor' | 'viewer'>;
  // Analytics timing and counters for session-level insights
  createdAtMs: number;
  firstViewerJoinedAtMs?: number;
  viewerJoinCount: number;
  rejoinCount: number;
  relayOfferCount: number;
  relayAnswerCount: number;
  relayIceCandidateCount: number;
  bufferedMessageCount: number;
}

export type LogEvent =
  | 'server_started'
  | 'server_stopping'
  | 'server_stopped'
  | 'ws_connected'
  | 'ws_disconnected'
  | 'ws_error'
  | 'ws_message_inbound'
  | 'ws_message_outbound'
  | 'ws_message_buffered'
  | 'invalid_json'
  | 'unknown_message_type'
  | 'session_created'
  | 'session_joined'
  | 'session_join_rejected'
  | 'session_rejoined'
  | 'session_rejoin_rejected'
  | 'session_not_found'
  | 'session_ended'
  | 'session_summary'
  | 'session_grace_expired'
  | 'session_evicted'
  | 'stale_viewer_evicted';

// Log entry structure
export interface LogEntry {
  host?: string;
  port?: number;
  messageType?: string;
  error?: string;
  timestamp: string;
  event: LogEvent;
  level: 'info' | 'warn' | 'error';
  category: 'connection' | 'protocol' | 'session' | 'transport' | 'error' | 'system';
  direction?: 'inbound' | 'outbound';
  peerId?: string;
  sessionId?: string;
  role?: 'tutor' | 'viewer' | 'server';
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

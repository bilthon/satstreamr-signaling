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
  tutorPubkey?: string;
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
  tutorPubkey: string;
  iceServers?: IceServer[];
}

export interface ViewerJoinedMessage {
  type: 'viewer_joined';
  viewerId: string;
  tutorPubkey: string;
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
  // Tutor public key for P2PK token locking (Unit 10)
  tutorPubkey?: string;
  // Track grace period timers keyed by peerId
  graceTimers: Map<string, ReturnType<typeof setTimeout>>;
  // Peer roles: map peerId -> 'tutor' | 'viewer'
  peerRoles: Map<string, 'tutor' | 'viewer'>;
}

// Log entry structure
export interface LogEntry {
  timestamp: string;
  direction: 'inbound' | 'outbound';
  messageType: string;
  peerId: string;
  sessionId?: string;
  [key: string]: unknown;
}

# satstreamr-signaling

Minimal WebSocket signaling server for satstreamr WebRTC sessions.

## What this service is

This repository contains a TypeScript signaling backend that coordinates a
1:1 WebRTC session between:

- tutor (session creator)
- viewer (session joiner)

The server handles signaling only (session management and SDP/ICE relay). Media
flows peer-to-peer over WebRTC.

## What this service is not

- Not a STUN server
- Not a TURN server
- Not persistent storage (all session state is in-memory)

It returns ICE server configuration to clients:

- always includes Google STUN (`stun:stun.l.google.com:19302`)
- optionally includes TURN credentials for an external TURN server when
  `TURN_SHARED_SECRET` is configured

## Project layout

- `signaling/src/server.ts` - WebSocket server and session lifecycle logic
- `signaling/src/types.ts` - inbound/outbound protocol message types
- `signaling/src/turn-credentials.ts` - HMAC TURN credential generation
- `signaling/test/` - integration tests for protocol and TURN behavior

## Requirements

- Node.js (version managed by your local setup)
- npm

## Install

```bash
cd signaling
npm install
```

## Run

Development:

```bash
cd signaling
npm run dev
```

Production-style run:

```bash
cd signaling
npm run build
npm start
```

Or with the helper script:

```bash
cd signaling
./start.sh
```

## Environment variables

Server:

- `HOST` (default: `0.0.0.0`)
- `PORT` (default: `8080`)

TURN integration (optional):

- `TURN_SHARED_SECRET` (empty by default; when set, TURN credentials are added)
- `TURN_HOST` (default: `localhost`)

## Protocol overview

Inbound (client -> server):

- `create_session`
- `join_session`
- `rejoin_session`
- `offer`
- `answer`
- `ice_candidate`
- `end_session`
- `ping`

Outbound (server -> client):

- `session_created`
- `viewer_joined`
- `session_rejoined`
- `offer` (relayed)
- `answer` (relayed)
- `ice_candidate` (relayed)
- `session_ended`
- `pong`
- `error`

## Session model

- Session IDs are short random hex strings
- Max 2 peers per session (tutor + viewer)
- Disconnect grace period: 30 seconds
- Messages for disconnected peers are buffered during grace period
- `rejoin_session` restores a disconnected peer slot and flushes buffered messages

## Logging

The server writes JSON log entries to stdout for inbound/outbound events, with
fields like:

- `timestamp`
- `direction`
- `messageType`
- `peerId`
- `sessionId` (when available)

## Tests

```bash
cd signaling
npm test
```

Current tests cover:

- ping/pong
- session creation/join/full behavior
- offer/answer/ICE relay
- session ending
- reconnect and buffered delivery
- TURN credential injection
- `mintUrl`, `rateSatsPerInterval`, and `intervalSeconds` relay
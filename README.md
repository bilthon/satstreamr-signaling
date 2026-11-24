# satstreamr-signaling

Minimal WebSocket signaling server for [satstreamr](https://github.com/bilthon/satstreamr),
a peer-to-peer metered live video streaming platform.

See the [satstreamr README](https://github.com/bilthon/satstreamr) and
[INSTALL.md](https://github.com/bilthon/satstreamr/blob/main/INSTALL.md) for the
overall architecture and platform setup. Signaling service setup is documented below.

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

- Node.js (use a supported LTS release; peer IDs use native `crypto.randomUUID`)
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

## Deployment

Target: one Linux host running the signaling server under PM2, nginx for
TLS (`wss://`), and coturn as TURN relay. Templates live in `deploy/` and
`signaling/ecosystem.config.js`.

```text
browser --wss:443--> nginx --ws:127.0.0.1:8080--> node (PM2)
browser --turn:3478 + UDP 49152-65535--> coturn
```

### Constraints

- **Exactly one instance.** Sessions live in process memory. Never use PM2
  cluster mode or `instances > 1`.
- **A restart ends every active session.** On `SIGTERM`/`SIGINT` the server
  sends `session_ended` to connected peers, logs a `session_summary` with
  `endedReason: "server_shutdown"`, closes sockets with code `1001`, and
  exits `0` (forced after 3s). Deploy when no streams are live.

### 1. Signaling server (PM2)

Create `signaling/.env` (keep it out of git):

```bash
HOST=127.0.0.1
PORT=8080
TURN_SHARED_SECRET=<openssl rand -hex 32>
TURN_HOST=turn.example.com
```

```bash
npm install -g pm2
pm2 install pm2-logrotate        # stdout JSON logs grow unbounded otherwise
cd signaling
npm ci && npm run build
pm2 start ecosystem.config.js
pm2 save && pm2 startup          # survive reboots (run the printed command)
```

The ecosystem file loads `.env` with `node --env-file` (Node >= 20.6).

Update:

```bash
git pull && cd signaling && npm ci && npm run build
pm2 restart satstreamr-signaling
```

### 2. nginx (TLS + WebSocket proxy)

`deploy/nginx/satstreamr-signaling.conf` is a **location snippet**, not a
standalone site. Add it inside the existing HTTPS `server` block, or replace
its existing `location /ws` block (do not duplicate it). Keep the existing
TLS/Certbot directives, frontend locations, and `/mint/` proxy unchanged.
Do not enable the snippet as a standalone file in `sites-enabled`.

Clients connect to `wss://satstreamr.com/ws` (use your own domain for other
installations). The snippet matches the existing production `/ws` proxy,
including its 24-hour idle timeouts. The Node process must listen on
`127.0.0.1:8080`.

This assumes HTTPS and valid certificates are already configured. For a
new host, configure HTTP and obtain certificates before enabling HTTPS;
this snippet does not provision TLS.

After editing the site's configuration, validate it before reloading:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

A successful configuration test does not verify the upstream: also check a
real WebSocket connection to `/ws` after starting the signaling process.

### 3. coturn

Install coturn and use `deploy/coturn/turnserver.conf` as
`/etc/turnserver.conf`. Set `external-ip`, `realm`, and
`static-auth-secret` (same value as `TURN_SHARED_SECRET`).

### Firewall

- 80/tcp, 443/tcp: nginx
- 3478/tcp+udp: TURN
- 49152-65535/udp: TURN relay range
- 8080: do **not** expose (loopback only)

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

The startup banner is written to stderr only when stderr is an interactive terminal
(`isTTY`). Piped startup emits no banner; the `server_started` JSON event is always
written to stdout.

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

## License

satstreamr-signaling is released under the [MIT License](LICENSE).

Third-party dependencies retain their own licenses; all current runtime
and build-time dependencies are MIT or MIT-compatible. The "satstreamr"
name and logo are not covered by the MIT grant and are reserved by the
author.

#!/usr/bin/env bash
cd "$(dirname "$0")"
npm run build && node dist/server.js

// PM2 process file. Usage (from this directory):
//   npm ci && npm run build
//   pm2 start ecosystem.config.js
//
// Sessions live in process memory: keep exactly one instance in fork mode.
// Cluster mode or instances > 1 would split tutor and viewer across workers.
module.exports = {
  apps: [
    {
      name: 'satstreamr-signaling',
      cwd: __dirname,
      script: 'dist/server.js',
      // Secrets (TURN_SHARED_SECRET) are read from .env; see .env.example.
      node_args: '--env-file=.env',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      // Must exceed the server's own 3s graceful-shutdown timeout.
      kill_timeout: 5000,
      time: false,
      merge_logs: true,
    },
  ],
};

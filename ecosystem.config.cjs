// PM2 config: pm2 start ecosystem.config.cjs
// Logs use the PM2 defaults (~/.pm2/logs/<name>-{out,error}.log).
module.exports = {
  apps: [
    {
      name: "shutter-count",
      script: "bin/start.mjs",
      // Deploy layout: /opt/shutter-count/current -> releases/<id>.
      // SHUTTER_APP_DIR lets PM2 manage the process against the release dir
      // while the symlink flips underneath it.
      cwd: process.env.SHUTTER_APP_DIR || __dirname,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        PORT: 3020,
        HOST: "127.0.0.1",
        BASE_PATH: "/shutter",
        MAX_UPLOAD_MB: 50,
        // Only trust the loopback proxy (nginx); anything else would let
        // clients spoof X-Forwarded-For to dodge the rate limit.
        // Accepts "true"/"false" or a comma-separated list of IPs/CIDRs.
        TRUST_PROXY: "127.0.0.1,::1",
      },
      merge_logs: true,
      time: true,
    },
  ],
};

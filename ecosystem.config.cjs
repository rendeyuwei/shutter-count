// PM2 config: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "shutter-count",
      script: "src/server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        PORT: 3020,
        HOST: "127.0.0.1",
        BASE_PATH: "/shutter",
        MAX_UPLOAD_MB: 50,
        TRUST_PROXY: "true",
      },
      error_file: "logs/shutter-count-error.log",
      out_file: "logs/shutter-count-out.log",
      merge_logs: true,
      time: true,
    },
  ],
};

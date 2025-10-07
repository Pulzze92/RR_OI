module.exports = {
  apps: [
    {
      name: "RR_OI",
      script: "./dist/signalBot.js",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "5s",
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production"
      },
      error_file: "logs/pm2/signal.error.log",
      out_file: "logs/pm2/signal.output.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true
    }
  ]
};

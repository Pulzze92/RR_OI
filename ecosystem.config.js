module.exports = {
  apps: [{
    name: 'bybit-volume-bot',
    script: './dist/index.js',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '5s',
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: 'logs/pm2/error.log',
    out_file: 'logs/pm2/output.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
  }]
}; 
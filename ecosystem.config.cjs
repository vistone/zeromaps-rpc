module.exports = {
  apps: [
    {
      name: 'utls-proxy',
      script: './utls-proxy/utls-proxy',
      cwd: '/opt/zeromaps-rpc',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M', // 提高到 200M
      max_restarts: 10, // 最多重启 10 次
      min_uptime: '10s', // 最小运行时间 10 秒
      restart_delay: 5000, // 重启延迟 5 秒
      error_file: '/opt/zeromaps-rpc/logs/utls-error.log',
      out_file: '/opt/zeromaps-rpc/logs/utls-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        UTLS_PROXY_PORT: '8765',
        UTLS_LOG_FILE: '/var/log/utls-proxy/utls-proxy.log',
        UTLS_LOG_MAX_SIZE_MB: '100',
        UTLS_LOG_MAX_BACKUPS: '5',
        UTLS_LOG_MAX_AGE_DAYS: '7',
        NODE_ENV: 'production'
      }
    },
    {
      name: 'zeromaps-rpc',
      script: './dist/server/index.js',
      cwd: '/opt/zeromaps-rpc',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      error_file: '/opt/zeromaps-rpc/logs/zeromaps-error.log',
      out_file: '/opt/zeromaps-rpc/logs/zeromaps-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info'
      }
    }
  ]
};


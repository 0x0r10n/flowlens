module.exports = {
  apps: [
    {
      name: 'flowlens',
      script: 'npm',
      args: 'start',
      cwd: '/root/flowlens',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        REDIS_URL: 'redis://127.0.0.1:6379'
      },
      max_memory_restart: '600M',
      error_file: '/root/logs/flowlens-error.log',
      out_file: '/root/logs/flowlens-out.log',
      merge_logs: true,
      watch: false,
      autorestart: true
    }
  ]
};

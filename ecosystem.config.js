module.exports = {
  apps: [
    {
      name: 'max-repost-bot',
      script: 'src/index.js',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      watch: false,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

module.exports = {
  apps: [
    {
      name: "telfin",
      script: "dist/index.js",
      autorestart: true,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};

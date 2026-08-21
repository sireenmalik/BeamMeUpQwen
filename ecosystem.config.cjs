module.exports = {
  apps: [{
    name: "crowd-rapp",
    script: "src/server.js",
    cwd: __dirname,
    env: { NODE_ENV: "production", PORT: 3000, TICK_MS: 2000 },
    max_memory_restart: "300M"
  }]
};

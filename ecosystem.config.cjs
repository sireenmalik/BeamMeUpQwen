module.exports = {
  apps: [{
    name: "crowd-rapp",
    script: "src/server.js",
    cwd: __dirname,
    env: {
      NODE_ENV: "production",
      PORT: 3000,
      TICK_MS: 3000,
      MODEL_PROVIDER: "openai",
      MODEL_ENDPOINT: "http://127.0.0.1:11434/v1",
      MODEL_NAME: "beam-v9",
      PROMPT_SCHEMA: "v9"
    },
    max_memory_restart: "600M"
  }]
};

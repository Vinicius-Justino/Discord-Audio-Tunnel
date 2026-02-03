module.exports = {
  apps: [
    {
      name: 'bridge',
      script: 'bridge.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'agentK',
      script: 'agent.js',
      cwd: __dirname,
      env: {
        AGENT_NAME: 'agentK',
        AGENT_ROLE: 'listener',
        HUB_URL: process.env.HUB_URL || 'ws://127.0.0.1:8080'
      }
    },
    {
      name: 'agentJ',
      script: 'agent.js',
      cwd: __dirname,
      env: {
        AGENT_NAME: 'agentJ',
        AGENT_ROLE: 'speaker',
        HUB_URL: process.env.HUB_URL || 'ws://127.0.0.1:8080'
      }
    }
  ]
};

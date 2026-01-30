# Discord Ultra-Low Latency Voice Bridge

A high-performance Node.js Discord bot designed to bridge live audio from a specific user on one server to a voice channel on another server in real-time.

---

## Features

* **Direct Audio Relay (Direct Opus):** The bot passes the sound through "as is" without recalculating it. This saves CPU power and ensures your voice arrives with almost zero delay.
* **Smooth Listening (Seamless Streaming):** To prevent "choppy" audio during internet spikes, the bot uses a smart buffer. This ensures your sentences aren't cut off mid-word.
* **Auto-Follow Mode:** Automatically joins the bridge when the target user enters the source channel and disconnects when they leave.
* **Smart Re-Activation:** If you are quiet, the bot stays ready in the background. The moment you start speaking again, it "wakes up" instantly to broadcast your voice.
* **Linux Optimized:** The bot is specially tuned for Linux servers to run with high priority, making sure other background tasks don't cause lag or stutters.

---

## Technical Architecture

The bot connects to two different Discord voice servers simultaneously. By subscribing to the target user's audio stream on Server A and feeding it directly into an `AudioPlayer` on Server B, we achieve a near-instant relay.

---

## Installation

### 1. Prerequisites
* **Node.js** v20.0.0 or higher
* **Linux Server** (Recommended for network stability)
* **Discord Bot Token** with `GuildVoiceStates` and `Guilds` intents enabled.

### 2. Setup

```bash
# Clone the repository
git clone https://github.com/TTom03/Discord-Audio-Mirroring.git
```

```bash
# Install dependencies
cd discord-voice-bridge
npm install discord.js @discordjs/voice @discordjs/opus libsodium-wrappers opusscript
```

```bash
# Open index.js and update the CONFIG object with your IDs
const CONFIG = {
    token: 'YOUR_BOT_TOKEN',
    playerId: 'USER_ID_TO_MONITOR',
    source: { guildId: 'SERVER_A_ID', channelId: 'CHANNEL_A_ID' },
    dest: { guildId: 'SERVER_B_ID', channelId: 'CHANNEL_B_ID' }
};
```

### 3. Performance
To achieve the best results and eliminate "lag" or "choppy" voice, apply these optimizations on your host:

```bash
# Increase UDP Buffer Limits
sudo sysctl -w net.core.rmem_max=26214400
sudo sysctl -w net.core.wmem_max=26214400
```

### 4. Start the Bot
```bash
# Process Prioritization
sudo nice -n -15 node index.js
```

### 4. Deployment with PM2
```bash
# Start the Bot
pm2 start index.js --name "voice-bridge"
```
```bash
# Enable Auto-Restart on Reboot
pm2 startup
pm2 save
```

## Disclaimer

I take no responsibility for your use of this software. This bot is a proof-of-concept for educational purposes. Users are responsible for ensuring their use of the bot complies with the Discord Terms of Service (ToS). I am not liable for any data loss, server bans, or other issues resulting from the deployment of this code.

---

## Split-run (recommended)

If you run two bots in the same Node process, `@discordjs/voice` will reuse the same voice connection per guild. To avoid that, run one bot per process and relay audio between them using a local WebSocket hub.

1) Install deps (in project root):

```bash
npm install
npm install ws
```

2) Start the bridge hub (on the same host):

```bash
node bridge.js
# or run under pm2
pm2 start bridge.js --name bridge
```

pm2 start agent.js --name agentJ --update-env --env AGENT_TOKEN=<TOKEN_J> --env AGENT_NAME=agentJ --env AGENT_ROLE=speaker
3) Start two agents (example using pm2) — you can pass role/name/token as CLI flags instead of setting env vars:

```bash
# listener (agentK)
pm2 start agent.js --name agentK -- --token <TOKEN_K> --name agentK --role listener --player-id <PLAYER_ID>

# speaker (agentJ)
pm2 start agent.js --name agentJ -- --token <TOKEN_J> --name agentJ --role speaker
```

Optional: pass `--hub ws://host:port` to change the bridge URL, or `--autojoin guildId:channelId` to have the agent automatically join a voice channel on startup.

4) Use text commands in Discord (in server channel):

- `!agentK join` — agentK joins your current voice call as listener
- `!agentJ join` — agentJ joins your current voice call as speaker
- `!agentK leave` / `!agentJ leave` — make them leave
- `!agentK channel` / `!agentJ channel` — report their voice channel

Notes:
- The hub binds to `ws://0.0.0.0:8080` by default. If running on the same machine use `HUB_URL=ws://127.0.0.1:8080` in env.
- Keep the hub accessible only locally or protect it with a simple token if you expose it.

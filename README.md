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
git clone [https://github.com/TTom03/Discord-Audio-Mirroring.git](https://github.com/TTom03/Discord-Audio-Mirroring.git)
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

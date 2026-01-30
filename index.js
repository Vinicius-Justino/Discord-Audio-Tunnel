const { GatewayIntentBits, Client } = require('discord.js');
const Voice = require('@discordjs/voice');
const Dotenv = require('dotenv').config();

/**
 * --- Configuration ---
 */
const CONFIG = {
    agentKtoken: Dotenv.parsed.AGENT_K_TOKEN,
    agentJtoken: Dotenv.parsed.AGENT_J_TOKEN,
    playerId: Dotenv.parsed.PLAYER_ID,
    source: {
        guildId: Dotenv.parsed.SOURCE_GUILD_ID,
        channelId: Dotenv.parsed.SOURCE_CHANNEL_ID
    },
    dest: {
        guildId: Dotenv.parsed.DEST_GUILD_ID,
        channelId: Dotenv.parsed.DEST_CHANNEL_ID
    }
};

const clientK = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const clientJ = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const player = Voice.createAudioPlayer({
    behaviors: { 
        noSubscriber: Voice.NoSubscriberBehavior.Play,
        maxMissedFrames: 60 
    }
});

let connA = null; // listener connection (agentK)
let connB = null; // speaker connection (agentJ)

async function establishBridge() {
    if (connA && connB) return;

    try {
        const guildA = await clientK.guilds.fetch(CONFIG.source.guildId);
        const guildB = await clientJ.guilds.fetch(CONFIG.dest.guildId);

        console.log(`[${new Date().toLocaleTimeString()}] Connected: ${guildA.name} -> ${guildB.name}`);

        connA = Voice.joinVoiceChannel({
            channelId: CONFIG.source.channelId,
            guildId: guildA.id,
            adapterCreator: guildA.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: true,
        });
        connB = Voice.joinVoiceChannel({
            channelId: CONFIG.dest.channelId,
            guildId: guildB.id,
            adapterCreator: guildB.voiceAdapterCreator,
        });

        console.log(`connA: ${clientK.user.tag} joined guild=${guildA.id} channel=${CONFIG.source.channelId}`);
        console.log(`connB: ${clientJ.user.tag} joined guild=${guildB.id} channel=${CONFIG.dest.channelId}`);

        connB.subscribe(player);

        connA.receiver.speaking.on('start', (userId) => {
            if (userId !== CONFIG.playerId) return;
            
            if (player.state.status !== Voice.AudioPlayerStatus.Playing) {
                console.log("Voice found.");
                
                const opusStream = connA.receiver.subscribe(userId, {
                    end: { 
                        behavior: Voice.EndBehaviorType.AfterSilence, 
                        duration: 2000
                    },
                });

                const resource = Voice.createAudioResource(opusStream, { 
                    inputType: Voice.StreamType.Opus,
                    inlineVolume: false 
                });

                player.play(resource);
                
                connB.setSpeaking(true);
            }
        });

        console.log("✅ Bridge ready and activ.");

    } catch (err) {
        console.error("❌ Error:", err.message);
    }
}

function destroyBridge() {
    if (connA) {
        try { connA.destroy(); } catch (e) {}
        connA = null;
    }
    if (connB) {
        try { connB.setSpeaking(false); connB.destroy(); } catch (e) {}
        connB = null;
    }

    player.stop();
    console.log(`[${new Date().toLocaleTimeString()}] Bridge stopped.`);
}

clientK.once('ready', async () => {
    console.log(`AgentK logged in as ${clientK.user.tag}`);
    try {
        const guildA = await clientK.guilds.fetch(CONFIG.source.guildId);
        const member = await guildA.members.fetch(CONFIG.playerId).catch(() => null);

        if (member && member.voice.channelId === CONFIG.source.channelId) {
            if (!clientJ.user) {
                console.log('AgentJ not ready yet — waiting for AgentJ to login...');
                await new Promise(resolve => clientJ.once('ready', resolve));
            }
            establishBridge();
        }
    } catch (e) {
        console.error("Initialization failed");
    }
});

clientJ.once('ready', () => {
    console.log(`AgentJ logged in as ${clientJ.user.tag}`);
});

clientK.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id !== CONFIG.playerId) return;

    const isNowInSource = newState.channelId === CONFIG.source.channelId;
    const wasInSource = oldState.channelId === CONFIG.source.channelId;

    if (!wasInSource && isNowInSource) {
        establishBridge();
    } else if (wasInSource && !isNowInSource) {
        destroyBridge();
    }
});

clientK.on('error', console.error);
clientJ.on('error', console.error);

clientK.login(CONFIG.agentKtoken);
clientJ.login(CONFIG.agentJtoken);

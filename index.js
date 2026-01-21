const Discord = require('discord.js');
const Voice = require('@discordjs/voice');

/**
 * --- Configuration ---
 */
const CONFIG = {
    token: 'YOUR_BOT_TOKEN',
    playerId: 'USER_ID_TO_MONITOR',
    source: { guildId: 'SERVER_A_ID', channelId: 'CHANNEL_A_ID' },
    dest: { guildId: 'SERVER_B_ID', channelId: 'CHANNEL_B_ID' }
};

const client = new Discord.Client({
    intents: [1, 128] 
});

const player = Voice.createAudioPlayer({
    behaviors: { 
        noSubscriber: Voice.NoSubscriberBehavior.Play,
        maxMissedFrames: 60 
    }
});

async function establishBridge() {
    if (Voice.getVoiceConnection(CONFIG.source.guildId)) return;

    try {
        const guildA = await client.guilds.fetch(CONFIG.source.guildId);
        const guildB = await client.guilds.fetch(CONFIG.dest.guildId);

        console.log(`[${new Date().toLocaleTimeString()}] 🔗 Connected: ${guildA.name} -> ${guildB.name}`);

        const connA = Voice.joinVoiceChannel({
            channelId: CONFIG.source.channelId,
            guildId: guildA.id,
            adapterCreator: guildA.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: true,
        });

        const connB = Voice.joinVoiceChannel({
            channelId: CONFIG.dest.channelId,
            guildId: guildB.id,
            adapterCreator: guildB.voiceAdapterCreator,
        });

        connB.subscribe(player);

        connA.receiver.speaking.on('start', (userId) => {
            if (userId !== CONFIG.playerId) return;
            
            if (player.state.status !== Voice.AudioPlayerStatus.Playing) {
                console.log("🎙️ Voice found.");
                
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

/**
 * Schließt alle Verbindungen
 */
function destroyBridge() {
    const connA = Voice.getVoiceConnection(CONFIG.source.guildId);
    const connB = Voice.getVoiceConnection(CONFIG.dest.guildId);
    
    if (connA) connA.destroy();
    if (connB) {
        connB.setSpeaking(false);
        connB.destroy();
    }
    
    player.stop();
    console.log(`[${new Date().toLocaleTimeString()}] Bridge stopped.`);
}

client.once('ready', async () => {
    console.log(`Bot logged in as ${client.user.tag}`);
    try {
        const guildA = await client.guilds.fetch(CONFIG.source.guildId);
        const member = await guildA.members.fetch(CONFIG.playerId).catch(() => null);
        
        if (member && member.voice.channelId === CONFIG.source.channelId) {
            establishBridge();
        }
    } catch (e) {
        console.error("Initialization failed");
    }
});

client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id !== CONFIG.playerId) return;
    
    const isNowInSource = newState.channelId === CONFIG.source.channelId;
    const wasInSource = oldState.channelId === CONFIG.source.channelId;

    if (!wasInSource && isNowInSource) {
        establishBridge();
    } else if (wasInSource && !isNowInSource) {
        destroyBridge();
    }
});

client.on('error', console.error);


client.login(CONFIG.token);

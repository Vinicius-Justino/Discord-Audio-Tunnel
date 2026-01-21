const Discord = require('discord.js');
const Voice = require('@discordjs/voice');

/**
 * --- KONFIGURATION ---
 */
const CONFIG = {
    token: 'YOUR_BOT_TOKEN',
    playerId: 'USER_ID_TO_MONITOR',
    source: { guildId: 'SERVER_A_ID', channelId: 'CHANNEL_A_ID' },
    dest: { guildId: 'SERVER_B_ID', channelId: 'CHANNEL_B_ID' }
};

/**
 * Intents als Zahlenwerte (129 = Guilds + GuildVoiceStates)
 */
const client = new Discord.Client({
    intents: [1, 128] 
});

/**
 * AudioPlayer mit optimiertem Puffer
 */
const player = Voice.createAudioPlayer({
    behaviors: { 
        noSubscriber: Voice.NoSubscriberBehavior.Play,
        maxMissedFrames: 60 
    }
});

/**
 * Funktion zum Aufbau und Überwachen der Brücke
 */
async function establishBridge() {
    // Verhindert mehrfache Verbindungen zum gleichen Server
    if (Voice.getVoiceConnection(CONFIG.source.guildId)) return;

    try {
        const guildA = await client.guilds.fetch(CONFIG.source.guildId);
        const guildB = await client.guilds.fetch(CONFIG.dest.guildId);

        console.log(`[${new Date().toLocaleTimeString()}] 🔗 Verbinde: ${guildA.name} -> ${guildB.name}`);

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

        /**
         * AUTO-REAKTIVIERUNGS-LOGIK
         * Wir hören auf das 'start' Signal des Spielers.
         * Falls der Stream eingeschlafen ist, starten wir ihn neu.
         */
        connA.receiver.speaking.on('start', (userId) => {
            if (userId !== CONFIG.playerId) return;
            
            // Wenn der Player gerade nicht spielt (Idle/Buffering), "wecken" wir ihn auf
            if (player.state.status !== Voice.AudioPlayerStatus.Playing) {
                console.log("🎙️ Stimme erkannt - Stream wird reaktiviert...");
                
                const opusStream = connA.receiver.subscribe(userId, {
                    end: { 
                        behavior: Voice.EndBehaviorType.AfterSilence, 
                        duration: 2000 // Hält die Leitung 2 Sekunden nach dem Reden offen
                    },
                });

                const resource = Voice.createAudioResource(opusStream, { 
                    inputType: Voice.StreamType.Opus,
                    inlineVolume: false 
                });

                player.play(resource);
                
                // Erzwingt den "Sprechend"-Status auf Server B
                connB.setSpeaking(true);
            }
        });

        console.log("✅ Brücke bereit und aktiv.");

    } catch (err) {
        console.error("❌ Fehler beim Aufbau:", err.message);
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
    console.log(`[${new Date().toLocaleTimeString()}] ⏹️ Brücke gestoppt.`);
}

/**
 * Bot Status Events
 */
client.once('ready', async () => {
    console.log(`🚀 Bot eingeloggt als ${client.user.tag}`);
    try {
        const guildA = await client.guilds.fetch(CONFIG.source.guildId);
        const member = await guildA.members.fetch(CONFIG.playerId).catch(() => null);
        
        if (member && member.voice.channelId === CONFIG.source.channelId) {
            establishBridge();
        }
    } catch (e) {
        console.error("Initialprüfung fehlgeschlagen.");
    }
});

/**
 * Automatisches Folgen bei Kanalwechsel
 */
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

// Fehlerbehandlung
client.on('error', console.error);

client.login(CONFIG.token);
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
};

const clientK = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const clientJ = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const player = Voice.createAudioPlayer({
    behaviors: { 
        noSubscriber: Voice.NoSubscriberBehavior.Play,
        maxMissedFrames: 60 
    }
});

let connA = null; // listener connection (agentK)
let connB = null; // speaker connection (agentJ)
let connAInfo = null; // { guildId, channelId }
let connBInfo = null;

let bridgeActive = false;
let bridgeSetup = false;

function safeTag(user) { return `<@${user.id}>`; }

async function establishBridge() {
    // Manual-only: if both sides are connected, attempt to setup the bridge.
    if (!connA || !connB) return;
    console.log(`[${new Date().toLocaleTimeString()}] Manual bridge attempt`);
    trySetupBridge();
}

function trySetupBridge() {
    if (bridgeSetup) return;
    if (!connA || !connB) return;

    try {
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
                bridgeActive = true;
            }
        });

        bridgeSetup = true;
        console.log("✅ Bridge ready and activ.");
    } catch (e) {
        console.error('Failed to setup bridge:', e.message || e);
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
    bridgeActive = false;
    bridgeSetup = false;
    console.log(`[${new Date().toLocaleTimeString()}] Bridge stopped.`);
}

clientK.once('ready', async () => {
    console.log(`AgentK logged in as ${clientK.user.tag}`);
});

clientJ.once('ready', () => {
    console.log(`AgentJ logged in as ${clientJ.user.tag}`);
});

// No automatic voiceStateUpdate handling — manual-only mode.

// Helper: try to make a client join a voice channel where the invoking member is
async function joinInvokerChannel(client, connectionVarName, message) {
    const guild = message.guild;
    if (!guild) {
        await message.channel.send(`${safeTag(message.author)}: este comando precisa ser usado em um servidor.`);
        return null;
    }

    const member = await guild.members.fetch(message.author.id).catch(() => null);
    if (!member || !member.voice || !member.voice.channelId) {
        await message.channel.send(`${safeTag(message.author)}: você precisa estar em uma chamada de voz para usar este comando.`);
        return null;
    }

    try {
        const targetGuild = await client.guilds.fetch(guild.id);
        const channelId = member.voice.channelId;

        // if already connected, destroy to move
        if (connectionVarName === 'A' && connA) { try { connA.destroy(); } catch(e){} connA = null; }
        if (connectionVarName === 'B' && connB) { try { connB.destroy(); } catch(e){} connB = null; }

        const conn = Voice.joinVoiceChannel({
            channelId,
            guildId: targetGuild.id,
            adapterCreator: targetGuild.voiceAdapterCreator,
            selfDeaf: connectionVarName === 'A' ? false : undefined,
            selfMute: connectionVarName === 'A' ? true : undefined,
        });

        if (connectionVarName === 'A') connA = conn;
        else connB = conn;

        if (connectionVarName === 'A') connAInfo = { guildId: targetGuild.id, channelId };
        else connBInfo = { guildId: targetGuild.id, channelId };

        // Verbose diagnostic log for troubleshooting voice/session issues
        try {
            const jc = conn.joinConfig ? { guildId: conn.joinConfig.guildId, channelId: conn.joinConfig.channelId } : null;
            console.log(`[${new Date().toISOString()}] [join] requested by ${client.user.tag} (${client.user.id}) ->`, jc);
            // Also dump the active voice connection stored by @discordjs/voice for this guild
            try {
                const active = Voice.getVoiceConnection(targetGuild.id);
                console.log(`[${new Date().toISOString()}] [voice-active] getVoiceConnection(${targetGuild.id}) ->`, !!active, active && Object.keys(active).slice(0,8));
            } catch (gerr) {
                console.log('[join] getVoiceConnection error', gerr && gerr.message);
            }
            // Print both clients' ids for cross-check
            try { console.log('[clients] clientK=', clientK.user ? `${clientK.user.tag}(${clientK.user.id})` : 'not-logged', 'clientJ=', clientJ.user ? `${clientJ.user.tag}(${clientJ.user.id})` : 'not-logged'); } catch(e){}
        } catch (logErr) {
            console.log('[join] could not log joinConfig', logErr && logErr.message);
        }

        await message.channel.send(`${safeTag(message.author)}: ${client.user.username} entrou no canal de voz.`);
        trySetupBridge();
        return conn;
    } catch (e) {
        await message.channel.send(`${safeTag(message.author)}: falha ao tentar entrar na call: ${e.message || e}`);
        return null;
    }
}

async function leaveClientConnection(client, connectionVarName, message) {
    if (connectionVarName === 'A') {
        if (!connA) {
            await message.channel.send(`${safeTag(message.author)}: ${client.user.username} não está em nenhuma call.`);
            return;
        }
        try { connA.destroy(); } catch (e) {}
        connA = null;
        connAInfo = null;
    } else {
        if (!connB) {
            await message.channel.send(`${safeTag(message.author)}: ${client.user.username} não está em nenhuma call.`);
            return;
        }
        try { connB.setSpeaking(false); connB.destroy(); } catch (e) {}
        connB = null;
        connBInfo = null;
    }

    // disconnect only the target bot; do not stop the bridge here
    await message.channel.send(`${safeTag(message.author)}: ${client.user.username} saiu da call.`);
}

async function handleStartTunnel(message) {
    if (!connA || !connB) {
        const missing = [];
        if (!connA) missing.push('agentK');
        if (!connB) missing.push('agentJ');
        await message.channel.send(`${safeTag(message.author)}: não foi possível iniciar o túnel — faltando conexão: ${missing.join(' e ')}.`);
        return;
    }

    await message.channel.send(`${safeTag(message.author)}: iniciando tentativa de túnel...`);
    await establishBridge();
}

async function handleStopTunnel(message) {
    if (!bridgeActive && !bridgeSetup) {
        await message.channel.send(`${safeTag(message.author)}: não há túnel ativo.`);
        return;
    }
    destroyBridge();
    await message.channel.send(`${safeTag(message.author)}: túnel parado.`);
}

clientK.on('error', console.error);
clientJ.on('error', console.error);

clientK.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const cmd = message.content.trim().toLowerCase();

    if (cmd === '!agentk join') {
        await joinInvokerChannel(clientK, 'A', message);
    } else if (cmd === '!agentk status') {
        const id = clientK.user ? clientK.user.id : 'not logged';
        const tag = clientK.user ? clientK.user.tag : 'not logged';
        const conn = connA;
        const info = connAInfo ? `guild=${connAInfo.guildId} channel=${connAInfo.channelId}` : 'not connected';
        const jc = conn && conn.joinConfig ? `joinConfig: guild=${conn.joinConfig.guildId} channel=${conn.joinConfig.channelId}` : 'joinConfig: none';
        let st = 'none';
        try { st = conn && conn.state && conn.state.status ? `${conn.state.status}` : (conn && conn.state ? 'object' : 'none'); } catch(e){}
        await message.channel.send(`${safeTag(message.author)}: ${tag} (${id}) — ${info} ${jc} | connState=${st} | bridgeActive=${bridgeActive} bridgeSetup=${bridgeSetup}`);
    } else if (cmd === '!agentk whoami') {
        const id = clientK.user ? clientK.user.id : 'not logged';
        const tag = clientK.user ? clientK.user.tag : 'not logged';
        const conn = connA;
        const info = connAInfo ? `guild=${connAInfo.guildId} channel=${connAInfo.channelId}` : 'not connected';
        const jc = conn && conn.joinConfig ? `joinConfig: guild=${conn.joinConfig.guildId} channel=${conn.joinConfig.channelId}` : '';
        await message.channel.send(`${safeTag(message.author)}: ${tag} (${id}) — ${info} ${jc}`);
    } else if (cmd === '!agentj whoami') {
        const id = clientJ.user ? clientJ.user.id : 'not logged';
        const tag = clientJ.user ? clientJ.user.tag : 'not logged';
        const conn = connB;
        const info = connBInfo ? `guild=${connBInfo.guildId} channel=${connBInfo.channelId}` : 'not connected';
        const jc = conn && conn.joinConfig ? `joinConfig: guild=${conn.joinConfig.guildId} channel=${conn.joinConfig.channelId}` : '';
        await message.channel.send(`${safeTag(message.author)}: ${tag} (${id}) — ${info} ${jc}`);
    } else if (cmd === '!agentk channel') {
        // report current server and voice channel for agentK
        if (!connAInfo) {
            await message.channel.send(`${safeTag(message.author)}: ${clientK.user.username} não está em nenhuma call.`);
            return;
        }
        try {
            const g = await clientK.guilds.fetch(connAInfo.guildId).catch(() => null);
            const ch = g ? await g.channels.fetch(connAInfo.channelId).catch(() => null) : null;
            const guildName = g ? g.name : connAInfo.guildId;
            const channelName = ch ? ch.name : connAInfo.channelId;
            await message.channel.send(`${safeTag(message.author)}: ${clientK.user.username} está em **${guildName}** — canal de voz: **${channelName}**.`);
        } catch (e) {
            await message.channel.send(`${safeTag(message.author)}: não foi possível obter informações do canal.`);
        }
    } else if (cmd === '!agentk leave') {
        await leaveClientConnection(clientK, 'A', message);
    } else if (cmd === '!agentk starttunnel') {
        await handleStartTunnel(message);
    } else if (cmd === '!agentk stoptunnel') {
        await handleStopTunnel(message);
    }
});

clientJ.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const cmd = message.content.trim().toLowerCase();

    if (cmd === '!agentj join') {
        await joinInvokerChannel(clientJ, 'B', message);
    } else if (cmd === '!agentj status') {
        const id = clientJ.user ? clientJ.user.id : 'not logged';
        const tag = clientJ.user ? clientJ.user.tag : 'not logged';
        const conn = connB;
        const info = connBInfo ? `guild=${connBInfo.guildId} channel=${connBInfo.channelId}` : 'not connected';
        const jc = conn && conn.joinConfig ? `joinConfig: guild=${conn.joinConfig.guildId} channel=${conn.joinConfig.channelId}` : 'joinConfig: none';
        let st = 'none';
        try { st = conn && conn.state && conn.state.status ? `${conn.state.status}` : (conn && conn.state ? 'object' : 'none'); } catch(e){}
        await message.channel.send(`${safeTag(message.author)}: ${tag} (${id}) — ${info} ${jc} | connState=${st} | bridgeActive=${bridgeActive} bridgeSetup=${bridgeSetup}`);
    } else if (cmd === '!agentj channel') {
        // report current server and voice channel for agentJ
        if (!connBInfo) {
            await message.channel.send(`${safeTag(message.author)}: ${clientJ.user.username} não está em nenhuma call.`);
            return;
        }
        try {
            const g = await clientJ.guilds.fetch(connBInfo.guildId).catch(() => null);
            const ch = g ? await g.channels.fetch(connBInfo.channelId).catch(() => null) : null;
            const guildName = g ? g.name : connBInfo.guildId;
            const channelName = ch ? ch.name : connBInfo.channelId;
            await message.channel.send(`${safeTag(message.author)}: ${clientJ.user.username} está em **${guildName}** — canal de voz: **${channelName}**.`);
        } catch (e) {
            await message.channel.send(`${safeTag(message.author)}: não foi possível obter informações do canal.`);
        }
    } else if (cmd === '!agentj leave') {
        await leaveClientConnection(clientJ, 'B', message);
    }
});

clientK.login(CONFIG.agentKtoken);
clientJ.login(CONFIG.agentJtoken);

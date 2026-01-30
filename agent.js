/*
 agent.js - single-client runner for AgentK/AgentJ
 Usage example (listener):
 AGENT_TOKEN=xxx AGENT_NAME=agentK AGENT_ROLE=listener PLAYER_ID=12345 HUB_URL=ws://localhost:8080 node agent.js

 Usage example (speaker):
 AGENT_TOKEN=yyy AGENT_NAME=agentJ AGENT_ROLE=speaker HUB_URL=ws://localhost:8080 node agent.js
*/

const { GatewayIntentBits, Client } = require('discord.js');
const Voice = require('@discordjs/voice');
const WebSocket = require('ws');
const { Readable } = require('stream');
const Dotenv = require('dotenv').config();

// Simple CLI args parser: --token, --name, --role, --hub, --player-id, --autojoin=guildId:channelId
function parseArgs() {
  const out = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a) continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        const k = a.slice(2, eq);
        const v = a.slice(eq + 1);
        out[k] = v;
      } else {
        const k = a.slice(2);
        // take next arg as value if exists and not another flag
        const next = process.argv[i+1];
        if (next && !next.startsWith('--')) { out[k] = next; i++; } else { out[k] = true; }
      }
    }
  }
  return out;
}

const ARGS = parseArgs();

const NAME = ARGS.name || ARGS.n || process.env.AGENT_NAME || 'agent';
// Resolve TOKEN: prefer explicit CLI/env; otherwise infer from NAME or --input/--output and .env entries
function resolveToken() {
  const explicit = ARGS.token || ARGS.t || process.env.AGENT_TOKEN || (Dotenv.parsed && Dotenv.parsed.AGENT_TOKEN);
  if (explicit) return { token: explicit, source: 'explicit' };

  // Determine effective name: map shorthand flags to conventional agent names if name not provided
  let effective = NAME;
  if ((ARGS.input || ARGS.i) && (!ARGS.name && !ARGS.n && (process.env.AGENT_NAME == null))) effective = 'agentK';
  if ((ARGS.output || ARGS.o) && (!ARGS.name && !ARGS.n && (process.env.AGENT_NAME == null))) effective = 'agentJ';

  const up = effective.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toUpperCase();
  const candidates = [ `${up}_TOKEN`, `AGENT_K_TOKEN`, `AGENT_J_TOKEN` ];

  for (const v of candidates) {
    if (process.env[v]) return { token: process.env[v], source: v };
    if (Dotenv.parsed && Dotenv.parsed[v]) return { token: Dotenv.parsed[v], source: v };
  }

  return { token: null, source: null };
}

const TOKEN_RES = resolveToken();
const TOKEN = TOKEN_RES.token;
// Allow shorthand flags --input / --output for minimal invocation. Prefer explicit --role, then shorthand, then env, then default.
let ROLE = 'listener';
if (ARGS.role || ARGS.r) ROLE = (ARGS.role || ARGS.r);
else if (ARGS.input || ARGS.i) ROLE = 'listener';
else if (ARGS.output || ARGS.o) ROLE = 'speaker';
else ROLE = process.env.AGENT_ROLE || 'listener';
ROLE = ROLE.toLowerCase(); // 'listener' or 'speaker'
const HUB = ARGS.hub || process.env.HUB_URL || 'ws://127.0.0.1:8080';
const PLAYER_ID = ARGS['player-id'] || ARGS.playerId || process.env.PLAYER_ID || (Dotenv.parsed && Dotenv.parsed.PLAYER_ID);
const AUTOJOIN = ARGS.autojoin || process.env.AUTOJOIN || null; // expected format guildId:channelId

if (!TOKEN) {
  console.error('AGENT_TOKEN not provided. Tried resolving from env/candidates. Set AGENT_K_TOKEN or AGENT_J_TOKEN or pass --token.');
  process.exit(1);
} else {
  console.log(`Using token from ${TOKEN_RES.source || 'explicit/ENV'}`);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
let conn = null;
let connInfo = null;
let player = Voice.createAudioPlayer({ behaviors: { noSubscriber: Voice.NoSubscriberBehavior.Play } });

let ws = null;
let currentReadable = null;
let tunnelEnabled = false; // manual control: only forward audio when true
let announceId = null;
// pending queues for listener: key = `${source}:${userId}` where source is this listener's announceId
const pendingQueues = new Map();
// Speaker-side jitter buffer / playback smoothing
const OPUS_FRAME_MS = Number(process.env.OPUS_FRAME_MS || ARGS.opusMs || 20);
// Adjusted defaults: favor modest warmup, larger coalescing
const WARMUP_FRAMES = Number(process.env.WARMUP_FRAMES || ARGS.warmup || 6);
const MAX_SPEAKER_BUFFER = Number(process.env.MAX_SPEAKER_BUFFER || ARGS.maxBuf || 5000);
// Coalescing (listener-side): send N Opus frames together or after a timeout
const COALESCE_FRAMES = Number(process.env.COALESCE_FRAMES || ARGS.coalesceFrames || 6);
const COALESCE_MS = Number(process.env.COALESCE_MS || ARGS.coalesceMs || (OPUS_FRAME_MS * COALESCE_FRAMES));
let speakerBuffer = [];
let speakerPlaybackTimer = null;
let speakerPlayingSource = null; // track which source we're playing
// track last-seen sequence per source to avoid duplicates
const speakerLastSeq = new Map();

// Helper: coalesce & send buffered frames for a listener info entry
function flushCoalesce(info){
  try{
    if (!info || !info.coalesceBuffer || !info.coalesceBuffer.length) return;
    if (!(ws && ws.readyState === WebSocket.OPEN)) return;
    // pack each frame with a 4-byte seq + 2-byte big-endian length prefix so the speaker can split and dedupe
    const parts = [];
    for (const b of info.coalesceBuffer){
      const seq = info.seq || 1;
      const seqBuf = Buffer.allocUnsafe(4);
      seqBuf.writeUInt32BE(seq, 0);
      const lenBuf = Buffer.allocUnsafe(2);
      lenBuf.writeUInt16BE(b.length, 0);
      parts.push(seqBuf);
      parts.push(lenBuf);
      parts.push(b);
      info.seq = seq + 1;
    }
    const out = Buffer.concat(parts);
    ws.send(out);
    info.coalesceBuffer.length = 0;
    if (info.coalesceTimer){ clearTimeout(info.coalesceTimer); info.coalesceTimer = null; }
  }catch(e){ log('flushCoalesce err', e && e.message); }
}

function ensureCoalesceTimer(info){
  if (info.coalesceTimer) return;
  info.coalesceTimer = setTimeout(()=>{ try{ flushCoalesce(info); }catch(e){ log('coalesce timer err', e && e.message); } }, COALESCE_MS);
}

function log(...a){ console.log(new Date().toISOString(), ...a); }

async function safeSend(channel, text) {
  try {
    log('sending', { channel: channel && channel.id, text: text && text.slice ? text.slice(0,200) : text });
    await channel.send(text);
  } catch (e) {
    log('sendErr', e && e.message);
  }
}

client.once('ready', () => {
  log(`${NAME} logged in as ${client.user.tag} role=${ROLE}`);
  connectHub();
  // If autojoin provided as guildId:channelId, attempt to join immediately
  if (AUTOJOIN) {
    const parts = AUTOJOIN.split(':');
    if (parts.length === 2) {
      const g = parts[0]; const ch = parts[1];
      setTimeout(()=>{
        autoJoinTo(g, ch).catch((e)=> log('autojoin failed', e && e.message));
      }, 800);
    }
  }
});

client.on('error', console.error);

async function connectHub(){
  ws = new WebSocket(HUB);
  ws.on('open', () => {
    log('ws open');
    announceId = `${NAME}-${client.user.id}-${Date.now()}`;
    log('ws announce id', announceId);
    ws.send(JSON.stringify({ type: 'announce', id: announceId, role: ROLE, clientId: client.user.id }));
  });

  ws.on('message', (data) => {
    // Normalize incoming frame: try to decode Buffers containing UTF-8 JSON
    let text = null;
    if (typeof data === 'string' || data instanceof String) {
      text = data;
    } else {
      try {
        const buf = Buffer.from(data);
        const s = buf.toString('utf8');
        if (s && (s[0] === '{' || s[0] === '[')) text = s;
        else data = buf; // keep as Buffer for binary handling
      } catch (e) {}
    }

    if (text != null) {
      let msg = null;
      try{ msg = JSON.parse(text); }catch(e){}
      if (!msg) return;
      // Handle ACKs for listeners
      if (msg.type === 'audio-ack' && ROLE === 'listener'){
        // Explicit, easy-to-grep receive log for ACKs
        log('AUDIO_ACK_RECV', { from: msg.speaker || null, source: msg.source, userId: msg.userId });
        const key = `${msg.source}:${msg.userId}`;
        const info = pendingQueues.get(key);
        if (info){
          log('ws recv', 'audio-ack', key, 'flushing queued count', info.queue.length);
          // move queued chunks into coalesce buffer and start coalesce timer / flush
          if (!info.coalesceBuffer) info.coalesceBuffer = [];
          while (info.queue && info.queue.length){ info.coalesceBuffer.push(info.queue.shift()); }
          info.acked = true;
          if (info.coalesceBuffer.length) {
            // if we have enough frames, send immediately, otherwise schedule flush
            if (info.coalesceBuffer.length >= COALESCE_FRAMES) flushCoalesce(info);
            else ensureCoalesceTimer(info);
          }
          // if stream already ended, send audio-end after flush
          if (info.ended){
            // ensure remaining coalesced frames are flushed, then send audio-end
            try{ flushCoalesce(info); }catch(e){ }
            try{ if (ws && ws.readyState === WebSocket.OPEN){ ws.send(JSON.stringify({ type: 'audio-end', userId: msg.userId, source: msg.source })); } }catch(e){}
          }
        }
        return;
      }
      if (msg.type === 'audio-start'){
        log('audio-start', msg.userId);
        log('speaker', 'creating readable resource for', msg.userId);
        // reset and prepare jitter buffer state for this incoming source
        speakerBuffer = [];
        if (speakerPlaybackTimer) { clearInterval(speakerPlaybackTimer); speakerPlaybackTimer = null; }
        speakerPlayingSource = msg.source || null;
        currentReadable = new Readable({ read(){} });
        const resource = Voice.createAudioResource(currentReadable, { inputType: Voice.StreamType.Opus });
        log('speaker', 'player.play invoked for', msg.userId);
        player.play(resource);
        if (!conn) log('speaker: no voice connection to play to');
        // send ACK back to the listener source so it can start sending chunks
        try{
          if (ws && ws.readyState === WebSocket.OPEN && msg.source){
            const ack = { type: 'audio-ack', userId: msg.userId, source: msg.source, speaker: announceId };
            ws.send(JSON.stringify(ack));
            // Strong, unique log entry for ACK send
            log('AUDIO_ACK_SEND', { to: msg.source, userId: msg.userId, speaker: announceId });
          }
        }catch(e){ log('ws ack err', e && e.message); }
      } else if (msg.type === 'audio-end'){
        log('audio-end', msg.userId);
        // stop playback timer and close readable after flushing buffer
        if (speakerPlaybackTimer) { clearInterval(speakerPlaybackTimer); speakerPlaybackTimer = null; }
        if (currentReadable){
          // flush remaining buffered frames
          try{
            while (speakerBuffer && speakerBuffer.length){ currentReadable.push(speakerBuffer.shift()); }
          }catch(e){ log('flush err', e && e.message); }
          currentReadable.push(null);
          currentReadable = null;
        }
      }
    } else {
      // binary frame (Opus) - always log receipt so we can correlate with bridge forwards
      try{
        const len = data && data.length ? data.length : null;
        log('ws binary rx', { len, role: ROLE, announceId, hasReadable: !!currentReadable });
        if (ROLE === 'speaker'){
          if (!currentReadable){
            // no target to play into: drop but log
            log('ws recv chunk dropped - no readable', len);
          } else {
            // incoming data may contain multiple length-prefixed frames; parse them
              try{
              const buf = Buffer.from(data);
              let offset = 0;
              let pushedAny = false;
              while (offset < buf.length){
                // expect 4-byte seq + 2-byte length header
                if (offset + 6 <= buf.length){
                  const seq = buf.readUInt32BE(offset);
                  const fragLen = buf.readUInt16BE(offset + 4);
                  if (fragLen > 0 && offset + 6 + fragLen <= buf.length){
                    const frame = buf.slice(offset + 6, offset + 6 + fragLen);
                    // dedupe by sequence for the current playing source
                    const src = speakerPlayingSource || 'unknown';
                    const last = speakerLastSeq.get(src) || 0;
                    if (seq <= last){
                      log('duplicate frame detected', { src, seq, last });
                    } else {
                      speakerLastSeq.set(src, seq);
                      if (speakerBuffer.length < MAX_SPEAKER_BUFFER) speakerBuffer.push(frame);
                      else { speakerBuffer.shift(); speakerBuffer.push(frame); log('speaker buffer overflow - dropping oldest frame'); }
                    }
                    offset += 6 + fragLen;
                    pushedAny = true;
                    continue;
                  }
                }
                // fallback: remainder is a single frame (no header)
                const remainder = buf.slice(offset);
                if (remainder.length){
                  if (speakerBuffer.length < MAX_SPEAKER_BUFFER) speakerBuffer.push(remainder);
                  else { speakerBuffer.shift(); speakerBuffer.push(remainder); log('speaker buffer overflow - dropping oldest frame'); }
                  pushedAny = true;
                }
                break;
              }
              // if we have enough frames buffered and playback not started, start timer
              if (!speakerPlaybackTimer && speakerBuffer.length >= WARMUP_FRAMES){
                speakerPlaybackTimer = setInterval(()=>{
                  try{
                    if (!currentReadable) return;
                    const frame = speakerBuffer.shift();
                    if (frame) currentReadable.push(frame);
                  }catch(e){ log('playback err', e && e.message); }
                }, OPUS_FRAME_MS);
                log('speaker jitter buffer started', { warmup: WARMUP_FRAMES, intervalMs: OPUS_FRAME_MS });
              }
            }catch(e){ log('ws recv parse err', e && e.message); }
          }
        }
      }catch(e){ log('ws recv err', e && e.message); }
    }
  });

  ws.on('close', () => { log('ws close - reconnecting in 1s'); setTimeout(connectHub, 1000); });
  ws.on('error', (e)=> log('ws err', e && e.message));
}

// Helper: join the invoker's voice channel (via message command)
async function joinInvokerChannel(message) {
  const guild = message.guild;
  if (!guild) { await safeSend(message.channel, `<@${message.author.id}>: este comando precisa ser usado em um servidor.`); return null; }
  const member = await guild.members.fetch(message.author.id).catch(()=>null);
  if (!member || !member.voice || !member.voice.channelId) { await safeSend(message.channel, `<@${message.author.id}>: você precisa estar em uma call.`); return null; }

  try {
    const targetGuild = await client.guilds.fetch(guild.id);
    const channelId = member.voice.channelId;

    if (conn) try{ conn.destroy(); }catch(e){}

    conn = Voice.joinVoiceChannel({ channelId, guildId: targetGuild.id, adapterCreator: targetGuild.voiceAdapterCreator, selfDeaf: ROLE === 'listener' ? false : undefined, selfMute: ROLE === 'listener' ? true : undefined });
    connInfo = { guildId: targetGuild.id, channelId };

    await safeSend(message.channel, `<@${message.author.id}>: ${client.user.username} entrou no canal de voz.`);

    // If listener, hook receiver and stream opus frames to hub
    if (ROLE === 'listener'){
      conn.receiver.speaking.on('start', (userId)=>{
        if (PLAYER_ID && userId !== PLAYER_ID) return;
        log('detected speaking', userId, 'tunnelEnabled=', tunnelEnabled);
        if (!tunnelEnabled) return; // do nothing unless tunnel manually enabled
        const key = `${announceId}:${userId}`;
        const info = { queue: [], acked: false, ended: false, coalesceBuffer: [], coalesceTimer: null, seq: 1 };
        pendingQueues.set(key, info);
        const opusStream = conn.receiver.subscribe(userId, { end: { behavior: Voice.EndBehaviorType.AfterSilence, duration: 2000 } });
        // announce (include this listener's announceId as source so speaker can ACK)
        if (ws && ws.readyState === WebSocket.OPEN){
          log('ws send', 'audio-start', userId, 'source=', announceId);
          ws.send(JSON.stringify({ type: 'audio-start', userId, source: announceId }));
        } else {
          log('ws not open - cannot send audio-start', userId);
        }
        opusStream.on('data', (chunk)=>{
          try{
            if (!info.acked){
              // buffer until ACK from speaker
              if (info.queue.length < 1000) info.queue.push(chunk);
              else log('pending queue full - dropping chunk', key);
            } else {
              // coalesce frames before sending to reduce small-packet overhead
              if (!info.coalesceBuffer) info.coalesceBuffer = [];
              info.coalesceBuffer.push(chunk);
              // if we have enough frames, flush immediately
              if (info.coalesceBuffer.length >= COALESCE_FRAMES) { flushCoalesce(info); }
              else { ensureCoalesceTimer(info); }
            }
          }catch(e){ log('ws send chunk err', e && e.message); }
        });
        opusStream.on('end', ()=>{
          info.ended = true;
          // flush coalesced frames if any
          try{ flushCoalesce(info); }catch(e){}
          if (info.acked){
            if (ws && ws.readyState === WebSocket.OPEN){ log('ws send', 'audio-end', userId, 'source=', announceId); ws.send(JSON.stringify({ type: 'audio-end', userId, source: announceId })); }
            else log('ws not open - audio-end', userId);
          } else {
            // still send audio-end so hub/speakers can clean up when/if they get audio-start
            if (ws && ws.readyState === WebSocket.OPEN){ log('ws send', 'audio-end (pre-ack)', userId, 'source=', announceId); ws.send(JSON.stringify({ type: 'audio-end', userId, source: announceId })); }
            else log('ws not open - audio-end', userId);
          }
        });
      });
    }

    // If speaker, subscribe player to connection
    if (ROLE === 'speaker'){
      conn.subscribe(player);
    }

    return conn;
  } catch (e) {
    await safeSend(message.channel, `<@${message.author.id}>: falha ao entrar na call: ${e.message}`);
    return null;
  }
}

// Auto-join helper for startup (no message)
async function autoJoinTo(guildId, channelId) {
  try {
    const targetGuild = await client.guilds.fetch(guildId);
    if (!targetGuild) { log('autoJoin: guild not found', guildId); return null; }

    if (conn) try{ conn.destroy(); }catch(e){}

    conn = Voice.joinVoiceChannel({ channelId, guildId: targetGuild.id, adapterCreator: targetGuild.voiceAdapterCreator, selfDeaf: ROLE === 'listener' ? false : undefined, selfMute: ROLE === 'listener' ? true : undefined });
    connInfo = { guildId: targetGuild.id, channelId };
    log('auto-joined', guildId, channelId);

    if (ROLE === 'listener'){
      conn.receiver.speaking.on('start', (userId)=>{
        if (PLAYER_ID && userId !== PLAYER_ID) return;
        log('detected speaking', userId);
        const key = `${announceId}:${userId}`;
        const info = { queue: [], acked: false, ended: false, coalesceBuffer: [], coalesceTimer: null, seq: 1 };
        pendingQueues.set(key, info);
        const opusStream = conn.receiver.subscribe(userId, { end: { behavior: Voice.EndBehaviorType.AfterSilence, duration: 2000 } });
        if (ws && ws.readyState === WebSocket.OPEN){
          log('ws send', 'audio-start', userId, 'source=', announceId);
          ws.send(JSON.stringify({ type: 'audio-start', userId, source: announceId }));
        } else {
          log('ws not open - cannot send audio-start', userId);
        }
        opusStream.on('data', (chunk)=>{
          try{
            if (!info.acked){
              if (info.queue.length < 1000) info.queue.push(chunk);
              else log('pending queue full - dropping chunk', key);
            } else {
              if (!info.coalesceBuffer) info.coalesceBuffer = [];
              info.coalesceBuffer.push(chunk);
              if (info.coalesceBuffer.length >= COALESCE_FRAMES) { flushCoalesce(info); }
              else { ensureCoalesceTimer(info); }
            }
          }catch(e){ log('ws send chunk err', e && e.message); }
        });
        opusStream.on('end', ()=>{
          info.ended = true;
          try{ flushCoalesce(info); }catch(e){}
          if (info.acked){ if (ws && ws.readyState === WebSocket.OPEN){ log('ws send', 'audio-end', userId, 'source=', announceId); ws.send(JSON.stringify({ type: 'audio-end', userId, source: announceId })); } else log('ws not open - audio-end', userId); }
          else { if (ws && ws.readyState === WebSocket.OPEN){ log('ws send', 'audio-end (pre-ack)', userId, 'source=', announceId); ws.send(JSON.stringify({ type: 'audio-end', userId, source: announceId })); } else log('ws not open - audio-end', userId); }
        });
      });
    }

    if (ROLE === 'speaker'){
      conn.subscribe(player);
    }

    return conn;
  } catch (e) {
    log('autoJoin error', e && e.message);
    return null;
  }
}

async function leaveChannel(message){
  if (!conn) { await safeSend(message.channel, `<@${message.author.id}>: não estou em nenhuma call.`); return; }
  try{ if (ROLE === 'speaker') conn.setSpeaking(false); conn.destroy(); }catch(e){}
  conn = null; connInfo = null;
  await safeSend(message.channel, `<@${message.author.id}>: saí da call.`);
}

client.on('messageCreate', async (message)=>{
  // debug: log all incoming messages to verify events are received
  try {
    log('messageCreate', { author: message.author && message.author.tag ? message.author.tag : message.author && message.author.id, bot: message.author && message.author.bot, guild: message.guild && message.guild.id, channel: message.channel && message.channel.id, content: message.content ? message.content.slice(0,200) : null });
  } catch(e) { console.error('msgLogErr', e && e.message); }
  if (message.author.bot) return;

  const raw = (message.content || '').trim();
  if (!raw.startsWith('!')) return;
  const parts = raw.slice(1).split(/\s+/);
  const addressed = parts[0].toLowerCase();
  const args = parts.slice(1);

  // Build list of acceptable names for this agent: configured NAME, resolved client username, and token-inferred names
  const myNames = new Set();
  if (NAME) myNames.add(NAME.toLowerCase());
  try { if (client.user && client.user.username) myNames.add(client.user.username.toLowerCase()); } catch(e){}
  if (TOKEN_RES && TOKEN_RES.source) {
    const s = (TOKEN_RES.source || '').toUpperCase();
    if (s.includes('AGENT_K')) myNames.add('agentk');
    if (s.includes('AGENT_J')) myNames.add('agentj');
  }

  if (!myNames.has(addressed)) return; // message not addressed to this agent

  const sub = args[0] ? args[0].toLowerCase() : '';
  // tunnel control commands
  if (sub === 'starttunnel') {
    tunnelEnabled = true;
    await safeSend(message.channel, `<@${message.author.id}>: túnel ativado.`);
    return;
  } else if (sub === 'stoptunnel') {
    tunnelEnabled = false;
    await safeSend(message.channel, `<@${message.author.id}>: túnel desativado.`);
    return;
  }
  if (sub === 'join') {
    await joinInvokerChannel(message);
  } else if (sub === 'leave') {
    await leaveChannel(message);
  } else if (sub === 'channel') {
    if (!connInfo) { await safeSend(message.channel, `<@${message.author.id}>: não estou em nenhuma call.`); return; }
    const g = await client.guilds.fetch(connInfo.guildId).catch(()=>null);
    const ch = g ? await g.channels.fetch(connInfo.channelId).catch(()=>null) : null;
    const guildName = g ? g.name : connInfo.guildId;
    const channelName = ch ? ch.name : connInfo.channelId;
    await safeSend(message.channel, `<@${message.author.id}>: ${client.user.username} está em **${guildName}** — canal de voz: **${channelName}**.`);
  } else if (sub === 'whoami') {
    const id = client.user ? client.user.id : 'not logged';
    const tag = client.user ? client.user.tag : 'not logged';
    const conn = connInfo ? conn : null;
    const info = connInfo ? `guild=${connInfo.guildId} channel=${connInfo.channelId}` : 'not connected';
    await safeSend(message.channel, `<@${message.author.id}>: ${tag} (${id}) — ${info}`);
  }
});

client.login(TOKEN).catch((e)=>{ console.error('login error', e && e.message); process.exit(1); });

process.on('SIGINT', ()=>{ try{ if (conn) conn.destroy(); }catch(e){} process.exit(0); });

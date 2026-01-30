// Simple WebSocket hub for local audio relay
// Usage: node bridge.js
// Listens on ws://0.0.0.0:8080 by default

const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

// clients: { id -> { ws, role, clientId } }
const clients = new Map();
// buffered binary frames per source id when audio-start not yet seen by hub
const buffered = new Map();
// tracks which sources have announced audio-start (so we can forward binaries immediately)
const audioStarted = new Set();

function log(...args){ console.log(new Date().toISOString(), ...args); }

wss.on('connection', (ws) => {
  let meta = { id: `conn-${Date.now()}-${Math.random()}`, role: null, clientId: null };
  // register temporary client entry so binary frames can be forwarded even before announce
  clients.set(meta.id, { ws, role: null, clientId: null, temp: true });
  log('[connect]', meta.id, 'clients=', clients.size);

  ws.on('message', (data) => {
    // JSON control frames may arrive as strings or as Buffers containing UTF-8 JSON text;
    // audio frames are binary Buffers that are not JSON.
    let text = null;
    if (typeof data === 'string' || data instanceof String) {
      text = data;
    } else {
      // coerce ArrayBuffer/TypedArray to Buffer for decoding
      try {
        const buf = Buffer.from(data);
        const s = buf.toString('utf8');
        if (s && (s[0] === '{' || s[0] === '[')) text = s;
        else data = buf; // keep as Buffer for binary handling below
      } catch (e) {
        // not decodable as Buffer; fall through to binary handling
      }
    }

    if (text != null) {
      try {
        // log raw control frame (trimmed)
        log('[rcv control]', 'from=', meta.id, 'len=', (text && text.length) || 0, 'payload=', text.slice(0,200));
        const msg = JSON.parse(text);
        if (msg.type === 'announce') {
          // if this socket had a temporary id, replace it with announced id
          const announcedId = msg.id || `${Date.now()}-${Math.random()}`;
          const prevId = meta.id;
          meta.id = announcedId;
          meta.role = msg.role;
          meta.clientId = msg.clientId;
          // remove previous temp entry if different id
          if (prevId && clients.has(prevId) && prevId !== announcedId) clients.delete(prevId);
          clients.set(meta.id, { ws, role: meta.role, clientId: meta.clientId });
            log('[announce]', meta.id, meta.role, meta.clientId, 'clients=', clients.size);
            // diagnostic: list known clients (short)
            try{ log('[clients snapshot]', Array.from(clients.entries()).map(([id,c])=>({id,role:c.role})).slice(0,20)); }catch(e){}
          // notify others
          broadcast(JSON.stringify({ type: 'peer', id: meta.id, role: meta.role, clientId: meta.clientId }));
        } else if (msg.type === 'control') {
          // forward control messages to peers
          log('[control]', meta.id, msg);
          broadcast(JSON.stringify(msg), meta.id);
        } else if (msg.type === 'audio-ack') {
          // forward ACK back to the originating listener (by source id)
          log('AUDIO_ACK_RX', { from: meta.id, payload: msg });
          const target = msg.source;
          if (target && clients.has(target)){
            try { clients.get(target).ws.send(JSON.stringify(msg)); log('AUDIO_ACK_FWD', { to: target, from: meta.id }); }
            catch(e){ log('audio-ack send err', e && e.message); }
          } else {
            log('AUDIO_ACK_MISSING_TARGET', { target, knownClients: Array.from(clients.keys()).slice(0,10) });
          }
        } else if (msg.type === 'audio-start' || msg.type === 'audio-end') {
          // forward audio control only to speaker peers
          log('[audio-control]', msg.type, 'from=', meta.id, 'payload.source=', msg.source);
            // diagnostic: snapshot clients when audio-control arrives
            try{ log('[clients snapshot on audio-control]', Array.from(clients.entries()).map(([id,c])=>({id,role:c.role})).slice(0,20)); }catch(e){}
          // mark audio-start for this source so later binaries are forwarded immediately
          if (msg.type === 'audio-start') {
            audioStarted.add(meta.id);
          }

          // forward the control message to speaker peers first so they can prepare
          for (const [id, c] of clients.entries()){
            if (id === meta.id) continue;
            // forward to explicit speakers or to not-yet-announced (null) peers
              if (c.role !== 'speaker' && c.role !== null) continue;
            try { c.ws.send(JSON.stringify(msg)); log('[audio-control fwd]', 'to=', id, 'role=', c.role); } catch(e){ log('audio-control send err', e && e.message); }
          }

          // flush any buffered binaries for this source after yielding to the event loop
          // (gives speakers a chance to handle the audio-start JSON and create resources)
          const q = buffered.get(meta.id);
          if (q && q.length) {
            setImmediate(() => {
              log('[flush]', 'flushing', q.length, 'frames for', meta.id);
              for (const buf of q) broadcastBinary(buf, meta.id);
              buffered.delete(meta.id);
            });
          }

          // if audio-end, clear state for this source
          if (msg.type === 'audio-end') { audioStarted.delete(meta.id); buffered.delete(meta.id); }
        }
      } catch (e) {
        log('bad-json', e && e.message);
      }
    } else {
      // binary: forward to all peers except sender, but ensure audio-start ordering
      const len = data && data.length ? data.length : 0;
      log('[binary rx]', 'from=', meta.id, 'len=', len, 'clients=', clients.size);
      if (audioStarted.has(meta.id)){
        // we have seen audio-start for this source, forward immediately
        broadcastBinary(data, meta.id);
      } else {
        // buffer until we see audio-start from this meta.id
        let q = buffered.get(meta.id);
        if (!q) { q = []; buffered.set(meta.id, q); }
        // safety: limit buffer length to avoid memory blowup
        if (q.length < 1000) q.push(data);
        else log('[buffer overflow]', 'dropping frame for', meta.id);
      }
    }
  });

  ws.on('close', () => {
    if (meta.id) {
      clients.delete(meta.id);
      broadcast(JSON.stringify({ type: 'peer-left', id: meta.id }));
      log('[left]', meta.id);
    }
  });

  ws.on('error', (err) => log('ws error', err && err.message));
});

function broadcast(msg, exceptId){
  for (const [id, c] of clients.entries()){
    if (id === exceptId) continue;
    try { c.ws.send(msg); } catch(e){}
  }
}

function broadcastBinary(buf, exceptId){
  for (const [id, c] of clients.entries()){
    if (id === exceptId) continue;
    try {
      c.ws.send(buf);
      log('[binary fwd]', 'to=', id, 'len=', buf && buf.length ? buf.length : 0);
    } catch(e){ log('binary fwd err', id, e && e.message); }
  }
}

log('bridge listening on ws://0.0.0.0:8080');

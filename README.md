# Discord Audio Tunnel

Pequeno projeto para encaminhar áudio Opus entre instâncias locais usando um hub WebSocket.

**Visão geral**
- `agent.js`: executa tanto como *listener* (captura áudio de um canal Discord e envia ao hub) quanto como *speaker* (recebe áudio do hub e reproduz em um canal Discord).
- `bridge.js`: hub WebSocket simples que encaminha mensagens de controle e buffers binários entre agentes.

Protocolo básico:
- Controle: JSON (`announce`, `audio-start`, `audio-ack`, `audio-end`, `peer`, `peer-left`).
- Áudio: payloads binários contendo vários frames Opus prefixados com (seq:4 bytes, len:2 bytes, payload).

Como funciona (resumo)
- O listener cria filas por usuário (`pendingQueues`) e não envia ao speaker até receber `audio-ack`.
- Quando um speaker está pronto, ele envia `audio-start` → hub encaminha → listener recebe `audio-ack` e começa a enviar frames.
- O hub (`bridge.js`) bufferiza frames recebidos antes de `audio-start` e os descarta somente por configuração (neste repositório foi removido o limite de drop).

Permissões necessárias (no servidor Discord)
- `View Channels` — ver o canal de voz.
- `Connect` — conectar ao canal de voz.
- `Speak` — necessário para o agente que reproduz áudio (speaker).
- `Send Messages` — útil para controlar via comandos de texto (`!agentName starttunnel`, `join`, etc.).

Observações operacionais
- O listener não deve estar server-deafened (ouvir precisa estar habilitado no cliente bot).
- Tokens: use `AGENT_K_TOKEN` / `AGENT_J_TOKEN` ou passe `--token` na linha de comando.
- Hub padrão: `ws://127.0.0.1:8080` (override via `HUB_URL` ou `--hub`).

Executando com `pm2`
1. Instale dependências:

```bash
npm install
```

2. Iniciar tudo via `ecosystem.config.js` (recomendado):

```bash
# inicia bridge, agentK e agentJ, atualiza envs e salva a lista
pm2 start ecosystem.config.js --update-env && pm2 save && pm2 ls
```

Observações sobre tokens / variáveis de ambiente
- Os agentes já resolvem tokens automaticamente (procura `--token`, `AGENT_K_TOKEN`, `AGENT_J_TOKEN`, `AGENT_TOKEN` ou no arquivo `.env`).
- Para fornecer tokens no shell antes de (re)iniciar os processos:

```bash
export AGENT_K_TOKEN=xxxxx
export AGENT_J_TOKEN=yyyy
export HUB_URL=ws://127.0.0.1:8080
pm2 restart ecosystem.config.js --update-env
```

3. Iniciar processos individualmente (opcional)

- Iniciar apenas o hub (bridge):

```bash
pm2 start bridge.js --name bridge
```

- Iniciar um agente listener (exemplo `agentK`):

```bash
AGENT_K_TOKEN=xxxxx HUB_URL=ws://127.0.0.1:8080 pm2 start agent.js --name agentK -- --input --name agentK
```

- Iniciar um agente speaker (exemplo `agentJ`):

```bash
AGENT_J_TOKEN=yyyy HUB_URL=ws://127.0.0.1:8080 pm2 start agent.js --name agentJ -- --output --name agentJ
```

Atualizar variáveis de ambiente / reiniciar (usa o `ecosystem`):

```bash
pm2 restart ecosystem.config.js --update-env
```

Comandos Discord (via chat)
- Os comandos devem ser direcionados ao nome do agente. Ex.: `!agentK starttunnel`.
- `!<agentName> join` — faz o bot entrar na sua call (use no servidor e canal apropriado).
- `!<agentName> leave` — faz o bot sair da call.
- `!<agentName> starttunnel` — ativa o encaminhamento (listener só envia áudio quando o túnel está ligado).
- `!<agentName> stoptunnel` — desativa o encaminhamento.
- `!<agentName> whoami` / `channel` — informações de diagnóstico.

Exemplo de uso prático
1. Inicie `bridge`, `agentK` (listener) e `agentJ` (speaker) com `pm2`.
2. No servidor onde o listener (agentK) deve capturar áudio, execute `!agentK join` para fazer o bot entrar na call.
3. No mesmo servidor, envie `!agentK starttunnel` para habilitar envio de áudio ao hub.
4. No servidor onde o speaker (agentJ) deve reproduzir, execute `!agentJ join` para que o speaker entre na call.

Logs e depuração
- Use `pm2 logs agentK` / `pm2 logs agentJ` / `pm2 logs bridge` para ver os eventos de `audio-start` / `audio-ack` / `audio-end` e possíveis erros.
- Procure por entradas marcadas `AUDIO_ACK_SEND`, `AUDIO_ACK_RECV`, `flushCoalesce` e `paused pendingQueue`.

Notas finais
- Este repositório preserva buffers por design (não há limites artificiais de enfileiramento por padrão). Ajuste variáveis de ambiente com cautela se quiser limitar memória.
- Valores configuráveis (exemplos): `HUB_URL`, `AGENT_K_TOKEN`, `AGENT_J_TOKEN`, `OPUS_FRAME_MS`, `COALESCE_FRAMES`, `FIRST_FRAME_WAIT_MS`.


// =====================================================
//  SCREWCOUNTER — SERVIDOR RELAY  v2.0
//  Node.js · Express + ws
//
//  Conecta ESP32 ↔ App HTML via WebSocket
//  Deploy: Railway (ou qualquer Node.js hosting)
//
//  COMO FUNCIONA:
//  1. ESP32 conecta em wss://seu-app.railway.app/
//     → manda {type:'esp'} no primeiro pacote
//  2. App HTML conecta em wss://seu-app.railway.app/
//     → manda {type:'app'} no primeiro pacote
//  3. Servidor relaya dados ESP32→App e comandos App→ESP32
//  4. Heartbeat automático a cada 30s mantém Railway vivo
// =====================================================

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');

const PORT = process.env.PORT || 3000;

// ── Express ───────────────────────────────────────────
const app = express();

// Serve o index.html em public/ (o app HTML)
app.use(express.static(path.join(__dirname, 'public')));

// Health check — Railway usa isso pra saber se está vivo
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── HTTP + WebSocket Server ───────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── Estado Global ─────────────────────────────────────
let espSocket  = null;   // socket do ESP32 (único)
let appClients = new Set(); // sockets dos apps HTML

// ── Utilitários ───────────────────────────────────────
function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    } catch (e) {
      console.error('[RELAY] Erro ao enviar:', e.message);
    }
  }
}

function broadcastToApps(data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const client of appClients) {
    safeSend(client, payload);
  }
}

function notifyEspStatus(online) {
  broadcastToApps({ esp_status: online ? 'online' : 'offline' });
  console.log('[ESP32] Status:', online ? 'ONLINE' : 'OFFLINE',
              '— apps conectados:', appClients.size);
}

// ── Handler de cada nova conexão WebSocket ────────────
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log('[WS] Nova conexão de:', ip);

  // Papel da conexão (identificado pelo primeiro pacote)
  let role = null; // 'esp' ou 'app'

  // Ping/pong nativo do WebSocket para manter Railway vivo
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // ── Receber mensagem ─────────────────────────────────
  ws.on('message', (rawData) => {
    // Converte Buffer para string se necessário
    const msg = Buffer.isBuffer(rawData) ? rawData.toString() : String(rawData);

    // Ignorar pings de keepalive (string simples, não JSON)
    if (msg === 'ping') {
      safeSend(ws, 'pong'); // responde pro cliente saber que está vivo
      return;
    }
    if (msg === 'pong') return;

    // Tentar parsear JSON
    let data;
    try {
      data = JSON.parse(msg);
    } catch (e) {
      // Mensagem não-JSON desconhecida — ignorar silenciosamente
      console.warn('[WS] Mensagem não-JSON ignorada:', msg.slice(0, 60));
      return;
    }

    // ── Identificação do papel (primeiro pacote JSON) ──
    if (role === null) {
      if (data.type === 'esp') {
        role      = 'esp';
        espSocket = ws;
        console.log('[ESP32] Conectado!');
        notifyEspStatus(true);

        // Avisa apps que ESP32 chegou
        // (app pode ter conectado antes do ESP32)
        return;
      }
      if (data.type === 'app') {
        role = 'app';
        appClients.add(ws);
        console.log('[APP] Cliente conectado. Total:', appClients.size);

        // Avisa o app do estado atual do ESP32
        safeSend(ws, { esp_status: espSocket ? 'online' : 'offline' });
        return;
      }
      // Conexão que não se identificou — ignorar até identificar
      console.warn('[WS] Conexão não identificada, tipo:', data.type);
      return;
    }

    // ── Relay: ESP32 → App (dados de sensor/estado) ────
    if (role === 'esp') {
      broadcastToApps(data);
      return;
    }

    // ── Relay: App → ESP32 (comandos) ─────────────────
    if (role === 'app') {
      if (espSocket && espSocket.readyState === WebSocket.OPEN) {
        // Remove a chave de controle antes de repassar pro ESP32
        // (ESP32 não precisa dela e economiza bytes na RAM do MicroPython)
        const { key, ...cmdClean } = data;
        safeSend(espSocket, cmdClean);
      } else {
        // ESP32 não está conectado — avisa o app
        safeSend(ws, { esp_status: 'offline' });
        console.warn('[APP] Comando ignorado — ESP32 offline');
      }
      return;
    }
  });

  // ── Fechar conexão ───────────────────────────────────
  ws.on('close', (code, reason) => {
    console.log('[WS] Conexão fechada. Papel:', role || 'não-identificado',
                '| Código:', code);

    if (role === 'esp') {
      espSocket = null;
      notifyEspStatus(false);
    }

    if (role === 'app') {
      appClients.delete(ws);
      console.log('[APP] Cliente removido. Restantes:', appClients.size);
    }

    role = null;
  });

  // ── Erro de conexão ──────────────────────────────────
  ws.on('error', (err) => {
    console.error('[WS] Erro:', err.message, '| Papel:', role || 'não-identificado');
    // Não precisa fechar manualmente — o evento 'close' vai disparar logo depois
  });
});

// ── Heartbeat: verifica conexões mortas a cada 30s ────
// Isso é CRÍTICO para Railway — o proxy fecha conexões idle.
// Este ping/pong do protocolo WebSocket (nível binário)
// é diferente do ping de texto que o app e ESP32 mandam.
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log('[HEARTBEAT] Conexão morta detectada — terminando');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping(); // WebSocket nativo ping frame — cliente responde com pong automático
  });
}, 30_000);

wss.on('close', () => clearInterval(heartbeatInterval));

// ── Iniciar servidor ──────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   SCREWCOUNTER RELAY SERVER  v2.0        ║');
  console.log('║   Porta:', String(PORT).padEnd(34, ' ') + '║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('[SERVER] Aguardando ESP32 e App...');
  console.log('[SERVER] Health check: GET /health');
});

// ── Tratamento de erros não capturados ───────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Erro não capturado:', err.message);
  // Não mata o processo — Railway já monitora e reinicia se necessário
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Promise rejection não tratada:', reason);
});

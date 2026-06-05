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
const fs        = require('fs');

const PORT = process.env.PORT || 3000;

// ── Express ───────────────────────────────────────────
const app = express();

// Serve o index.html em public/ (o app HTML)
// Serve static files but override root to allow small HTML tweaks
app.use(express.static(path.join(__dirname, 'public')));

// Serve '/' explicitly so we can optionally inject small client-side
// behavior: disable clickable navigation and, for local requests,
// adopt the `theme-color` meta from the local HTML file.
app.get('/', (req, res, next) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) return next(err);

    // Detect local/private client IPs (basic checks)
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const isLocal = /(^::1$|^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(ip) || /localhost/i.test(req.headers.host || '');

    // If local, try to read a local HTML file to copy its theme-color meta
    if (isLocal) {
      const localPath = path.join(__dirname, 'local 2.html');
      try {
        const localHtml = fs.readFileSync(localPath, 'utf8');
        const m = localHtml.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["'][^>]*>/i);
        if (m && m[1]) {
          // replace theme-color meta in served index.html
          html = html.replace(/<meta[^>]*name=["']theme-color["'][^>]*>/i, `<meta name="theme-color" content="${m[1]}" id="themeColorMeta">`);
        }
      } catch (e) {
        // ignore if local file not present
      }
    }

    // Inject small script before </head> to prevent clicks on interactive elements
    // for VIEW clients. This blocks local button clicks (so they don't run
    // handlers locally). Actions still work when sent from the trusted
    // bridge/local app (local 2.html) because the bridge sends WS messages
    // to the server which are broadcast to viewers to update UI.
    const inject = `\n<script>\n// Block clicks on interactive controls (buttons, anchors, elements with onclick)\n(function(){\n  function block(e){\n    try{\n      var el = e.target && (e.target.closest ? e.target.closest('button, a, [onclick], [role="button"], input[type="button"], input[type="submit"]') : null);\n      if(el){\n        e.preventDefault();\n        e.stopImmediatePropagation();\n        e.stopPropagation();\n        return false;\n      }\n    }catch(_){}\n  }\n  // Capture phase prevents inline onclick and other listeners from running\n  document.addEventListener('click', block, true);\n  document.addEventListener('dblclick', block, true);\n  // Also block context menu to avoid right-click actions\n  document.addEventListener('contextmenu', function(e){ e.preventDefault(); }, true);\n})();\n</script>\n`;

    html = html.replace(/<\/head>/i, inject + '</head>');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
});

// Health check — Railway usa isso pra saber se está vivo
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── HTTP + WebSocket Server ───────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── Estado Global ─────────────────────────────────────
let espSocket   = null;   // socket do ESP32 (único)
let bridgeSocket = null;  // socket da bridge (local.html em modo bridge)
let viewers     = new Set(); // viewers públicos (public/index.html)
let appClients  = new Set(); // sockets dos apps HTML (legacy)
let lastEspData = null;   // último payload recebido do ESP
const lastSeqByPeer = new Map(); // dedupe de mensagens sc por bridge

const CONTROL_KEY = process.env.CONTROL_KEY || 'SC2025_k9m7x3qp';

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

function broadcastToViewers(data, excludeWs) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const v of viewers) {
    if (v === excludeWs) continue;
    safeSend(v, payload);
  }
}
function broadcastToApps(data, excludeWs) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const client of appClients) {
    if (client === excludeWs) continue;
    safeSend(client, payload);
  }
}
function broadcastToAllClients(data, excludeWs) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const v of viewers) {
    if (v === excludeWs) continue;
    safeSend(v, payload);
  }
  for (const client of appClients) {
    if (client === excludeWs) continue;
    safeSend(client, payload);
  }
  if (bridgeSocket && bridgeSocket !== excludeWs) safeSend(bridgeSocket, payload);
}

function notifyEspStatus(online) {
  broadcastToViewers({ esp_status: online ? 'online' : 'offline' });
  broadcastToApps({ esp_status: online ? 'online' : 'offline' });
  console.log('[ESP32] Status:', online ? 'ONLINE' : 'OFFLINE',
              '— viewers:', viewers.size, 'apps:', appClients.size);
}

function notifyAppStatus(online) {
  broadcastToViewers({ app_status: online ? 'online' : 'offline' });
  console.log('[APP] Status:', online ? 'ONLINE' : 'OFFLINE',
              '— viewers:', viewers.size, 'apps:', appClients.size);
}

// ── Handler de cada nova conexão WebSocket ────────────
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log('[WS] Nova conexão de:', ip);

  // Papel da conexão (identificado pelo primeiro pacote)
  let role = null; // 'esp', 'bridge', 'view', 'app'

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
      // ESP32 identifica com {type:'esp'}
      if (data.type === 'esp') {
        role      = 'esp';
        espSocket = ws;
        console.log('[ESP32] Conectado!');
        notifyEspStatus(true);
        return;
      }

      // Bridge (local.html em modo bridge) — precisa de chave
      if (data.type === 'bridge') {
        if (data.key !== CONTROL_KEY) {
          console.warn('[BRIDGE] Chave inválida de:', ip);
          try { ws.close(); } catch (e) {}
          return;
        }
        // Se já há uma bridge ativa, fecha-a de forma limpa
        if (bridgeSocket && bridgeSocket !== ws) {
          try { bridgeSocket._replaced = true; bridgeSocket.close(); } catch (e) {}
        }
        role = 'bridge';
        bridgeSocket = ws;
        console.log('[BRIDGE] Bridge conectada.');
        // Confirmação para o bridge
        safeSend(ws, { bridge_status: 'ok' });
        // Envia app status para viewers, pois a bridge representa o app local
        notifyAppStatus(true);
        // Reenvia último estado do ESP32 se existir
        if (lastEspData) safeSend(ws, lastEspData);
        return;
      }

      // Viewer público (ex: public/index.html)
      if (data.type === 'view') {
        role = 'view';
        viewers.add(ws);
        console.log('[VIEW] Viewer conectado. Total:', viewers.size);
        // Envia estado do servidor ao viewer
        safeSend(ws, {
          server_status: 'online',
          app_status: appClients.size > 0 || bridgeSocket ? 'online' : 'offline'
        });
        // Se tivermos último estado, envia para sincronizar
        if (lastEspData) safeSend(ws, lastEspData);
        return;
      }

      // Legacy app (antes: {type:'app'}) — mantém compatibilidade
      if (data.type === 'app') {
        role = 'app';
        appClients.add(ws);
        console.log('[APP] Cliente conectado. Total:', appClients.size);
        safeSend(ws, { server_status: 'online' });
        if (lastEspData) safeSend(ws, lastEspData);
        notifyAppStatus(true);
        return;
      }

      // Conexão que não se identificou — ignorar até identificar
      console.warn('[WS] Conexão não identificada, tipo:', data.type);
      return;
    }

    // ── Relay: ESP32 → Todos (dados de sensor/estado) ────
    if (role === 'esp') {
      // guarda último payload e reenvia para viewers/apps/bridge
      try { lastEspData = typeof data === 'string' ? data : JSON.stringify(data); } catch (e) { lastEspData = null; }
      broadcastToAllClients(lastEspData || data, ws);
      return;
    }

    // dedupe de payloads sc enviados pela bridge
    if (role === 'bridge' && data && data.type === 'sc' && typeof data.from === 'string' && typeof data.seq === 'number') {
      const prevSeq = lastSeqByPeer.get(data.from) || 0;
      if (data.seq <= prevSeq) return;
      lastSeqByPeer.set(data.from, data.seq);
    }

    // ── Mensagens da bridge → repassa p/ viewers e apps legacy
    if (role === 'bridge') {
      if (data.bridge_status) return;
      broadcastToViewers(data, ws);
      broadcastToApps(data, ws);
      return;
    }

    // ── Relay: App → Viewers, bridge e ESP32 se houver comando ────
    if (role === 'app') {
      broadcastToViewers(data, ws);
      broadcastToApps(data, ws);
      if (bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN && bridgeSocket !== ws) {
        safeSend(bridgeSocket, data);
      }
      if (espSocket && espSocket.readyState === WebSocket.OPEN && data.cmd !== undefined) {
        const { key, ...cmdClean } = data;
        safeSend(espSocket, cmdClean);
      }
      return;
    }

    // ── Viewer messages — normalmente ignorar (read-only)
    if (role === 'view') {
      // Viewers are read-only — ignore any incoming messages
      console.warn('[VIEW] Mensagem recebida de viewer — ignorando');
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
      if (appClients.size === 0) notifyAppStatus(false);
      console.log('[APP] Cliente removido. Restantes:', appClients.size);
    }

    if (role === 'view') {
      viewers.delete(ws);
      console.log('[VIEW] Viewer removido. Restantes:', viewers.size);
    }

    if (role === 'bridge') {
      // Se o bridge que fechou for o ativo, limpa a referência.
      if (bridgeSocket === ws) {
        bridgeSocket = null;
        console.log('[BRIDGE] Bridge desconectada.');
        if (appClients.size === 0) notifyAppStatus(false);
      } else {
        // Caso tenha sido substituído por uma nova bridge, não faz nada
        console.log('[BRIDGE] Bridge antiga desconectou.');
      }
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
  console.log('║   SCREWCOUNTER RELAY SERVER  v2.1        ║');
  console.log('║   (Bridge + Viewers)                      ║');
  console.log('║   Porta:', String(PORT).padEnd(32, ' ') + '║');
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

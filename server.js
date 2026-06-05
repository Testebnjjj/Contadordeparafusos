// =====================================================
//  SCREWCOUNTER - SERVIDOR RELAY
//  Node.js + WebSocket
//  Todos conectam em / — tipo identificado pela 1ª mensagem
//  ESP32 envia: {"type":"esp"}
//  HTML  envia: {"type":"app"}
// =====================================================

const express    = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http       = require('http');
const path       = require('path');

const app    = express();
const server = http.createServer(app);

// ─── Serve o HTML (pasta public/) ───────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── WebSocket Server ────────────────────────────────
const wss = new WebSocketServer({ server });

let espSocket    = null;
const appClients = new Set();

// ─── Chave de controle ───────────────────────────────
const SECRET_KEY = "SC2025_k9m7x3qp";

wss.on('connection', (ws) => {
    let tipo = null;  // 'esp' ou 'app' — definido pela 1ª mensagem

    ws.on('message', (data) => {
        const msg = data.toString();

        // ── Identificação inicial (1ª mensagem obrigatória) ──
        if (!tipo) {
            try {
                const parsed = JSON.parse(msg);

                if (parsed.type === 'esp') {
                    tipo      = 'esp';
                    espSocket = ws;
                    console.log('[ESP32] Conectado e identificado!');
                    broadcastToApps(JSON.stringify({ esp_status: 'online' }));

                } else if (parsed.type === 'app') {
                    tipo = 'app';
                    appClients.add(ws);
                    console.log('[APP] Cliente conectado. Total:', appClients.size);
                    // Informa status atual do ESP32 ao app que acabou de conectar
                    ws.send(JSON.stringify({
                        esp_status: (espSocket && espSocket.readyState === WebSocket.OPEN)
                            ? 'online' : 'offline'
                    }));

                } else {
                    ws.close();
                }
            } catch (e) {
                ws.close();
            }
            return;
        }

        // ── ESP32 → repassa dados pro app ────────────────────
        if (tipo === 'esp') {
            if (msg === 'ping') return;
            console.log('[ESP32 → APP]', msg);
            broadcastToApps(msg);

        // ── App → valida chave → repassa comando pro ESP32 ───
        } else if (tipo === 'app') {
            if (msg === 'ping') return;
            try {
                const parsed = JSON.parse(msg);

                if (parsed.cmd && parsed.key !== SECRET_KEY) {
                    console.warn('[SEGURANÇA] Comando bloqueado — chave inválida.');
                    return;
                }

                delete parsed.key;
                const clean = JSON.stringify(parsed);
                console.log('[APP → ESP32]', clean);

                if (espSocket && espSocket.readyState === WebSocket.OPEN) {
                    espSocket.send(clean);
                } else {
                    console.warn('[RELAY] ESP32 desconectado — comando ignorado.');
                }
            } catch (e) {
                console.warn('[APP] Mensagem inválida:', msg);
            }
        }
    });

    ws.on('close', () => {
        if (tipo === 'esp') {
            espSocket = null;
            console.log('[ESP32] Desconectado.');
            broadcastToApps(JSON.stringify({ esp_status: 'offline' }));
        } else if (tipo === 'app') {
            appClients.delete(ws);
            console.log('[APP] Cliente desconectado. Total:', appClients.size);
        }
    });

    ws.on('error', (err) => console.error('[WS] Erro:', err.message));
});

// ─── Broadcast para todos os apps ────────────────────
function broadcastToApps(message) {
    appClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
}

// ─── Inicia o servidor ───────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║   SCREWCOUNTER SERVIDOR RODANDO      ║');
    console.log(`║   Porta: ${PORT}                          ║`);
    console.log('║   Todos conectam em /                ║');
    console.log('║   1ª msg: {"type":"esp"} ou "app"    ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');
});

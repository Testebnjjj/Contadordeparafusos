// =====================================================
//  SCREWCOUNTER - SERVIDOR RELAY
//  Node.js + WebSocket
//  ESP32 conecta em /esp
//  HTML/App conecta em /app
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

let espSocket        = null;        // Conexão do ESP32
const appClients     = new Set();   // Conexões do HTML/App

wss.on('connection', (ws, req) => {
    const url = req.url;

    // ══════════════════════════════
    //  ESP32 conectou
    // ══════════════════════════════
    if (url === '/esp') {
        espSocket = ws;
        console.log('[ESP32] Conectado!');

        // Avisa todos os apps que o ESP32 está online
        broadcastToApps(JSON.stringify({ esp_status: 'online' }));

        // ESP32 mandou dado (contagem, motor, estoque...) → repassa pro app
        ws.on('message', (data) => {
            const msg = data.toString();
            console.log('[ESP32 → APP]', msg);
            broadcastToApps(msg);
        });

        // ESP32 desconectou
        ws.on('close', () => {
            espSocket = null;
            console.log('[ESP32] Desconectado.');
            broadcastToApps(JSON.stringify({ esp_status: 'offline' }));
        });

        ws.on('error', (err) => console.error('[ESP32] Erro:', err.message));

    // ══════════════════════════════
    //  HTML / App conectou
    // ══════════════════════════════
    } else if (url === '/app') {
        appClients.add(ws);
        console.log('[APP] Cliente conectado. Total:', appClients.size);

        // Informa se o ESP32 está online ou offline no momento
        ws.send(JSON.stringify({
            esp_status: (espSocket && espSocket.readyState === WebSocket.OPEN)
                ? 'online' : 'offline'
        }));

        // App mandou comando (ligar motor, selecionar tipo...) → repassa pro ESP32
        ws.on('message', (data) => {
            const msg = data.toString();
            console.log('[APP → ESP32]', msg);

            if (espSocket && espSocket.readyState === WebSocket.OPEN) {
                espSocket.send(msg);
            } else {
                console.warn('[RELAY] ESP32 não está conectado, comando ignorado.');
            }
        });

        // App desconectou
        ws.on('close', () => {
            appClients.delete(ws);
            console.log('[APP] Cliente desconectado. Total:', appClients.size);
        });

        ws.on('error', (err) => console.error('[APP] Erro:', err.message));

    } else {
        // URL desconhecida
        ws.close();
    }
});

// ─── Broadcast para todos os apps conectados ─────────
function broadcastToApps(message) {
    appClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ─── Inicia o servidor ───────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║   SCREWCOUNTER SERVIDOR RODANDO      ║');
    console.log(`║   Porta: ${PORT}                          ║`);
    console.log('║   ESP32  → conecte em /esp           ║');
    console.log('║   HTML   → conecte em /app           ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');
});

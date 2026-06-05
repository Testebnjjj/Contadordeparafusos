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

// ─── Chave de controle ───────────────────────────────
// Apenas clientes com essa chave podem enviar comandos ao ESP32.
// Quem abre o link sem ela vê tudo em tempo real, mas não controla.
const SECRET_KEY = "SC2025_k9m7x3qp";

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

        // App mandou comando (ligar motor, selecionar tipo...) → valida chave → repassa pro ESP32
        ws.on('message', (data) => {
            const msg = data.toString();

            // Keepalive ping — deixa passar sem validação
            if (msg === 'ping') return;

            // Tenta parsear como JSON e verificar a chave
            try {
                const parsed = JSON.parse(msg);

                // Bloqueia se não tiver chave correta
                if (parsed.cmd && parsed.key !== SECRET_KEY) {
                    console.warn('[SEGURANÇA] Comando bloqueado — chave inválida ou ausente.');
                    return;
                }

                // Remove a chave antes de repassar ao ESP32 (ESP32 não precisa dela)
                delete parsed.key;
                const clean = JSON.stringify(parsed);
                console.log('[APP → ESP32]', clean);

                if (espSocket && espSocket.readyState === WebSocket.OPEN) {
                    espSocket.send(clean);
                } else {
                    console.warn('[RELAY] ESP32 não está conectado, comando ignorado.');
                }

            } catch (e) {
                // Não é JSON — ignora
                console.warn('[APP] Mensagem não reconhecida:', msg);
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

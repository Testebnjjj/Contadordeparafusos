# ScrewCounter — Servidor Relay

Servidor que conecta o ESP32 e o app HTML pela internet.

## Como funciona

```
HTML/APK  ──→  wss://seu-servidor/app  ──→  Servidor  ──→  wss://seu-servidor/esp  ──→  ESP32
```

## Subir no Railway (grátis)

1. Suba esta pasta no GitHub
2. Acesse railway.app → login com GitHub
3. Clique em "New Project" → "Deploy from GitHub repo"
4. Selecione este repositório
5. Railway detecta Node.js automaticamente e faz o deploy

O servidor já estará em `https://seu-projeto.railway.app`

## Estrutura de pastas

```
screwcounter-server/
├── server.js          ← servidor relay
├── package.json       ← dependências Node.js
└── public/
    └── index.html     ← coloque o app HTML aqui
```

## URLs após deploy

| Quem usa | URL |
|---|---|
| Abrir o app | https://seu-projeto.railway.app |
| ESP32 conecta | wss://seu-projeto.railway.app/esp |
| HTML conecta | wss://seu-projeto.railway.app/app |

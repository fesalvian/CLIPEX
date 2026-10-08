# Clipador

App desktop que pega a gravação da live, acha os melhores momentos com IA, deixa você ajustar os cortes e gera vídeos 9:16 com legenda, gancho e marca d'água, prontos pra Reels, Shorts e TikTok.

## Rodar

```powershell
npm install
npm run dev
```

Na primeira vez, abra **Configurações › Componentes de IA** e baixe o que faltar:

| Componente | Pra quê | Tamanho |
| --- | --- | --- |
| Whisper (whisper.cpp) | transcrição com tempo de cada palavra; usa a GPU NVIDIA | ~650 MB (CUDA) |
| Modelo do Whisper | `large-v3-turbo` q8 (recomendado) | 834 MB |
| Detector de risada e grito | YAMNet (AudioSet) em ONNX | 15 MB |

O ffmpeg vem junto (`ffmpeg-static`); se faltar algo nele, o app usa o do sistema (`C:\ffmpeg\bin` ou o PATH).

> Rodando de dentro de uma extensão do VS Code, a variável `ELECTRON_RUN_AS_NODE=1` pode vir herdada e o Electron abre como Node puro. No terminal normal isso não acontece; se acontecer, `Remove-Item Env:ELECTRON_RUN_AS_NODE` antes do `npm run dev`.

## Como usar

1. **Grave no OBS** em MKV com as faixas separadas: 1 mix, 2 microfone, 3 jogo, 4 Discord, 5 música ([guia de configuração](https://claude.ai/code/artifact/9bffb54e-39c4-4bbd-ae1d-0e61aefda0b2)). Nome do arquivo: `live_AAAA-MM-DD_hh-mm.mkv`.
2. **Pasta vigiada:** quando o arquivo para de crescer, o app cria o projeto e começa a análise sozinho. Também dá pra importar um arquivo na mão.
3. **Análise:** microfone + loudness → risadas e gritos (YAMNet) → momentos (janela de ±45 s) → transcrição de cada momento (Whisper) → nota, corte sugerido e ganchos (LLM). Os momentos aparecem na tela de clipar assim que são encontrados; a nota da IA chega depois.
4. **Clipar:** marque "usar", ajuste as alças na waveform, escolha o layout (cam + jogo, só jogo, só cam), ajuste o recorte da webcam e do jogo no frame da live e posicione a marca d'água.
5. **Revisar e postar:** gancho, legenda trecho a trecho (com dicionário de termos), zoom na webcam no pico, legenda e hashtags por rede, agendamento. Antes de postar, o app mostra tudo que vai ser publicado e pede confirmação.
6. **Plano B:** "Baixar este clipe" e "Baixar todos (.zip)", cada vídeo com um `.txt` das legendas de cada rede.

Fechar a janela deixa o app na bandeja, pros agendamentos de Instagram e TikTok continuarem valendo.

## Segredos e contas (`.env`)

Copie `.env.example` pra `.env` (fica fora do git). A chave da OpenAI também pode ser colada em Configurações.

- **OpenAI:** `OPENAI_API_KEY`. Sem chave, use o provedor **Local** (Ollama) em Configurações.
- **YouTube Shorts:** no Google Cloud, ative a *YouTube Data API v3*, crie uma credencial OAuth do tipo **App para computador** e preencha `YOUTUBE_CLIENT_ID` e `YOUTUBE_CLIENT_SECRET`. Depois, Configurações › Contas › Conectar. Projetos não verificados sobem vídeos como privados até a verificação do Google.
- **Instagram Reels:** conta profissional ligada a uma Página do Facebook. Preencha `INSTAGRAM_ACCESS_TOKEN` (token de longa duração com `instagram_content_publish`) e `INSTAGRAM_USER_ID`. O upload é direto (resumable); se falhar e `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` estiverem preenchidos, o vídeo sobe pra um storage temporário e o Instagram baixa de lá. Via API, Reels têm no máximo 90 s.
- **TikTok:** app no TikTok for Developers com *Content Posting API* (escopo `video.upload`), redirect URI `http://127.0.0.1:51789/callback/`. Preencha `TIKTOK_CLIENT_KEY` e `TIKTOK_CLIENT_SECRET`. Os vídeos vão como **rascunho**: você confirma (e escreve a legenda) no app do TikTok.

Os tokens das redes ficam no banco local, criptografados pelo Windows (DPAPI).

## Regras por rede

Ficam em [config/platform-rules.json](config/platform-rules.json): limite de caracteres, hashtags, título, dicas e orientações pra IA. Pra mudar sem mexer no app instalado, copie o arquivo pra pasta de dados (`%APPDATA%\Clipador\platform-rules.json`).

## Desenvolvimento

```powershell
npm test               # testes unitários (comandos do ffmpeg, candidatos, legenda, regras)
npm run typecheck
npm run sample         # gera .data/sample/live_2026-10-07_21-03.mkv (6 min, 5 faixas) pra testar

# integração com ffmpeg/whisper reais (precisa do vendor/ com o Whisper e o modelo)
$env:CLIPADOR_INT=1; npx vitest run tests/integration
```

Roteiro de ponta a ponta com prints de cada tela (usa uma pasta de dados separada):

```powershell
$env:CLIPADOR_USERDATA="$PWD\.data\userdata-test"; $env:CLIPADOR_SHOTS="$PWD\.data\shots"
$env:CLIPADOR_WATCH="$PWD\.data\watch"; $env:CLIPADOR_LLM="local"; $env:CLIPADOR_QUIT="1"
npm run dev
```

Estrutura:

- `src/main` — processo principal: pipeline de análise, ffmpeg, Whisper, YAMNet (worker thread), LLM, render, postagem, SQLite (`node:sqlite`).
- `src/main/ffmpeg/args.ts` — todos os comandos do ffmpeg, montados por funções puras e testadas.
- `src/preload` — ponte de IPC tipada.
- `src/renderer` — interface React (Clipar, Revisar e postar, Início, Configurações).
- `src/shared` — tipos, contrato de IPC, legenda, regras por rede, geometria do recorte (usada no preview e no render).

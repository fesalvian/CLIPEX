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
4. **Clipar:** marque "usar" e ajuste o corte na timeline: as alças mudam início e fim, arrastar dentro do corte move o corte inteiro e arrastar fora dele anda pela live (o preview e a transcrição do trecho novo são gerados sozinhos). Escolha o layout (cam + jogo, só jogo, só cam), ajuste o recorte da webcam e do jogo (o editor mostra o mesmo quadro do preview) e posicione a marca d'água. Com o vídeo pausado, arraste a legenda e o texto inicial no preview.
5. **Revisar e postar:** gancho, legenda trecho a trecho (com dicionário de termos), zoom na webcam no pico, legenda e hashtags por rede, agendamento. Antes de postar, o app mostra tudo que vai ser publicado e pede confirmação.

No preview pausado, a legenda, o texto inicial e a logo têm alças: as laterais mudam a largura da área onde o texto cresce e o canto muda o tamanho. A legenda é presa pelo topo (linhas a mais crescem pra baixo) e a logo do canal fica sempre logo acima dela.

**Postar vários por dia:** em "Revisar e postar", o ritmo do "Renderizar e agendar tudo" pode ser todos juntos, 1 por dia no horário escolhido ou 2, 3, 5 ou 10 por dia nos melhores horários de cada rede (pelas views quando já tem histórico; senão, horários de pico padrão). O melhor corte sai primeiro.

**Meu jeito de escrever** (Configurações): como você escreve, palavras que não usa, jogo padrão e exemplos reais de ganchos e legendas por rede. A IA usa tudo isso (e o jogo da live, informado na revisão) pra escrever como você e não inventar o que não está na fala. Com "aprender com o que eu posto", o texto final de cada corte agendado ou baixado vira exemplo.

**Textos padronizados** (Configurações): fonte, tamanho, cores, contorno, caixa, maiúsculas, animação e posição padrão da legenda e do texto inicial. O texto inicial pode ser a sugestão da IA ou um texto fixo, e os dois podem ser desligados. Dá pra importar fontes `.ttf`/`.otf`; já vêm Montserrat ExtraBold, Anton, Bebas Neue, Bangers, Luckiest Guy e Poppins Black (licenças em `resources/fonts`).
6. **Plano B:** "Baixar este clipe" e "Baixar todos (.zip)", cada vídeo com um `.txt` das legendas de cada rede.

Fechar a janela deixa o app na bandeja, pros agendamentos de Instagram e TikTok continuarem valendo.

## Segredos e contas (`.env`)

Copie `.env.example` pra `.env` (fica fora do git). Depois de mexer no `.env`, feche o Clipador pela bandeja (Sair) e abra de novo. Os tokens das redes ficam no banco local, criptografados pelo Windows (DPAPI).

- **OpenAI:** `OPENAI_API_KEY`. Também dá pra colar em Configurações. Sem chave, use o provedor **Local** (Ollama).

### YouTube Shorts

1. [console.cloud.google.com](https://console.cloud.google.com) › criar projeto (ex.: "Clipador").
2. **APIs e serviços › Biblioteca** › *YouTube Data API v3* › Ativar.
3. **Tela de consentimento OAuth** (Google Auth Platform): tipo **Externo**; em **Público-alvo › Usuários de teste**, adicione a conta Google dona do canal.
4. **Credenciais › Criar credenciais › ID do cliente OAuth › App para computador**. Copie o ID e a chave secreta pra `YOUTUBE_CLIENT_ID` e `YOUTUBE_CLIENT_SECRET`.
5. No Clipador: Configurações › Contas › YouTube › **Conectar** (abre o navegador; aceite o aviso de app não verificado, ele é seu).
6. **Branding** (Google Auth Platform), pra poder publicar o app:
   - Nome do app `Clipador`, e-mail de suporte e e-mail de contato do desenvolvedor.
   - Página inicial `https://fesalvian.github.io/`, Política de Privacidade `https://fesalvian.github.io/privacidade.html`, Termos de Serviço `https://fesalvian.github.io/termos.html` (ver [Site](#site-termos-e-privacidade)).
   - Domínios autorizados: `fesalvian.github.io`.
   - **Sem logotipo:** com o app publicado, enviar logo obriga a passar pela verificação de marca do Google.
7. **Público-alvo › Publicar app** › Confirmar. O aviso de que "precisa de verificação" pode ser ignorado: pra uso próprio (até 100 usuários) funciona sem ela, só continua o aviso de app não verificado no login.
8. Configurações › Contas › YouTube › **Reconectar**. O login feito com o projeto em teste continua vencendo em 7 dias; só o login feito depois de publicar deixa de vencer.

Limites do Google:
- Projeto em modo **Teste**: o login vence a cada 7 dias. Por isso os passos 6 a 8.
- O Google pode travar como **privado** os vídeos de projetos que não passaram pela **auditoria da API do YouTube** (no teste do canal, saiu público normalmente). Se acontecer, o Clipador avisa depois do upload e dá pra tornar público no YouTube Studio; a auditoria se pede no formulário *YouTube API Services – Audit and Quota Extension*.
- Cota diária de 10.000 unidades; cada upload gasta 1.600, ou seja, uns 6 vídeos por dia. O mesmo formulário pede mais cota.

### Instagram Reels (login do Facebook, upload direto do PC)

Caminho recomendado: o Clipador envia o arquivo direto do seu PC pro Instagram (upload *resumable*). Não precisa de storage na nuvem, não tem custo nem limite de tamanho. Precisa da conta do Instagram ligada a uma Página do Facebook.

1. No app do Instagram, a @fesalvian.lives precisa ser **profissional** (Criador ou Empresa): Configurações › Tipo de conta.
2. Ligue a conta a uma **Página do Facebook** (se não tiver, crie uma simples): Página › Configurações › Contas vinculadas › Instagram › Conectar. Também dá pela Central de Contas da Meta.
3. [developers.facebook.com](https://developers.facebook.com) › Meus apps › **Criar app** › caso de uso **Outro** › tipo **Empresa**. O app pode ficar em modo de desenvolvimento: como você é administrador dele, as permissões funcionam na sua própria conta sem análise da Meta.
4. Abra o [Explorador da Graph API](https://developers.facebook.com/tools/explorer): escolha o app, **Token de acesso do usuário**, e marque `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement` e `business_management`. Clique em **Generate Access Token** e autorize a Página e a conta do Instagram.
5. Deixe o token de longa duração: no [Depurador de token](https://developers.facebook.com/tools/debug/accesstoken), cole o token, clique em **Depurar** e depois em **Estender token de acesso**. Copie o token novo.
6. Volte ao Explorador, cole esse token longo e rode `me/accounts?fields=name,access_token,instagram_business_account`. Na sua Página aparecem:
   - `access_token`: o **token da Página**. Gerado a partir de um token longo, ele **não vence**. Ele vai pra `INSTAGRAM_ACCESS_TOKEN` (começa com `EAA`).
   - `instagram_business_account.id`: vai pra `INSTAGRAM_USER_ID`.
7. Se quiser conferir, cole o token da Página no Depurador: deve mostrar **Expira: Nunca**.
8. Feche o Clipador pela bandeja (Sair), abra de novo e vá em Configurações › Contas › Instagram › **Testar**.

Via API: até 100 posts por 24 h; Reels de no máximo 90 s.

Ligar a Página: pelo Facebook (agindo como a Página: Settings & privacy › Settings › Permissions › **Linked accounts** › Instagram › Connect account) ou pelo **app** do Instagram (Editar perfil › **Página** › Conectar uma Página existente; no site do Instagram essa opção não existe). Se perguntar sobre compartilhar no Facebook, recuse; depois confira em Central de Contas › Compartilhamento entre perfis que tudo pro Facebook está desligado.

> **"Sua conta foi restringida" / "Your account is restricted":** bloqueio temporário de segurança da Meta, comum depois de várias ações sensíveis seguidas (apagar e criar Página, mexer na segurança). Não insista (cada tentativa pode prolongar) e evite criar o app de desenvolvedor nesse meio-tempo. Costuma liberar em 1 a 3 dias; se passar de uma semana, veja *Account status* nas configurações do Facebook ou facebook.com/support.

**Alternativa: login do Instagram + Supabase.** Não precisa de Página do Facebook, mas essa API não aceita o arquivo direto: o Instagram baixa o vídeo de um link público. O Clipador sobe pro **Supabase Storage**, gera um link de 1 hora, publica e apaga o arquivo. Token `IG…` (API do Instagram › Configuração com login do Instagram › Gerar tokens), mais `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` de um bucket `clipador-temp`. Vídeo acima de 48 MB ganha uma cópia mais leve (o plano grátis aceita 50 MB por arquivo). Use um projeto do Supabase só pra isso: o tráfego dos vídeos conta no limite da conta.

### TikTok

1. [developers.tiktok.com](https://developers.tiktok.com) › Manage apps › **Connect an app**. Não precisa mandar pro review: use o **Sandbox** (seletor Production / Sandbox no topo do app › Create Sandbox), que funciona pras contas cadastradas como teste. O Sandbox tem configuração própria; tudo abaixo é feito nele.
2. **App details** (obrigatório mesmo no Sandbox): ícone 1024×1024, nome, categoria, descrição (até 120 caracteres), Terms of Service URL e Privacy Policy URL (as páginas do [Site](#site-termos-e-privacidade)). Plataforma **Desktop**, com um **Web/Desktop URL** (ex.: `https://fesalvian.github.io/`).
3. Produtos: **Login Kit** e **Content Posting API** (com *Direct Post* desligado: o vídeo vai como rascunho). Escopos: `user.info.basic` e `video.upload`.
4. Login Kit › **Redirect URI**, na aba **Desktop**: `http://127.0.0.1:51789/callback/` (exatamente assim, sem outro campo vazio embaixo).
5. **Sandbox settings › Target users**: adicione a @fesalvian.
6. **Apply changes**. Enquanto aparecer "This form has unsaved changes" ou "This form has N errors", nada vale e o login dá erro de `client_key`.
7. Em **Credentials** do Sandbox, copie **Client key** e **Client secret** pra `TIKTOK_CLIENT_KEY` e `TIKTOK_CLIENT_SECRET`. A chave do Sandbox começa com `sbaw`; a de produção (`aw…`) só funciona depois do review.
8. Feche o Clipador pela bandeja (Sair), abra de novo e vá em Configurações › Contas › TikTok › **Conectar**.

O vídeo chega como **rascunho** na caixa de entrada do app do TikTok: você abre, ajusta a legenda e publica.

### Site (termos e privacidade)

Google (pra publicar o app) e TikTok pedem página inicial, política de privacidade e termos. As páginas estão em [site/](site/) e são publicadas pelo GitHub Pages no repositório `fesalvian.github.io` (envio pelo próprio site do GitHub: *Add file › Upload files*):

- `https://fesalvian.github.io/` (início)
- `https://fesalvian.github.io/privacidade.html`
- `https://fesalvian.github.io/termos.html`

Se o app passar a usar outra permissão ou mandar outros dados pra fora (ex.: pra LLM), atualize a política e suba os arquivos de novo.

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

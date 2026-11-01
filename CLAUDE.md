# Clipador — cortes automáticos das lives

App desktop que pega a gravação bruta de uma live de jogo (3 a 6 horas), encontra os melhores momentos com IA, deixa o usuário ajustar os cortes e gera vídeos 9:16 prontos pra Instagram Reels, YouTube Shorts e TikTok, com legenda, gancho e postagem/agendamento automáticos.

Dono: Felipe Salviano (Senhor Salvian). Faz live na Twitch.
Contas dos cortes: Instagram **@fesalvian.lives** · TikTok **@fesalvian** · YouTube Shorts **@felipesalvian**.
Idioma da interface e dos textos gerados: **português brasileiro**.

Objetivo principal: ter os cortes prontos e postados o mais rápido possível depois da live, com o máximo de automação, pra aumentar a chance de viralizar.

---

## Stack (decidido)

- **Electron** + **Vite** + **React** + **TypeScript** (strict). Não usar Next.js.
- Backend local no **main process do Electron (Node)**, falando com o renderer por IPC tipado.
- **ffmpeg** pra tudo de vídeo e áudio (proxy, extração de faixas, render final). Preferir binário empacotado (ffmpeg-static ou similar) com fallback pro ffmpeg do sistema.
- **Transcrição:** Whisper local (faster-whisper ou whisper.cpp), com timestamp por palavra. Usar GPU quando houver.
- **Detecção de eventos de áudio:** classificador tipo YAMNet ou PANNs (classes Laughter, Screaming, Shout) + loudness via ffmpeg (`ebur128`/`astats`).
- **LLM:** dois provedores atrás da mesma interface:
  - **OpenAI API** (modelo avançado), chave em `OPENAI_API_KEY` no `.env`.
  - **Local** via Ollama.
  - O usuário escolhe o provedor na UI (toggle "OpenAI / Local").
- **Banco local:** SQLite (better-sqlite3 ou similar). Evitar Prisma dentro do Electron, porque complica o empacotamento.
- **Render na GPU:** NVENC (NVIDIA) / AMF (AMD) quando disponível, senão libx264.

### Segredos
- `.env` com `OPENAI_API_KEY=` (vazio, o usuário preenche). Criar `.env.example`.
- `.env` no `.gitignore`.
- No app empacotado o `.env` não vai junto: no build, ler a chave de um arquivo na pasta de dados do usuário (`app.getPath('userData')`). Fica pra fase de build.

---

## Perfis (canais de cortes)

Como os perfis da Netflix: ao abrir (com mais de um perfil) o app pergunta qual canal vai clipar. Cada perfil tem contas das redes, logo, textos, jeito de escrever, dicionário, pasta vigiada, canal vigiado e fila de postagem próprios. IA, Whisper, encoder e a cota diária do YouTube valem pra todos.

- **Tipo de clipe** (escolhido ao criar o perfil):
  - **Gameplay:** o fluxo de sempre (risada, grito e pico de áudio; cam + jogo). O perfil `fesalvian` (id `fesalvian`) é o do Felipe e existe desde antes dos perfis; os dados antigos são dele.
  - **Podcast:** transcreve o episódio inteiro em pedaços de 10 min e a IA acha **conversas completas** (começo, meio e fim), encaixadas no início e no fim das frases. Layout padrão: **seguir quem fala** (detecção de rosto UltraFace + quem mexe a boca, em planos parados com corte seco).
  - **Clipe em 16:9:** o quadro inteiro no meio do 9:16 com o fundo desfocado (layout "vídeo inteiro").
- **Download automático:** o perfil aponta um canal (YouTube ou Twitch); o app olha o canal com o yt-dlp, ignora o que já existia, espera live terminar e baixa cada vídeo novo.
- **Postagem automática (exceção à regra de confirmação):** ligada no perfil, com confirmação na hora de ligar. Vídeo que chega sozinho (canal ou pasta vigiada) tem os melhores cortes escolhidos (nota mínima, duração máxima, termos proibidos), preparados, renderizados e agendados N por dia sem revisão. Vídeo novo passa na frente na fila. Freio: "Pausar postagens" do perfil segura tudo.
- **Limites respeitados:** YouTube sobe na véspera e no máximo `youtubeDailyUploads` por dia (cota da API, todos os perfis juntos; acabou a cota, espera zerar); TikTok até 5 rascunhos por dia por conta; Reels até 90 s.

## Entrada: gravação local do OBS (principal)

O usuário vai gravar localmente no OBS em **MKV multifaixa** (guia de configuração: https://claude.ai/code/artifact/9bffb54e-39c4-4bbd-ae1d-0e61aefda0b2).

| Faixa | Conteúdo |
| --- | --- |
| 1 | Mix (o que vai pra live) |
| 2 | Microfone |
| 3 | Jogo |
| 4 | Discord |
| 5 | Música |

- **Pasta vigiada:** o app observa a pasta de gravações (ex.: `D:\Lives\Brutos`). Quando um `.mkv` termina de ser escrito (tamanho estável por alguns segundos), cria o projeto e começa a análise sozinho.
- Nome do arquivo: `live_AAAA-MM-DD_hh-mm.mkv`. Usar a data pra nomear o projeto.
- **Plano B:** importar um arquivo manualmente ou baixar o VOD da Twitch (yt-dlp). Nesse caso só existe uma faixa misturada e a detecção usa ela.
- Opção de apagar o arquivo bruto X dias depois dos cortes postados.

---

## Pipeline

1. **Ingestão:** detectar o arquivo, ler metadados com ffprobe, identificar as faixas de áudio.
2. **Proxy:** gerar uma versão 360p leve pra navegar e pré-visualizar na UI.
3. **Análise** (na faixa 2, microfone, quando existir):
   - loudness ao longo do tempo → picos;
   - classificador de eventos → risada, grito;
   - Whisper → transcrição com tempo por palavra.
4. **Candidatos:** juntar os sinais numa pontuação, pegar os picos e abrir uma janela (ex.: ±45 s) em volta de cada um, sem sobreposição.
5. **Ranking com LLM:** mandar a transcrição de cada candidato pra LLM, que devolve nota de potencial, sugestão de início e fim, tags e 3 sugestões de gancho.
6. **Liberação progressiva:** os primeiros candidatos já aparecem na UI enquanto o resto da live ainda está sendo analisado.
7. **Tela de clipar** (usuário ajusta). Depois **tela de revisar e postar**.
8. **Render final** a partir do arquivo original, em resolução cheia:
   - crop da webcam e crop da gameplay, `vstack` em 1080×1920, com layouts **cam + jogo**, **só jogo** e **só cam**, e altura da webcam configurável (30/40/50%);
   - legenda queimada (`.ass`, estilo TikTok, palavra destacada), gerada da transcrição já corrigida;
   - **gancho** nos primeiros ~3 s;
   - **zoom (punch-in) na webcam no pico** (opcional por corte);
   - **marca d'água:** PNG do usuário (`overlay`), posição, tamanho e opacidade livres, aplicados a todos os cortes;
   - áudio: mix sem a faixa de música (ou com ela bem baixa) pra evitar direitos autorais.
9. **Postagem / agendamento** ou **download** (plano B).

---

## Telas (design de referência)

Canvas com as duas telas: https://claude.ai/artifact/8oSKvbzGLJ9AMqSishw38X
(Ler pelo link: precisa da sessão logada com `/login` na conta do claude.ai.)

### 1. Clipar
- Lista de momentos encontrados, ordenada por potencial, com filtros **Todos / Risadas / Gritos / Picos de áudio**.
- Cada linha: checkbox "usar", nome, tags do que foi detectado, horário na live, nota de potencial, **waveform com alças de início e fim** (estilo corte de stories do Instagram), cursor de reprodução, tempos do corte e duração, botão play/pause.
- Play numa linha seleciona o corte e toca no **preview 9:16** da direita (usa o proxy).
- **"Adicionar corte manual"** e o resumo "X de N aprovados · duração total".
- Coluna da direita:
  - preview 9:16 com legenda;
  - seletor de layout (cam + jogo, só jogo, só cam) e altura da webcam;
  - **editor de recorte** sobre o frame 16:9 da live, com dois retângulos arrastáveis e redimensionáveis (laranja = webcam, ciano = jogo);
  - **"Salvar como preset do meu layout de live"**;
  - **marca d'água:** PNG arrastável e redimensionável direto no preview (mantém proporção), X/Y/largura em pixels do vídeo final, opacidade, Centralizar, Tamanho original, **"Aplicar em todos os cortes"**.

### 2. Revisar e postar
- Esquerda: cortes aprovados com status (pronto, gerando legenda, na fila) e **dicionário de termos** (nomes, gírias, termos de jogo que o Whisper erra; corrige em todos os cortes).
- Centro:
  - preview com o gancho e a legenda;
  - toggle **zoom na webcam no pico**, com o momento marcado na barra;
  - **gancho:** 3 sugestões da LLM, campo pra escrever o próprio e "Gerar outras" (OpenAI/Local);
  - **legenda editável trecho a trecho**, com trechos marcados quando o dicionário sugere correção.
- Direita:
  - **onde postar** (Reels, Shorts, TikTok, cada um com a @);
  - **legenda e hashtags por rede** em abas, geradas pela LLM e respeitando as regras abaixo, com contador de caracteres e de hashtags e "Copiar legenda e hashtags";
  - **quando:** postar agora ou agendar (data e hora), horário sugerido pelo histórico de desempenho, "espalhar os cortes, um por dia";
  - **plano B:** "Baixar este clipe" e "Baixar todos (.zip)". Cada vídeo vem com um `.txt` das legendas e hashtags de cada rede.

### Visual
- Fundo: gradiente roxo → azul escuro (`linear-gradient(155deg, #1E1240 0%, #12123A 38%, #0A0F2C 70%, #070918 100%)`).
- Destaques: roxo `#8B5CF6` / `#A78BFA` / `#C4B5FD` e azul `#3B82F6` / `#60A5FA`. Botão principal em gradiente `#7C3AED → #2563EB`.
- Cores semânticas: webcam laranja `#FF9F45`, gameplay ciano `#3FC8E8`, alerta laranja claro `#FFC48A`.
- Painéis translúcidos (`rgba(255,255,255,0.04)`, borda `rgba(255,255,255,0.09)`).
- Fontes: **Space Grotesk** (interface) e **JetBrains Mono** (tempos, números).
- Ícones em SVG de traço, sem emoji. Alvos de clique de pelo menos 44 px.

---

## Regras por rede (legenda e hashtags geradas pela LLM)

Ficam num arquivo de configuração (`platform-rules`), pra atualizar sem mexer no código.

- **Instagram Reels:** no máximo **5 hashtags**. A legenda pesa mais: gancho na primeira linha e uma pergunta pra puxar comentário. Até 2.200 caracteres. Via API os Reels ficam limitados a **90 s** (avisar ou sugerir corte). Exige conta profissional ligada a uma Página do Facebook.
- **TikTok:** legenda de até 4.000 caracteres, escrita com as palavras que as pessoas buscam. 3 a 5 hashtags específicas. Via API, apps não auditados só postam privado, então **o MVP envia como rascunho** (Upload/inbox) e o usuário confirma no app do TikTok.
- **YouTube Shorts:** título de até 100 caracteres com uma hashtag. As 3 primeiras hashtags da descrição aparecem acima do título. Com mais de 60 hashtags o YouTube ignora todas; usar 3 a 5, incluindo `#shorts`. Agendamento nativo via `publishAt`. Projetos de API não verificados tendem a ficar com upload privado até a verificação.
- **Agendamento de Instagram e TikTok:** feito pelo próprio app (fila + scheduler). Pro MVP, o app precisa estar aberto ou na bandeja na hora. Um backend sempre ligado fica pra depois.
- O upload pro Instagram precisa de uma URL pública do vídeo, o que exige um storage temporário (ex.: Supabase Storage ou R2).

---

## Escopo do MVP

1. Pasta vigiada + importação manual.
2. Proxy + análise (picos, risada e grito, Whisper) + candidatos + ranking com LLM (OpenAI e local).
3. Tela de clipar completa (timelines, preview, layouts, editor de recorte, preset, marca d'água).
4. Tela de revisar: gancho, legenda editável com dicionário, zoom no pico.
5. Render final com ffmpeg na GPU.
6. Legenda e hashtags por rede.
7. Download individual e .zip (plano B), com `.txt` das legendas.
8. Postagem: Shorts (upload + agendamento), Instagram (Reels), TikTok (rascunho).
9. Aprender com o desempenho: guardar as views de cada corte postado e usar pra ajustar o ranking e sugerir horário.

## Fora do MVP (roadmap, não implementar agora)

- Usar o **chat da live** como sinal de momento bom (picos de mensagens, "KKKK", emotes).
- **Botão ou hotkey pra marcar clipe durante a live** (inclusive pelo painel do OBS no tablet), com prioridade máxima na lista.
- **"Treinar" o app a editar:** biblioteca de áudios e imagens + presets de efeito (ex.: preto e branco + eco na voz + tela encolhendo pra dar sensação de distanciamento, comum quando o streamer fala algo engraçado). A LLM escolhe onde e quando aplicar e o sistema executa o preset no ponto exato.
- **Capa do vídeo escolhida pelos frames:** igual o Instagram pede na hora de postar, mostrar uma tira de frames do corte pra escolher a capa. Escolhe uma vez no app e sai assim em todas as redes (e opção de usar o mesmo critério em todos os cortes). Na API: Instagram aceita `thumb_offset` (ms) no upload; TikTok aceita `video_cover_timestamp_ms` no post direto (no rascunho a capa é escolhida no app); Shorts não aceita capa via API (o YouTube escolhe o frame).

---

## Convenções

- TypeScript strict nos dois processos. Tipos compartilhados numa pasta `shared/`.
- Processamento pesado (ffmpeg, Whisper, classificador) em processos ou workers separados, com progresso enviado pra UI. Nunca travar a UI.
- Todo comando ffmpeg montado por funções testáveis (entrada: config do corte; saída: argumentos), não por strings soltas.
- Textos da interface em português brasileiro.
- Antes de qualquer coisa que poste numa rede social, mostrar o que vai ser postado e pedir confirmação. Exceção: perfis com a **postagem automática** ligada (o usuário liga de propósito, com aviso, e tem nota mínima, termos proibidos e pausa como freio).

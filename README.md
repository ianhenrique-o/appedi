# CorteFlow — Editor de Reels

Você solta o vídeo bruto e o CorteFlow tira as pausas, os "ahn", as palavras repetidas e as frases que você regravou. Depois coloca legenda palavra por palavra, dá zoom alternado nos cortes e exporta o MP4 pronto para o Instagram.

## O que ele faz

O comportamento segue a especificação de estilo em `docs/estilo-de-edicao.md`.

**Cortes**
- Tira pausas, deixando um respiro natural (um pouco maior depois de frase concluída) e sem encostar no começo ou no fim das palavras.
- Tira "ahn", "hum" e "éé", palavras repetidas ("o o") e frases recomeçadas, deixando só a última tentativa.
- Comentários de bastidor ("corta", "errei", "vou de novo") ficam marcados para você revisar.
- Cortes muito próximos viram um só, para não sair uma sequência nervosa de microcortes. Cada corte leva um microfade no áudio.

**Ritmo visual**
- **Zoom editorial (1.04× a 1.12×):** aproximação lenta na abertura, punch-in leve em frases com número ou palavra-chave, enquadramento mais fechado na conclusão e aproximação lenta quando o vídeo passa muito tempo sem mudança. Nunca em todos os cortes, e o zoom cresce em volta do rosto.
- **Enquadramento no rosto:** o recorte vertical acompanha a pessoa com calma, sem cortar testa nem queixo. A detecção roda no navegador.
- **Apoios visuais:** três momentos, um em cada terço do vídeo. Por padrão viram um card com a frase que está sendo dita, sobre o próprio vídeo desfocado. Você troca cada um por uma imagem ou um vídeo seu (B-roll).

**Legendas**
- Divididas por sentido: um bloco nunca termina pendurado em "de", "que" ou "o", e ocupam no máximo duas linhas.
- Uma cor de destaque só nas palavras que importam (números, benefícios, palavras fortes). Você pode escolher à mão na aba Texto, ou usar o modo karaokê.
- Somem enquanto um card está na tela.
- Exportação também em `.srt`.

**Áudio**
- Limpeza de voz: tira ruído constante, equaliza e comprime.
- Volume a −14 LUFS.
- Música de fundo com ducking automático (abaixa quando você fala) e fade de entrada e saída.

**Edição**
- Linha do tempo com miniaturas, forma de onda, cortes, apoios e zooms.
- Edição pelo texto, prévia ao vivo igual ao arquivo final, desfazer e refazer, atalhos.
- **Padrão de edição:** salvo no navegador e exportável em arquivo `.json`, para todos os vídeos saírem com a mesma cara.

## Requisitos

- Node.js 22+
- pnpm 10+
- FFmpeg com libass (o pacote `ffmpeg` do Ubuntu/Debian e o do Homebrew já vêm com ela)

## Rodar no computador

```bash
pnpm install
cp .env.example .env    # coloque a GROQ_API_KEY ou a OPENAI_API_KEY
pnpm dev
```

Abra `http://localhost:3000`.

### Transcrição

As legendas, a aba Texto e a detecção de vícios, repetições e regravações dependem da transcrição. Basta uma chave no `.env`:

| Variável | Serviço | Observação |
|---|---|---|
| `GROQ_API_KEY` | Groq (whisper-large-v3-turbo) | Mais barato e mais rápido |
| `OPENAI_API_KEY` | OpenAI (whisper-1) | Oficial |
| `TRANSCRIPTION_API_KEY` + `TRANSCRIPTION_API_URL` | Qualquer API compatível com a da OpenAI | Opcional |

Sem chave nenhuma, o app funciona só com o corte de pausas.

## Rodar com Docker

```bash
docker build -t corteflow .
docker run --rm -p 3000:3000 --env-file .env -v corteflow-dados:/data -e CORTEFLOW_DATA_DIR=/data corteflow
```

## Validar

```bash
pnpm check   # tipos
pnpm test    # testes, incluindo renderização real com FFmpeg
pnpm build && pnpm start
```

## Estrutura

- `shared/editor.ts`: regras compartilhadas entre navegador e servidor (mapa de cortes, detecção de pausas e fala, zoom automático e blocos de legenda). A prévia e o arquivo final usam exatamente a mesma conta.
- `server/editor/routes.ts`: API (`/api/projects`, `/api/projects/:id/render`, `/api/jobs/:id`).
- `server/editor/render.ts`: montagem do FFmpeg (cortes, zoom, formato, legenda e áudio).
- `server/editor/captions.ts`: gera as legendas `.ass` no tempo do vídeo já cortado.
- `server/editor/transcribe.ts`: Whisper (Groq/OpenAI) com tempo por palavra.
- `server/assets/fonts/`: fontes das legendas (licença OFL).
- `client/src/pages/Home.tsx`: tela do editor.
- `client/src/editor/`: linha do tempo, prévia, painéis e exportação.

## API

| Método | Rota | O que faz |
|---|---|---|
| `POST` | `/api/projects` | Recebe o vídeo (corpo bruto + `X-File-Name`) e devolve duração, envelope de áudio e miniaturas. A transcrição começa em segundo plano. |
| `GET` | `/api/projects/:id/transcript` | Estado da transcrição e palavras com tempo. |
| `GET` | `/api/projects/:id/preview.mp4` | Prévia leve em H.264 para formatos que o navegador não abre (ex.: HEVC do iPhone). |
| `POST` | `/api/projects/:id/render` | Começa a exportação com cortes, zooms, formato, legenda, gancho e áudio. |
| `GET` | `/api/jobs/:id` | Progresso da exportação. |
| `GET` | `/api/jobs/:id/download` | Baixa o MP4. |

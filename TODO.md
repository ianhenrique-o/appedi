# CorteFlow — Estado e próximos passos

## Feito na versão 2

- [x] Upload único em disco (o vídeo não sobe duas vezes), com barra de progresso.
- [x] Pausas detectadas no navegador a partir do envelope de áudio, com sensibilidade ajustável em tempo real.
- [x] Transcrição com tempo por palavra (Groq ou OpenAI) e pontuação recuperada.
- [x] Detecção de vícios de fala, palavras repetidas e regravações.
- [x] Edição pelo texto: cortar e restaurar palavras e corrigir a legenda.
- [x] Linha do tempo real com miniaturas, forma de onda, cortes, sugestões, zooms, seleção e zoom da própria linha do tempo.
- [x] Prévia que pula os cortes e mostra legenda, gancho e zoom ao vivo.
- [x] Legendas sincronizadas depois dos cortes (na v1 elas saíam atrasadas a cada corte).
- [x] Zoom real no arquivo exportado (alternado automático + manual).
- [x] Formatos 9:16, 9:16 com fundo desfocado, 4:5, 1:1 e original.
- [x] Áudio a −14 LUFS e microfade nos cortes.
- [x] Removidos os três cards genéricos que a v1 colava no meio do vídeo.
- [x] Removidos os dados falsos da tela (usuária fictícia, projetos recentes, timeline desenhada).
- [x] Fila de renderização com progresso, desfazer/refazer, atalhos, padrão salvo e sessão retomada.
- [x] Testes com renderização real em FFmpeg.

## Feito na versão 3 (especificação de estilo)

- [x] Pausas com respiro natural, proteção das bordas da palavra e fim dos microcortes.
- [x] Regravação cortada por padrão e detecção de comentário de bastidor.
- [x] Zoom editorial 1.04–1.12 com aproximação suave (sem pulo) em volta do rosto.
- [x] Enquadramento que acompanha o rosto (detecção no navegador, câmera calma).
- [x] Três apoios visuais distribuídos por terço: card com a frase ou imagem/B-roll do usuário.
- [x] Legenda dividida por sentido, ênfase em palavras-chave, até duas linhas, oculta durante o card e exportada em .srt.
- [x] Limpeza de voz, música com ducking e fades.
- [x] Padrão de edição exportável/importável.

## Próximos passos possíveis

- [ ] Detectar quando a pessoa olha para fora da câmera ou perde a linha de raciocínio.
- [ ] Banco de imagens integrado para sugerir o B-roll de cada apoio.
- [ ] Efeito sonoro mínimo nas trocas de seção.
- [ ] Projetos salvos em banco, com histórico de exportações.
- [ ] Login e limite de uso, se for abrir para clientes.

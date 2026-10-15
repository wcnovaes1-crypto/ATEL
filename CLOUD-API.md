# ATEL — WhatsApp Cloud API: primeira etapa

Implementação inicial para **uma empresa, um número e uma réplica do backend**.
Não é ainda um SaaS multicliente pronto para comercialização.

## Funcionalidades

- Provedor `cloudapi`, sem sessão de navegador ou leitura de QR code.
- Envio de texto e respostas citando outra mensagem pela Graph API.
- Recebimento de texto via webhook, criando contatos, tickets e mensagens no painel.
- Verificação do webhook e autenticação HMAC SHA-256 de cada evento.
- Deduplicação de mensagens persistidas e processamento sequencial em uma réplica.
- Atualização de status enviado/entregue/lido sem regressão por eventos fora de ordem.
- Tipos recebidos ainda não implementados aparecem como aviso no ticket.

## Pré-requisitos

1. App Meta com produto WhatsApp, WABA e número habilitado na Cloud API.
2. Token de produção com permissões adequadas (`whatsapp_business_messaging`
   e, conforme configuração, `whatsapp_business_management`).
3. Phone Number ID, App Secret e versão da Graph API suportada pela Meta.
4. Endpoint público HTTPS apontando para o backend. O IP privado
   `172.20.188.74` não é acessível diretamente pela Meta.

## Configuração

No `.env` raiz usado pelo Docker Compose, definir:

```dotenv
WHATSAPP_PROVIDER=cloudapi
WHATSAPP_CLOUD_API_VERSION=vXX.0
WHATSAPP_CLOUD_PHONE_NUMBER_ID=ID_DO_NUMERO_NA_META
WHATSAPP_CLOUD_CONNECTION_ID=ID_DA_CONEXAO_NO_WHATICKET
WHATSAPP_CLOUD_ACCESS_TOKEN=TOKEN_DA_META
WHATSAPP_CLOUD_APP_SECRET=SEGREDO_DO_APP
WHATSAPP_CLOUD_VERIFY_TOKEN=VALOR_ALEATORIO_LONGO
```

Substituir `vXX.0` por uma versão válida atualmente suportada. Não versionar
credenciais. O Connection ID é o ID de uma conexão do modelo `Whatsapps`
no Whaticket, não o Phone Number ID da Meta. A seleção do provedor é global:
esta etapa não permite misturar conexões QR e oficiais no mesmo backend.
Usar apenas uma conexão no ambiente de teste Cloud API.

Após criar/configurar a conexão e as variáveis:

```bash
docker compose up -d --build backend
```

Iniciar a conexão no painel. O backend consulta os dados do número na Meta e
marca a conexão como conectada, sem QR. Isso confirma as credenciais de saída,
mas a entrega de mensagens recebidas depende da configuração de webhook abaixo.

Na Meta, configurar:

- Callback: `https://SEU_BACKEND/webhooks/whatsapp`
- Verify token: mesmo valor de `WHATSAPP_CLOUD_VERIFY_TOKEN`.
- Assinar o campo `messages` e garantir que o app esteja inscrito na WABA.

Configurar também `BACKEND_URL`, `PROXY_PORT` e `FRONTEND_URL` para os endereços
públicos reais, preservando o corpo original do webhook no proxy reverso.

## Validação com a Meta

Testes automatizados locais, com modelos e transporte isolados do banco real:
`cd backend && npm run test:cloud`. Eles compilam TypeScript antes de executar
Jest, evitando a incompatibilidade entre o ts-jest antigo e TypeScript 5.4.

1. Usar inicialmente número de teste e destinatário permitido no app Meta.
2. Enviar texto do celular ao número oficial e verificar a criação de ticket.
3. Responder no ticket dentro da janela de atendimento permitida pela Meta.
4. Confirmar recebimento no celular e atualização de entrega/leitura no painel.
5. Reenviar um mesmo evento: não deve criar outra mensagem/ticket.

## Limites e próximas etapas

- Templates e controle local da janela de atendimento ainda não implementados;
  a Meta pode recusar texto livre fora da janela permitida.
- Envio/download de mídia, contatos, histórico, exclusão e confirmação de leitura
  pela API ainda não implementados. Não simular sucesso nessas operações.
- Status `failed` e códigos detalhados de entrega precisam de modelo/UI próprios;
  esta etapa não oferece acompanhamento completo de falhas assíncronas.
- Para produção comercial: fila durável e retentativas, idempotência de envios,
  persistência transacional, tratamento de eventos adiantados, limites de carga,
  métricas, isolamento por cliente, cadastro Meta Embedded Signup e revisão do app.
- A fila desta versão fica em memória. Falhas antes do HTTP 200 permitem
  retentativa pela Meta, mas não substituem uma caixa de entrada durável.
- Não há garantia de ausência de bloqueios; políticas, consentimento e qualidade
  da conta continuam sendo exigências da Meta.

Documentação oficial: https://developers.facebook.com/docs/whatsapp/cloud-api/

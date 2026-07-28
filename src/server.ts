import 'dotenv/config';
import { createServer } from 'node:http';
import path from 'node:path';
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
} from 'express';
import swaggerUiDist from 'swagger-ui-dist';
import { authorize, authorizeOutboxDrain, authorizeV2 } from '@/lib/api';
import { getPrismaClient } from '@/lib/database';
import { POST as enqueueMessage } from '@/routes/conversations/v1/[conversationId]/messages/outbox/route';
import { POST as sendMessage } from '@/routes/conversations/v1/[conversationId]/messages/route';
import {
  GET as getConversation,
  PATCH as patchConversation,
} from '@/routes/conversations/v1/[conversationId]/route';
import { POST as drainOutbox } from '@/routes/conversations/v1/outbox/drain/route';
import { POST as enqueueConversation } from '@/routes/conversations/v1/outbox/route';
import {
  POST as createConversation,
  GET as listConversations,
} from '@/routes/conversations/v1/route';
import { GET as getConversationByTopic } from '@/routes/conversations/v1/topics/[topicType]/[externalTopicId]/route';
import { POST as enqueueMessageV2 } from '@/routes/conversations/v2/[conversationId]/messages/outbox/route';
import { POST as sendMessageV2 } from '@/routes/conversations/v2/[conversationId]/messages/route';
import {
  GET as getConversationV2,
  PATCH as patchConversationV2,
} from '@/routes/conversations/v2/[conversationId]/route';
import { POST as drainOutboxV2 } from '@/routes/conversations/v2/outbox/drain/route';
import { POST as enqueueConversationV2 } from '@/routes/conversations/v2/outbox/route';
import {
  POST as createConversationV2,
  GET as listConversationsV2,
} from '@/routes/conversations/v2/route';
import { GET as getConversationByTopicV2 } from '@/routes/conversations/v2/topics/[topicType]/[externalTopicId]/route';
import { GET as health } from '@/routes/health/v1/route';
import { POST as webhook } from '@/routes/webhooks/resend/v1/route';

const BODY_LIMIT = '2100kb';
const rawBody = express.raw({
  type: 'application/json',
  limit: BODY_LIMIT,
  inflate: false,
});

function authorizationRequest(request: Request): globalThis.Request {
  return new globalThis.Request('http://localhost/', {
    headers: { authorization: request.get('authorization') ?? '' },
  });
}

const requireConversationAuth: RequestHandler = (request, response, next) => {
  const rejected = authorize(authorizationRequest(request));
  if (rejected) {
    rejected.headers.forEach((value, name) => {
      response.setHeader(name, value);
    });
    void rejected
      .text()
      .then((body) => response.status(rejected.status).send(body));
    return;
  }
  next();
};
const requireConversationV2Auth: RequestHandler = (request, response, next) => {
  const rejected = authorizeV2(authorizationRequest(request));
  if (rejected) {
    rejected.headers.forEach((value, name) => {
      response.setHeader(name, value);
    });
    void rejected
      .text()
      .then((body) => response.status(rejected.status).send(body));
    return;
  }
  next();
};
const requireDrainAuth: RequestHandler = (request, response, next) => {
  const rejected = authorizeOutboxDrain(authorizationRequest(request));
  if (rejected) {
    rejected.headers.forEach((value, name) => {
      response.setHeader(name, value);
    });
    void rejected
      .text()
      .then((body) => response.status(rejected.status).send(body));
    return;
  }
  next();
};

const requireIdempotency: RequestHandler = (request, response, next) => {
  const key = request.get('idempotency-key');
  if (!key || key.length > 256) {
    response
      .status(400)
      .json({ error: 'A valid Idempotency-Key header is required' });
    return;
  }
  next();
};

function toFetchRequest(request: Request): globalThis.Request {
  const url = `${request.protocol}://${request.get('host') ?? 'localhost'}${request.originalUrl}`;
  const body = Buffer.isBuffer(request.body) ? request.body : undefined;
  return new globalThis.Request(url, {
    method: request.method,
    headers: new Headers(request.headers as Record<string, string>),
    ...(body && body.length > 0 ? { body } : {}),
  });
}

type Route = (
  request: globalThis.Request,
  context: any,
) => Promise<globalThis.Response>;
function adapt(handler: Route): RequestHandler {
  return async (request, response, next) => {
    try {
      const result = await handler(toFetchRequest(request), {
        params: Promise.resolve(request.params as Record<string, string>),
      });
      result.headers.forEach((value, name) => {
        response.setHeader(name, value);
      });
      response
        .status(result.status)
        .send(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      next(error);
    }
  };
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/health/v1', adapt(health));
  app.post('/api/webhooks/resend/v1', rawBody, adapt(webhook));

  // Static conversation routes must precede /:conversationId routes.
  app.post(
    '/api/conversations/v2/outbox/drain',
    requireDrainAuth,
    rawBody,
    adapt(drainOutboxV2),
  );
  app.post(
    '/api/conversations/v2/outbox',
    requireConversationV2Auth,
    requireIdempotency,
    rawBody,
    adapt(enqueueConversationV2),
  );
  app.all(
    '/api/conversations/v2/outbox',
    requireConversationV2Auth,
    (_request, response) => response.status(404).json({ error: 'Not found' }),
  );
  app.get(
    '/api/conversations/v2/topics/:topicType/:externalTopicId',
    requireConversationV2Auth,
    adapt(getConversationByTopicV2),
  );
  app
    .route('/api/conversations/v2')
    .get(requireConversationV2Auth, adapt(listConversationsV2))
    .post(
      requireConversationV2Auth,
      requireIdempotency,
      rawBody,
      adapt(createConversationV2),
    );
  app.post(
    '/api/conversations/v2/:conversationId/messages/outbox',
    requireConversationV2Auth,
    requireIdempotency,
    rawBody,
    adapt(enqueueMessageV2),
  );
  app.post(
    '/api/conversations/v2/:conversationId/messages',
    requireConversationV2Auth,
    requireIdempotency,
    rawBody,
    adapt(sendMessageV2),
  );
  app
    .route('/api/conversations/v2/:conversationId')
    .get(requireConversationV2Auth, adapt(getConversationV2))
    .patch(requireConversationV2Auth, rawBody, adapt(patchConversationV2));

  app.post(
    '/api/conversations/v1/outbox/drain',
    requireDrainAuth,
    rawBody,
    adapt(drainOutbox),
  );
  app.post(
    '/api/conversations/v1/outbox',
    requireConversationAuth,
    requireIdempotency,
    rawBody,
    adapt(enqueueConversation),
  );
  app.all(
    '/api/conversations/v1/outbox',
    requireConversationAuth,
    (_request, response) => response.status(404).json({ error: 'Not found' }),
  );
  app.get(
    '/api/conversations/v1/topics/:topicType/:externalTopicId',
    requireConversationAuth,
    adapt(getConversationByTopic),
  );
  app
    .route('/api/conversations/v1')
    .get(requireConversationAuth, adapt(listConversations))
    .post(
      requireConversationAuth,
      requireIdempotency,
      rawBody,
      adapt(createConversation),
    );
  app.post(
    '/api/conversations/v1/:conversationId/messages/outbox',
    requireConversationAuth,
    requireIdempotency,
    rawBody,
    adapt(enqueueMessage),
  );
  app.post(
    '/api/conversations/v1/:conversationId/messages',
    requireConversationAuth,
    requireIdempotency,
    rawBody,
    adapt(sendMessage),
  );
  app
    .route('/api/conversations/v1/:conversationId')
    .get(requireConversationAuth, adapt(getConversation))
    .patch(requireConversationAuth, rawBody, adapt(patchConversation));

  app.get('/openapi.json', (_request, response, next) => {
    response.sendFile(
      path.resolve('public/openapi.json'),
      (error) => error && next(error),
    );
  });
  app.use(
    '/docs/assets',
    express.static(swaggerUiDist.getAbsoluteFSPath(), { fallthrough: false }),
  );
  app.get('/docs', (_request, response) =>
    response.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API documentation | resend-service</title><link rel="stylesheet" href="/docs/assets/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="/docs/assets/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',deepLinking:true});</script></body></html>`),
  );

  app.use((_request, response) =>
    response.status(404).json({ error: 'Not found' }),
  );
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'encoding.unsupported'
    ) {
      response
        .status(415)
        .json({ error: 'Compressed request bodies are not supported' });
      return;
    }
    if (
      error instanceof SyntaxError ||
      (typeof error === 'object' &&
        error !== null &&
        'type' in error &&
        error.type === 'entity.parse.failed')
    ) {
      response.status(400).json({ error: 'Request body must be valid JSON' });
      return;
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.too.large'
    ) {
      response.status(413).json({ error: 'Request body is too large' });
      return;
    }
    console.error('Request processing failed');
    response.status(500).json({ error: 'Internal server error' });
  };
  app.use(errors);
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? process.env.HOSTNAME ?? '0.0.0.0';
  const server = createServer(createApp()).listen(port, host, () =>
    console.info(`resend-service listening on ${host}:${port}`),
  );
  let closing = false;
  const shutdown = () => {
    if (closing) {
      return;
    }
    closing = true;
    server.close(async () => {
      await getPrismaClient().$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

---
name: api-integration-package
description: OpenAPI, api-consumer-guide.md, api-agent-handoff.md, contract extraction, integration guide, API handoff. Use ONLY when updating this repository's consumer-facing API contract and integration documentation from the implemented behavior.
---

# API Integration Package

Use this skill only for `resend-service` when the task is to research and update the consumer-facing API package:

- `public/openapi.json`
- `docs/api-consumer-guide.md`
- `docs/api-agent-handoff.md`

This skill is repository-specific. It is not a generic API documentation workflow.

## Goals

Produce a precise integration package that another coding agent or engineer can use without access to this repository.

Treat the implementation as the source of truth. Do not change runtime behavior unless the user explicitly asks for it.

## Files and Evidence Sources

Inspect these first:

- `AGENTS.md`
- `README.md`
- `package.json`
- `.env.example`
- `public/openapi.json`
- `docs/api-consumer-guide.md`
- `docs/api-agent-handoff.md`
- `src/server.ts`
- `src/routes/**/route.ts`
- `src/lib/api.ts`
- `src/lib/send-validation.ts`
- `src/lib/conversation-service.ts`
- `src/lib/conversation-v2.ts`
- `src/lib/outbox-service.ts`
- `src/lib/webhook-handler.ts`
- `src/lib/verify-webhook.ts`
- `src/lib/email/**`
- `src/lib/database/**`
- `prisma/schema.prisma`
- `prisma/migrations/**`
- `tests/integration/**`
- `tests/helpers/**`
- `tests/fake-resend-server.ts`
- `vitest.config.ts`

## Core Rules

1. Prefer externally reachable code paths and integration tests over comments or internal type names.
2. Distinguish clearly between:
   - Publicly supported behavior
   - Currently observed implementation behavior
   - Unresolved questions or gaps
3. Do not invent endpoints, fields, status codes, guarantees, or business rules.
4. Do not expose secret values, credentials, or sensitive message content from local environment files.
5. Derive environment-variable names from code, `.env.example`, README, and checked-in docs. Avoid reading ignored local env files unless the user explicitly asks.
6. Preserve the contract as strict public behavior when implementation is more permissive. Record the mismatch in the guides instead of broadening the contract without evidence.
7. Treat unknown framework-generated failures as unresolved if the application does not control the response body.
8. Keep copied consumer-facing docs portable. Do not require downstream readers to have this repository's local scripts, Docker Compose setup, OpenCode skills, or command files.

## Workflow

### 1. Build an evidence matrix

Build separate V1 and V2 evidence matrices, plus shared-route evidence. For each
registered route, capture:

- Method and path
- Authentication requirements
- Required headers
- Request body shape and validation
- Response body shape and serialization
- Success statuses
- Error statuses and error bodies
- Idempotency behavior
- Consistency and lifecycle notes
- Test coverage and gaps

Required shared route inventory for this repo:

- `GET /api/health/v1`
- `POST /api/webhooks/resend/v1`

Required V1 route inventory:

- `POST /api/conversations/v1`
- `GET /api/conversations/v1?assignment=unassigned`
- `POST /api/conversations/v1/outbox`
- `POST /api/conversations/v1/outbox/drain`
- `GET /api/conversations/v1/{conversationId}`
- `PATCH /api/conversations/v1/{conversationId}`
- `POST /api/conversations/v1/{conversationId}/messages`
- `POST /api/conversations/v1/{conversationId}/messages/outbox`
- `GET /api/conversations/v1/topics/{topicType}/{externalTopicId}`

Required V2 route inventory:

- `POST /api/conversations/v2`
- `GET /api/conversations/v2?assignment=unassigned`
- `POST /api/conversations/v2/outbox`
- `POST /api/conversations/v2/outbox/drain`
- `GET /api/conversations/v2/{conversationId}`
- `PATCH /api/conversations/v2/{conversationId}`
- `POST /api/conversations/v2/{conversationId}/messages`
- `POST /api/conversations/v2/{conversationId}/messages/outbox`
- `GET /api/conversations/v2/topics/{topicType}/{externalTopicId}`

Use `src/server.ts` as the authoritative Express registration inventory. Trace
each operation into its `src/routes/conversations/v1/**` or
`src/routes/conversations/v2/**` handler and then into the relevant library,
database schema or migration, and integration-test evidence. Record shared,
version-specific, and cross-version behavior explicitly rather than assuming
that equivalent route shapes have equivalent contracts.

Do not add `/docs` or `/openapi.json` to the OpenAPI contract. They may be referenced in guides only as supporting resources.

### 2. Reconcile the contract

Update `public/openapi.json` so it matches supported behavior.

Include:

- All supported shared, V1, and V2 API operations above
- Security requirements
- Relevant header parameters
- Request and response schemas
- Nullability and required fields
- Enumerations
- Representative examples
- Shared error schemas and responses

Do not encode implementation-only leniency as a public guarantee unless the repository already treats it as supported. Example: if runtime clamps invalid query limits instead of rejecting them, keep the strict contract and document the discrepancy in the guides.

### 3. Update the consumer guide

Keep `docs/api-consumer-guide.md` consumer-oriented.

It must explain:

- Service purpose and ownership boundaries
- Supported workflows
- Endpoint summary
- Authentication and authorization
- Request and response conventions
- Error semantics
- Retry, timeout, and idempotency guidance
- Consistency and lifecycle behavior
- Business invariants
- Compatibility and versioning
- Environment and integration setup from the consumer perspective
- Consumer examples
- Known gaps and unresolved questions

When implementation and contract disagree, say so explicitly.

Do not include repository-local `npm`, Prisma, Docker Compose, or integration
test commands in `docs/api-consumer-guide.md`. If those commands are relevant,
keep them in maintainer-only docs instead of the copied consumer guide.

### 4. Update the agent handoff

Keep `docs/api-agent-handoff.md` short and actionable.

Include:

- Upstream contract and guide sources
- Primary workflows
- Authentication summary
- Key constraints
- Retry/idempotency rules
- Consumer integration checklist or handoff guidance
- Unresolved issues

Do not include repository-local skill paths, command paths, validation
commands, or integration-test commands in `docs/api-agent-handoff.md`. That
handoff must still make sense after being copied into a different repository.

## Validation Requirements

Run these with explicit timeouts because long-running processes are known to hang on this machine:

```bash
npm run db:validate
npm run api:validate
npm run lint
npm run build
```

For integration tests, confirm the test database is disposable before running:

```bash
npm run db:setup
npm run dev:test
npm run test:postgresql
```

Notes:

- `db:setup` uses Prisma CLI and reads `.env`.
- `dev:test` explicitly loads `.env.test`.
- Ensure the disposable database configuration is available to both before running destructive tests.
- Always apply explicit tool timeouts to shell commands in this repository.

These validation commands are for the agent updating this repository. They are
not content requirements for the copied consumer-facing docs.

## Reporting Requirements

At the end, report:

- Files changed
- Workflows documented
- Commands run and results
- Confirmed contract/implementation discrepancies
- What could not be validated

## Non-Goals

- Do not change runtime behavior unless explicitly requested.
- Do not rewrite the entire codebase documentation.
- Do not add browser-facing auth guidance that implies these credentials are safe in frontend code.

After adding or editing this skill or related OpenCode config files, remind the user that OpenCode must be restarted before the new skill is available.

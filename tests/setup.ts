import path from 'node:path';
import { config } from 'dotenv';
import { resolveEmailV2ApiKey } from '@/lib/environment';

config({ path: path.resolve(__dirname, '../.env.test') });

const LOCAL_COMPOSE_TEST_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/resend_test';
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL?.trim() || LOCAL_COMPOSE_TEST_DATABASE_URL;

export const TEST_CONFIG = {
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  emailV2ApiKey: resolveEmailV2ApiKey() || 'test-conversation-v2-api-key',
  outboxDrainApiKey:
    process.env.OUTBOX_DRAIN_API_KEY || 'test-outbox-drain-api-key',
  resendApiBaseUrl: process.env.RESEND_API_BASE_URL || 'http://localhost:4010',
  replyToBaseAddress:
    process.env.RESEND_REPLY_TO || 'mailbox@replies.example.com',
  webhookSecret:
    process.env.RESEND_WEBHOOK_SECRET ||
    'whsec_dGVzdF9zZWNyZXRfa2V5X2Zvcl90ZXN0aW5nXzEyMzQ=',
  postgresql: {
    url: testDatabaseUrl,
  },
};

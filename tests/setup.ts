import path from 'node:path';
import { config } from 'dotenv';

config({ path: path.resolve(__dirname, '../.env.test') });

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error(
    'Missing TEST_DATABASE_URL environment variable for destructive PostgreSQL integration tests',
  );
}

export const TEST_CONFIG = {
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  conversationApiKey:
    process.env.CONVERSATION_API_KEY || 'test-conversation-api-key',
  emailV2ApiKey: process.env.EMAIL_v2_API_KEY || 'test-conversation-v2-api-key',
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

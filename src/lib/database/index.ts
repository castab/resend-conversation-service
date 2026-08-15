export type {
  ConversationState,
  EmailConversation,
  EmailMessage,
  EmailWebhookEvent,
} from '../../generated/prisma/client';
export { Prisma, PrismaClient } from '../../generated/prisma/client';
export { getPrismaClient } from './client';
export {
  isEmailAddressAllowed,
  lockAllowedEmailIdentities,
  lockAllowedEmailIdentity,
} from './email-address-allowlist';

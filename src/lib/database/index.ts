export type {
  EmailConversation,
  EmailMessage,
  EmailWebhookEvent,
} from '../../generated/prisma/client';
export { Prisma, PrismaClient } from '../../generated/prisma/client';
export { getPrismaClient } from './client';
export {
  isEmailAddressAllowed,
  lockAllowedEmailIdentities,
} from './email-address-allowlist';

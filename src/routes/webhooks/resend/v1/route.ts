import { wakeAttachmentIngestRuntime } from '@/lib/attachments';
import { getPrismaClient, Prisma, type PrismaClient } from '@/lib/database';
import type {
  ContactWebhookEvent,
  DomainWebhookEvent,
  EmailWebhookEvent,
} from '@/lib/email';
import {
  extractMessageIds,
  getConfiguredResendClient,
  getHeader,
  hydrateReferencedOutboundMessages,
  isValidReplyToBaseAddress,
  parseAddress,
  projectInboundEmail,
  projectOutboundDeliveryStateForResendEmail,
} from '@/lib/email';
import {
  createWebhookHandler,
  prepareContactEventData,
  prepareDomainEventData,
  prepareEmailEventData,
} from '@/lib/webhook-handler';

async function insertEmailEvent(
  client: PrismaClient,
  event: EmailWebhookEvent,
  svixId: string,
) {
  const existingEvent = await client.emailWebhookEvent.findUnique({
    where: { svixId },
  });
  if (existingEvent && event.type !== 'email.received') {
    await client.$transaction((transaction) =>
      projectOutboundDeliveryStateForResendEmail(
        transaction,
        existingEvent.emailId,
      ),
    );
    return;
  }

  const data = prepareEmailEventData(event);
  const createEmailEvent = (
    transaction: PrismaClient | Prisma.TransactionClient,
  ) =>
    transaction.emailWebhookEvent.createMany({
      data: [
        {
          svixId,
          eventType: data.event_type,
          eventCreatedAt: data.event_created_at,
          emailId: data.email_id,
          fromAddress: data.from_address,
          toAddresses: data.to_addresses,
          subject: data.subject,
          emailCreatedAt: data.email_created_at,
          broadcastId: data.broadcast_id,
          templateId: data.template_id,
          tags:
            data.tags?.map(({ name, value }) => ({ name, value })) ??
            Prisma.DbNull,
          bounceType: data.bounce_type,
          bounceSubType: data.bounce_sub_type,
          bounceMessage: data.bounce_message,
          bounceDiagnosticCode: data.bounce_diagnostic_code ?? [],
          deliveryDetail: data.delivery_detail,
          clickIpAddress: data.click_ip_address,
          clickLink: data.click_link,
          clickTimestamp: data.click_timestamp,
          clickUserAgent: data.click_user_agent,
        },
      ],
      skipDuplicates: true,
    });

  if (event.type !== 'email.received') {
    await client.$transaction(async (transaction) => {
      await createEmailEvent(transaction);
      await projectOutboundDeliveryStateForResendEmail(
        transaction,
        data.email_id,
      );
    });
    return;
  }

  await createEmailEvent(client);

  if (event.type === 'email.received') {
    const configuredReplyTo = process.env.RESEND_REPLY_TO;
    if (!configuredReplyTo || !isValidReplyToBaseAddress(configuredReplyTo)) {
      throw new Error('Missing or invalid RESEND_REPLY_TO configuration');
    }
    const existingReceivedMessage = await client.emailMessage.findUnique({
      where: { resendEmailId: event.data.email_id },
    });
    const resend = getConfiguredResendClient();
    if (existingReceivedMessage) {
      await hydrateReferencedOutboundMessages(
        client,
        resend,
        existingReceivedMessage.fromAddress,
        [
          ...existingReceivedMessage.referenceInternetMessageIds,
          ...(existingReceivedMessage.inReplyToInternetMessageId
            ? [existingReceivedMessage.inReplyToInternetMessageId]
            : []),
        ],
        existingReceivedMessage.inReplyToInternetMessageId ??
          existingReceivedMessage.referenceInternetMessageIds.at(-1),
      );
      return;
    }

    const receivedEmail = await resend.getReceived(event.data.email_id);
    const inReplyTo = extractMessageIds(
      getHeader(receivedEmail.headers, 'in-reply-to'),
    );
    const references = extractMessageIds(
      getHeader(receivedEmail.headers, 'references'),
    );
    await hydrateReferencedOutboundMessages(
      client,
      resend,
      parseAddress(event.data.from || receivedEmail.from).address,
      [...references, ...inReplyTo],
      inReplyTo.at(-1) ?? references.at(-1),
    );
    await projectInboundEmail(
      client,
      event.data,
      receivedEmail,
      configuredReplyTo,
    );
    // Any attachments were recorded as PENDING inside that projection. Nudge
    // the ingest runtime so their bytes are copied now instead of on its next
    // poll; the webhook itself never waits for the transfer.
    wakeAttachmentIngestRuntime();
  }
}

async function insertContactEvent(
  client: PrismaClient,
  event: ContactWebhookEvent,
  svixId: string,
) {
  const data = prepareContactEventData(event);

  await client.contactWebhookEvent.createMany({
    data: [
      {
        svixId,
        eventType: data.event_type,
        eventCreatedAt: data.event_created_at,
        contactId: data.contact_id,
        audienceId: data.audience_id,
        segmentIds: data.segment_ids,
        email: data.email,
        firstName: data.first_name,
        lastName: data.last_name,
        unsubscribed: data.unsubscribed,
        contactCreatedAt: data.contact_created_at,
        contactUpdatedAt: data.contact_updated_at,
      },
    ],
    skipDuplicates: true,
  });
}

async function insertDomainEvent(
  client: PrismaClient,
  event: DomainWebhookEvent,
  svixId: string,
) {
  const data = prepareDomainEventData(event);

  await client.domainWebhookEvent.createMany({
    data: [
      {
        svixId,
        eventType: data.event_type,
        eventCreatedAt: data.event_created_at,
        domainId: data.domain_id,
        name: data.name,
        status: data.status,
        region: data.region,
        domainCreatedAt: data.domain_created_at,
        records: data.records.map(
          ({ record, name, type, value, ttl, status, priority }) => ({
            record,
            name,
            type,
            value,
            ttl,
            status,
            ...(priority === undefined ? {} : { priority }),
          }),
        ),
      },
    ],
    skipDuplicates: true,
  });
}

export const POST = createWebhookHandler({
  getClient: getPrismaClient,
  insertEmailEvent,
  insertContactEvent,
  insertDomainEvent,
});

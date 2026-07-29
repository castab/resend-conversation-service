import { TEST_CONFIG } from '@test-support/setup';
import { Client } from 'pg';

type TableName =
  | 'resend_wh_emails'
  | 'resend_wh_contacts'
  | 'resend_wh_domains';

export class PostgreSQLTestClient {
  private client: Client | null = null;

  async connect() {
    this.client = new Client({
      connectionString: TEST_CONFIG.postgresql.url,
    });
    await this.client.connect();
  }

  async findBySvixId(table: TableName, svixId: string) {
    if (!this.client) {
      throw new Error('Not connected');
    }

    const { rows } = await this.client.query(
      `SELECT * FROM ${table} WHERE svix_id = $1`,
      [svixId],
    );
    return rows[0] || null;
  }

  async countBySvixId(table: TableName, svixId: string): Promise<number> {
    if (!this.client) {
      throw new Error('Not connected');
    }

    const { rows } = await this.client.query(
      `SELECT COUNT(*) as count FROM ${table} WHERE svix_id = $1`,
      [svixId],
    );
    return Number.parseInt(rows[0].count, 10);
  }

  async getUuidVersionBySvixId(
    table: TableName,
    svixId: string,
  ): Promise<number | null> {
    if (!this.client) {
      throw new Error('Not connected');
    }

    const { rows } = await this.client.query(
      `SELECT uuid_extract_version(id) AS uuid_version FROM ${table} WHERE svix_id = $1`,
      [svixId],
    );
    return rows[0]?.uuid_version ?? null;
  }

  async truncate(table: TableName) {
    if (!this.client) {
      throw new Error('Not connected');
    }

    await this.client.query(`TRUNCATE TABLE ${table}`);
  }

  async truncateConversations() {
    if (!this.client) {
      throw new Error('Not connected');
    }
    await this.client.query(
      'TRUNCATE TABLE email_messages, email_conversations CASCADE',
    );
  }

  async findEmailMessageByResendId(resendEmailId: string) {
    if (!this.client) {
      throw new Error('Not connected');
    }
    const { rows } = await this.client.query(
      'SELECT * FROM email_messages WHERE resend_email_id = $1',
      [resendEmailId],
    );
    return rows[0] || null;
  }

  async getThreadState(childResendEmailId: string) {
    if (!this.client) {
      throw new Error('Not connected');
    }
    const { rows } = await this.client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM email_conversations) AS conversation_count,
         parent.internet_message_id AS parent_internet_message_id
       FROM email_messages child
       LEFT JOIN email_messages parent ON parent.id = child.parent_message_id
       WHERE child.resend_email_id = $1`,
      [childResendEmailId],
    );
    return rows[0] || null;
  }

  async createRoutedConversation(participantAddress: string) {
    if (!this.client) {
      throw new Error('Not connected');
    }
    const { rows } = await this.client.query(
      `INSERT INTO email_conversations
         (topic_type, external_topic_id, title, subject, participant_address,
          last_message_at, updated_at)
       VALUES ('test', gen_random_uuid()::text, 'Routed message',
               'Routed message', $1, now(), now())
       RETURNING routing_token`,
      [participantAddress],
    );
    return { routingToken: rows[0].routing_token as string };
  }

  async createOutboundWithoutInternetMessageId(
    resendEmailId: string,
    participantAddress: string,
  ) {
    if (!this.client) {
      throw new Error('Not connected');
    }
    await this.client.query(
      `WITH conversation AS (
         INSERT INTO email_conversations
           (topic_type, external_topic_id, title, subject,
            participant_address, last_message_at, updated_at)
         VALUES
           ('test', $1, 'Threaded message', 'Threaded message', $2, now(), now())
         RETURNING id
       ), known_parent AS (
          INSERT INTO email_messages
            (conversation_id, direction, state, delivery_state, resend_email_id,
             internet_message_id, reference_internet_message_ids, from_address,
             to_address, subject, text_body, email_created_at, updated_at)
          SELECT id, 'OUTBOUND', 'ACCEPTED', 'UNKNOWN', $1 || '-known',
                 '<known-' || $1 || '@resend.test>', '{}',
                 'mailbox@example.com', $2, 'Threaded message',
                 'Earlier message', now() - interval '1 minute', now()
         FROM conversation
       )
        INSERT INTO email_messages
          (conversation_id, direction, state, delivery_state, resend_email_id,
           reference_internet_message_ids, from_address, to_address, subject,
           text_body, email_created_at, updated_at)
        SELECT id, 'OUTBOUND', 'ACCEPTED', 'UNKNOWN', $1, '{}', 'mailbox@example.com', $2,
               'Threaded message', 'Opening message', now(), now()
       FROM conversation`,
      [resendEmailId, participantAddress],
    );
  }

  async createWaitingInboundMessage(
    resendEmailId: string,
    participantAddress: string,
    parentInternetMessageId: string,
  ) {
    if (!this.client) {
      throw new Error('Not connected');
    }
    await this.client.query(
      `WITH conversation AS (
         INSERT INTO email_conversations
           (title, subject, participant_address, last_message_at, updated_at)
         VALUES ('Waiting reply', 'Waiting reply', $2, now(), now())
         RETURNING id
       )
       INSERT INTO email_messages
         (conversation_id, direction, state, resend_email_id,
          internet_message_id, in_reply_to_internet_message_id,
          reference_internet_message_ids, from_address, to_address, subject,
          text_body, email_created_at, updated_at)
       SELECT id, 'INBOUND', 'RECEIVED', $1, '<waiting-child@example.com>', $3,
              ARRAY[$3], $2, 'mailbox@example.com', 'Re: Waiting reply',
              'Waiting child', now(), now()
       FROM conversation`,
      [resendEmailId, participantAddress, parentInternetMessageId],
    );
  }

  async close() {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }
}

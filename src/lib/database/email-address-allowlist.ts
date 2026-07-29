import type {
  EmailAddressRole,
  Prisma,
  PrismaClient,
} from '../../generated/prisma/client';

export async function isEmailAddressAllowed(
  client: PrismaClient,
  address: string,
  role: EmailAddressRole,
): Promise<boolean> {
  return (
    (await client.emailAddressAllowlistEntry.findUnique({
      where: { address_role: { address, role } },
      select: { id: true },
    })) !== null
  );
}

export async function lockAllowedEmailIdentities(
  transaction: Prisma.TransactionClient,
  fromAddress: string,
  replyToAddress: string,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ role: EmailAddressRole }>>`
    SELECT role
    FROM email_address_allowlist_entries
    WHERE (address = ${fromAddress} AND role = 'FROM')
       OR (address = ${replyToAddress} AND role = 'REPLY_TO')
    FOR KEY SHARE
  `;
  const roles = new Set(rows.map((row) => row.role));
  return roles.has('FROM') && roles.has('REPLY_TO');
}

export async function lockAllowedEmailIdentity(
  transaction: Prisma.TransactionClient,
  address: string,
  role: EmailAddressRole,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM email_address_allowlist_entries
    WHERE address = ${address}
      AND role = ${role}::"EmailAddressRole"
    FOR KEY SHARE
  `;
  return rows.length === 1;
}

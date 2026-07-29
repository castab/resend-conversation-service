import { sendDirectEmailV2 } from '@/lib/direct-email-v2';

export async function POST(request: Request) {
  return sendDirectEmailV2(request, 'outbox');
}

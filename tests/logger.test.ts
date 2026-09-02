import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, runWithRequestContext } from '@/lib/logger';

describe('structured logger', () => {
  it('writes JSON with a generated request correlation ID', () => {
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
    const logger = createLogger(output);

    runWithRequestContext(() => {
      logger.info(
        {
          event: 'http_request_completed',
          route: '/api/health/v2',
          email: 'participant@example.com',
          subject: 'sensitive subject',
        },
        'http_request_completed',
      );
    });

    const record = JSON.parse(lines.join('')) as Record<string, unknown>;
    expect(record).toMatchObject({
      event: 'http_request_completed',
      route: '/api/health/v2',
    });
    expect(record.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(record).not.toHaveProperty('email');
    expect(record).not.toHaveProperty('subject');
  });
});

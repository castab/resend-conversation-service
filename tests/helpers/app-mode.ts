import { TEST_CONFIG } from '@test-support/setup';

/**
 * Confirms the application under test is running in the attachments mode the
 * suite expects.
 *
 * Suites talk to a separately started process, so nothing otherwise stops them
 * from running against a stale server left over from an earlier run. When that
 * happens the symptom is an unrelated assertion failing somewhere far away,
 * which is expensive to diagnose. The attachment routes are registered only
 * when the feature is enabled, so an unauthenticated probe distinguishes the
 * two modes without needing a credential: 401 when the route exists, 404 when
 * it was never registered.
 */
export async function assertAttachmentsMode(): Promise<void> {
  const expected =
    (process.env.ATTACHMENTS_ENABLED ?? '').trim().toLowerCase() === 'true';

  let response: Response;
  try {
    response = await fetch(`${TEST_CONFIG.appBaseUrl}/api/attachments/v2`, {
      method: 'POST',
    });
  } catch (error) {
    throw new Error(
      `No application is reachable at ${TEST_CONFIG.appBaseUrl}: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }

  const actual = response.status === 401;
  if (actual === expected) {
    return;
  }
  throw new Error(
    `The application at ${TEST_CONFIG.appBaseUrl} has attachments ` +
      `${actual ? 'enabled' : 'disabled'}, but this suite expects them ` +
      `${expected ? 'enabled' : 'disabled'}. A stale server from an earlier ` +
      'run is the usual cause: a replacement cannot bind the port while the ' +
      'old one holds it, so it exits and the old one keeps serving.',
  );
}

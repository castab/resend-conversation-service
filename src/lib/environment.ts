export function resolveEmailV2ApiKey(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return environment.EMAIL_v2_API_KEY || environment.EMAIL_V2_API_KEY;
}

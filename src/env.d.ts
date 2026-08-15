declare namespace NodeJS {
  interface ProcessEnv {
    DATABASE_URL: string;
    RESEND_API_KEY: string;
    RESEND_API_BASE_URL?: string;
    RESEND_WEBHOOK_SECRET: string;
    RESEND_REPLY_TO: string;
    EMAIL_v2_API_KEY?: string;
    EMAIL_V2_API_KEY?: string;
    OUTBOX_DRAIN_API_KEY: string;
  }
}

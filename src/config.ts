const bool = (v: string | undefined, def: boolean): boolean =>
  v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const int = (v: string | undefined, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : def;
};

export const config = {
  get baseUrl(): string {
    return process.env.BASE_URL || 'https://www.monespaceconsuel.com';
  },
  port: int(process.env.PORT, 8080),
  get apiKey(): string {
    return process.env.API_KEY || '';
  },
  production: process.env.NODE_ENV === 'production',
  headless: bool(process.env.HEADLESS, true),
  slowMo: int(process.env.SLOW_MO_MS, 0),
  dryRun: bool(process.env.DRY_RUN, false),
  screenshotDir: process.env.SCREENSHOT_DIR || '/tmp/screenshots',
  returnScreenshot: bool(process.env.RETURN_SCREENSHOT, false),
  // Plafond du webm inclus dans la réponse HTTP (le base64 grossit d'un tiers).
  videoMaxBytes: int(process.env.VIDEO_MAX_BYTES, 16 * 1024 * 1024),
  actionTimeoutMs: int(process.env.ACTION_TIMEOUT_MS, 30_000),
  runTimeoutMs: int(process.env.RUN_TIMEOUT_MS, 840_000),
  dreMaxBytes: int(process.env.DRE_MAX_BYTES, 25 * 1024 * 1024),
};

export function getCredentials(): { login: string; password: string } {
  const login = process.env.CONSUEL_LOGIN;
  const password = process.env.CONSUEL_PASSWORD;
  if (!login || !password) {
    throw new Error('Variables CONSUEL_LOGIN et CONSUEL_PASSWORD manquantes');
  }
  return { login, password };
}

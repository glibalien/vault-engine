export interface AuthEnvConfig {
  ownerPassword: string;
  issuerUrl: URL;
}

export function validateAuthEnv(
  password: string | undefined,
  issuerUrl: string | undefined,
): AuthEnvConfig {
  if (!password) {
    throw new Error(
      'OAUTH_OWNER_PASSWORD is required for HTTP transport. Set it in your .env file.',
    );
  }

  if (!issuerUrl) {
    throw new Error(
      'OAUTH_ISSUER_URL is required for HTTP transport. Set it to your Cloudflare tunnel URL (e.g., https://vault.example.com).',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(issuerUrl);
  } catch {
    throw new Error(
      `OAUTH_ISSUER_URL is not a valid URL: "${issuerUrl}". Expected format: https://your-tunnel.example.com`,
    );
  }

  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLocalhost) {
    throw new Error(
      `OAUTH_ISSUER_URL must use HTTPS (got "${parsed.protocol}"). HTTP is only allowed for localhost/127.0.0.1.`,
    );
  }

  return { ownerPassword: password, issuerUrl: parsed };
}

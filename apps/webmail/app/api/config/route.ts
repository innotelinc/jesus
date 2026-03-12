import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

/**
 * Runtime configuration endpoint
 *
 * This endpoint serves configuration values that can be set at runtime
 * via environment variables, enabling post-build configuration for
 * Docker deployments.
 *
 * Priority order:
 * 1. Runtime env vars (APP_NAME, JMAP_SERVER_URL)
 * 2. Build-time env vars (NEXT_PUBLIC_APP_NAME, NEXT_PUBLIC_JMAP_SERVER_URL)
 * 3. Default values
 */
export async function GET() {
  logger.debug('Config requested');
  return NextResponse.json({
    appName: process.env.APP_NAME || process.env.NEXT_PUBLIC_APP_NAME || 'Webmail',
    jmapServerUrl: process.env.JMAP_SERVER_URL || process.env.NEXT_PUBLIC_JMAP_SERVER_URL || '',
    oauthEnabled: process.env.OAUTH_ENABLED === 'true',
    oauthClientId: process.env.OAUTH_CLIENT_ID || '',
    oauthIssuerUrl: process.env.OAUTH_ISSUER_URL || '',
    rememberMeEnabled: !!process.env.SESSION_SECRET,
    settingsSyncEnabled: process.env.SETTINGS_SYNC_ENABLED === 'true' && !!process.env.SESSION_SECRET,
    stalwartFeaturesEnabled: process.env.STALWART_FEATURES !== 'false',
    devMode: process.env.DEV_MOCK_JMAP === 'true',
    loginCompanyName: process.env.LOGIN_COMPANY_NAME || '',
    loginImprintUrl: process.env.LOGIN_IMPRINT_URL || '',
    loginPrivacyPolicyUrl: process.env.LOGIN_PRIVACY_POLICY_URL || '',
    loginWebsiteUrl: process.env.LOGIN_WEBSITE_URL || '',
  });
}

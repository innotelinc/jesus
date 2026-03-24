import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminPassword, updateLastLogin, isAdminEnabled, getAdminMeta } from '@/lib/admin/password';
import { setAdminSessionCookie, clearAdminSessionCookie, requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { checkRateLimit } from '@/lib/admin/rate-limit';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';

/**
 * POST /api/admin/auth — Login
 */
export async function POST(request: NextRequest) {
  try {
    if (!isAdminEnabled()) {
      return NextResponse.json({ error: 'Admin dashboard is not configured' }, { status: 404 });
    }

    const ip = getClientIP(request);

    // Rate limit check
    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      const retryAfter = Math.ceil(limit.retryAfterMs / 1000);
      await auditLog('admin.login_blocked', { reason: 'rate_limit' }, ip);
      return NextResponse.json(
        { error: 'Too many login attempts. Try again later.' },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      );
    }

    const body = await request.json();
    const { password } = body;

    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: 'Password is required' }, { status: 400 });
    }

    const valid = await verifyAdminPassword(password);
    if (!valid) {
      await auditLog('admin.login_failed', {}, ip);
      logger.warn('Admin login failed', { ip });
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }

    await setAdminSessionCookie();
    await updateLastLogin();
    await auditLog('admin.login', {}, ip);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Admin login error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET /api/admin/auth — Check session status
 */
export async function GET() {
  try {
    if (!isAdminEnabled()) {
      return NextResponse.json({ enabled: false, authenticated: false }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const result = await requireAdminAuth();
    if ('error' in result) {
      return NextResponse.json({ enabled: true, authenticated: false }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const meta = getAdminMeta();
    return NextResponse.json({
      enabled: true,
      authenticated: true,
      lastLogin: meta?.lastLogin,
      passwordChangedAt: meta?.passwordChangedAt,
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    logger.error('Admin status error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/auth — Logout
 */
export async function DELETE(request: NextRequest) {
  try {
    const ip = getClientIP(request);
    await clearAdminSessionCookie();
    await auditLog('admin.logout', {}, ip);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Admin logout error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

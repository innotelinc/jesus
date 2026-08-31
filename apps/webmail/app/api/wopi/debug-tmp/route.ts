import { NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';

export const dynamic = 'force-dynamic';

// TEMPORARY dev-only reload trigger - delete before commit.
export async function POST() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  await configManager.reload();
  return NextResponse.json({
    devMode: configManager.get<boolean>('devMode', false),
    demoMode: configManager.get<boolean>('demoMode', false),
  });
}

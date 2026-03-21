"use client";

import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { SettingsSection, SettingItem } from './settings-section';
import { formatFileSize } from '@/lib/utils';

export function AccountSettings() {
  const t = useTranslations('settings.account');
  const { username, serverUrl, isDemoMode, primaryIdentity } = useAuthStore();
  const { quota } = useEmailStore();

  const quotaPercentage = quota ? Math.round((quota.used / quota.total) * 100) : 0;
  const displayName = primaryIdentity?.name || (isDemoMode ? 'Demo User' : undefined);

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {/* Display Name (show in demo mode or when identity has a name) */}
      {displayName && (
        <SettingItem label={t('name_label')}>
          <span className="text-sm text-foreground">{displayName}</span>
        </SettingItem>
      )}

      {/* Email Address */}
      <SettingItem label={t('email.label')}>
        <span className="text-sm text-foreground">{username || t('../../common.unknown')}</span>
      </SettingItem>

      {/* Server */}
      <SettingItem label={t('server.label')}>
        <span className="text-sm text-foreground truncate max-w-xs">
          {serverUrl || t('../../common.unknown')}
        </span>
      </SettingItem>

      {/* Storage */}
      {quota && quota.total > 0 && (
        <SettingItem
          label={t('storage.label')}
          description={t('storage.used', {
            used: formatFileSize(quota.used),
            total: formatFileSize(quota.total),
          })}
        >
          <div className="flex flex-col items-end gap-1">
            <span className="text-sm text-foreground">
              {t('storage.percentage', { percent: quotaPercentage })}
            </span>
            <div className="w-32 h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${quotaPercentage}%` }}
              />
            </div>
          </div>
        </SettingItem>
      )}

      {/* Demo mode indicator */}
      {isDemoMode && (
        <SettingItem label={t('account_type_label')}>
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
            <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
            {t('demo_account')}
          </span>
        </SettingItem>
      )}
    </SettingsSection>
  );
}

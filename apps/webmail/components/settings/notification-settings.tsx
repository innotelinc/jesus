"use client";

import { useTranslations } from 'next-intl';
import { useSettingsStore } from '@/stores/settings-store';
import { SettingsSection, SettingItem, ToggleSwitch, Select } from './settings-section';
import { playNotificationSound, NOTIFICATION_SOUNDS } from '@/lib/notification-sound';
import type { NotificationSoundChoice } from '@/lib/notification-sound';
import { Button } from '@/components/ui/button';
import { Volume2 } from 'lucide-react';

export function NotificationSettings() {
  const t = useTranslations('settings.notifications');
  const {
    emailNotificationsEnabled,
    emailNotificationSound,
    notificationSoundChoice,
    calendarNotificationsEnabled,
    calendarNotificationSound,
    calendarInvitationParsingEnabled,
    updateSetting,
  } = useSettingsStore();

  const soundOptions = NOTIFICATION_SOUNDS.map((s) => ({
    value: s.id,
    label: t(`sounds.${s.id}`),
  }));

  return (
    <div className="space-y-8">
      <SettingsSection title={t('sound_selection.title')} description={t('sound_selection.description')}>
        <SettingItem
          label={t('sound_selection.choose')}
          description={t('sound_selection.choose_desc')}
        >
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => playNotificationSound(notificationSoundChoice)}
              title={t('test_sound')}
            >
              <Volume2 className="w-4 h-4" />
            </Button>
            <Select
              value={notificationSoundChoice}
              onChange={(value) => {
                const choice = value as NotificationSoundChoice;
                updateSetting('notificationSoundChoice', choice);
                playNotificationSound(choice);
              }}
              options={soundOptions}
            />
          </div>
        </SettingItem>
      </SettingsSection>

      <SettingsSection title={t('email.title')} description={t('email.description')}>
        <SettingItem
          label={t('email.enabled')}
          description={t('email.enabled_desc')}
        >
          <ToggleSwitch
            checked={emailNotificationsEnabled}
            onChange={(checked) => updateSetting('emailNotificationsEnabled', checked)}
          />
        </SettingItem>

        <SettingItem
          label={t('email.sound')}
          description={t('email.sound_desc')}
        >
          <ToggleSwitch
            checked={emailNotificationSound}
            onChange={(checked) => updateSetting('emailNotificationSound', checked)}
            disabled={!emailNotificationsEnabled}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title={t('calendar.title')} description={t('calendar.description')}>
        <SettingItem
          label={t('calendar.enabled')}
          description={t('calendar.enabled_desc')}
        >
          <ToggleSwitch
            checked={calendarNotificationsEnabled}
            onChange={(checked) => updateSetting('calendarNotificationsEnabled', checked)}
          />
        </SettingItem>

        <SettingItem
          label={t('calendar.sound')}
          description={t('calendar.sound_desc')}
        >
          <ToggleSwitch
            checked={calendarNotificationSound}
            onChange={(checked) => updateSetting('calendarNotificationSound', checked)}
            disabled={!calendarNotificationsEnabled}
          />
        </SettingItem>

        <SettingItem
          label={t('calendar.invitation_parsing')}
          description={t('calendar.invitation_parsing_desc')}
        >
          <ToggleSwitch
            checked={calendarInvitationParsingEnabled}
            onChange={(checked) => updateSetting('calendarInvitationParsingEnabled', checked)}
          />
        </SettingItem>
      </SettingsSection>
    </div>
  );
}

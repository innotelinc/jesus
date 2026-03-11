"use client";

import { useTranslations } from 'next-intl';
import { useThemeStore } from '@/stores/theme-store';
import { useSettingsStore, type ToolbarPosition } from '@/stores/settings-store';
import { LanguageSwitcher } from '@/components/ui/language-switcher';
import { SettingsSection, SettingItem, RadioGroup, ToggleSwitch } from './settings-section';

export function AppearanceSettings() {
  const t = useTranslations('settings.appearance');
  const { theme, setTheme } = useThemeStore();
  const { fontSize, listDensity, animationsEnabled, toolbarPosition, updateSetting } = useSettingsStore();

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {/* Theme */}
      <SettingItem label={t('theme.label')} description={t('theme.description')}>
        <RadioGroup
          value={theme}
          onChange={(value) => setTheme(value as 'light' | 'dark' | 'system')}
          options={[
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
            { value: 'system', label: t('theme.system') },
          ]}
        />
      </SettingItem>

      {/* Language */}
      <SettingItem label={t('language.label')} description={t('language.description')}>
        <LanguageSwitcher />
      </SettingItem>

      {/* Font Size */}
      <SettingItem label={t('font_size.label')} description={t('font_size.description')}>
        <RadioGroup
          value={fontSize}
          onChange={(value) => updateSetting('fontSize', value as 'small' | 'medium' | 'large')}
          options={[
            { value: 'small', label: t('font_size.small') },
            { value: 'medium', label: t('font_size.medium') },
            { value: 'large', label: t('font_size.large') },
          ]}
        />
      </SettingItem>

      {/* List Density */}
      <SettingItem label={t('list_density.label')} description={t('list_density.description')}>
        <RadioGroup
          value={listDensity}
          onChange={(value) =>
            updateSetting('listDensity', value as 'compact' | 'regular' | 'comfortable')
          }
          options={[
            { value: 'compact', label: t('list_density.compact') },
            { value: 'regular', label: t('list_density.regular') },
            { value: 'comfortable', label: t('list_density.comfortable') },
          ]}
        />
      </SettingItem>

      {/* Toolbar Position */}
      <SettingItem label={t('toolbar_position.label')} description={t('toolbar_position.description')}>
        <RadioGroup
          value={toolbarPosition}
          onChange={(value) => updateSetting('toolbarPosition', value as ToolbarPosition)}
          options={[
            { value: 'top', label: t('toolbar_position.top') },
            { value: 'below-subject', label: t('toolbar_position.below_subject') },
          ]}
        />
      </SettingItem>

      {/* Animations */}
      <SettingItem label={t('animations.label')} description={t('animations.description')}>
        <ToggleSwitch
          checked={animationsEnabled}
          onChange={(checked) => updateSetting('animationsEnabled', checked)}
        />
      </SettingItem>
    </SettingsSection>
  );
}

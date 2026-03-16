"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { SettingsSection, SettingItem, ToggleSwitch, RadioGroup } from "./settings-section";
import { loadFilesSettings, saveFilesSettings, type FilesSettings, type FolderLayout } from "@/components/files/files-settings-dialog";

export function FilesSettingsComponent() {
  const t = useTranslations("settings.files");
  const [settings, setSettings] = useState<FilesSettings>(loadFilesSettings);

  // Listen for external changes (e.g. if file-browser updates settings)
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "files-settings") {
        setSettings(loadFilesSettings());
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const update = useCallback((patch: Partial<FilesSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      saveFilesSettings(next);
      return next;
    });
  }, []);

  return (
    <div className="space-y-8">
      <SettingsSection title={t("display.title")} description={t("display.description")}>
        <SettingItem label={t("folder_layout.label")} description={t("folder_layout.description")}>
          <RadioGroup
            value={settings.folderLayout}
            onChange={(v) => update({ folderLayout: v as FolderLayout })}
            options={[
              { value: "inline", label: t("folder_layout.inline") },
              { value: "sidebar", label: t("folder_layout.sidebar") },
            ]}
          />
        </SettingItem>
        <SettingItem label={t("default_view.label")} description={t("default_view.description")}>
          <RadioGroup
            value={settings.defaultViewMode}
            onChange={(v) => update({ defaultViewMode: v as "list" | "grid" })}
            options={[
              { value: "list", label: t("default_view.list") },
              { value: "grid", label: t("default_view.grid") },
            ]}
          />
        </SettingItem>
        <SettingItem label={t("default_sort.label")} description={t("default_sort.description")}>
          <RadioGroup
            value={settings.defaultSortKey}
            onChange={(v) => update({ defaultSortKey: v as "name" | "size" | "modified" })}
            options={[
              { value: "name", label: t("default_sort.name") },
              { value: "size", label: t("default_sort.size") },
              { value: "modified", label: t("default_sort.modified") },
            ]}
          />
        </SettingItem>
        <SettingItem label={t("sort_direction.label")} description={t("sort_direction.description")}>
          <RadioGroup
            value={settings.defaultSortDir}
            onChange={(v) => update({ defaultSortDir: v as "asc" | "desc" })}
            options={[
              { value: "asc", label: t("sort_direction.ascending") },
              { value: "desc", label: t("sort_direction.descending") },
            ]}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title={t("icons.title")} description={t("icons.description")}>
        <SettingItem label={t("show_icons.label")} description={t("show_icons.description")}>
          <ToggleSwitch
            checked={settings.showIcons}
            onChange={(v) => update({ showIcons: v })}
          />
        </SettingItem>
        <SettingItem label={t("colored_icons.label")} description={t("colored_icons.description")}>
          <ToggleSwitch
            checked={settings.coloredIcons}
            onChange={(v) => update({ coloredIcons: v })}
            disabled={!settings.showIcons}
          />
        </SettingItem>
        <SettingItem label={t("show_thumbnails.label")} description={t("show_thumbnails.description")}>
          <ToggleSwitch
            checked={settings.showThumbnails}
            onChange={(v) => update({ showThumbnails: v })}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title={t("behavior.title")} description={t("behavior.description")}>
        <SettingItem label={t("show_hidden.label")} description={t("show_hidden.description")}>
          <ToggleSwitch
            checked={settings.showHiddenFiles}
            onChange={(v) => update({ showHiddenFiles: v })}
          />
        </SettingItem>
      </SettingsSection>
    </div>
  );
}

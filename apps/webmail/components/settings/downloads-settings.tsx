"use client";

import { useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { useSettingsStore } from "@/stores/settings-store";
import { SettingsSection } from "./settings-section";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_ATTACHMENT_TEMPLATE,
  DEFAULT_EMAIL_TEMPLATE,
  EMAIL_TOKENS,
  ATTACHMENT_TOKENS,
  emailExportFilename,
  attachmentDownloadFilename,
  buildSampleEmail,
} from "@/lib/download-filename";

function insertTokenAtCursor(
  input: HTMLInputElement,
  token: string,
  current: string,
  onChange: (next: string) => void,
): void {
  const start = input.selectionStart ?? current.length;
  const end = input.selectionEnd ?? current.length;
  const before = current.slice(0, start);
  const after = current.slice(end);
  const insertion = `{${token}}`;
  const next = `${before}${insertion}${after}`;
  onChange(next);
  // Restore focus and place caret after the inserted token.
  requestAnimationFrame(() => {
    input.focus();
    const caret = before.length + insertion.length;
    input.setSelectionRange(caret, caret);
  });
}

interface TemplateEditorProps {
  label: string;
  description: string;
  value: string;
  defaultValue: string;
  tokens: { token: string; description: string }[];
  preview: string;
  onChange: (next: string) => void;
  resetLabel: string;
  placeholder?: string;
}

function TemplateEditor({
  label,
  description,
  value,
  defaultValue,
  tokens,
  preview,
  onChange,
  resetLabel,
  placeholder,
}: TemplateEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div data-search-label={label} className="space-y-3 py-3 border-b border-border last:border-0">
      <div>
        <label className="text-sm font-medium text-foreground">{label}</label>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-stretch gap-2">
          <input
            ref={inputRef}
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            className="flex-1 px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150"
          />
          <button
            type="button"
            onClick={() => onChange(defaultValue)}
            disabled={value === defaultValue}
            title={resetLabel}
            className={cn(
              "px-2 rounded-md border border-border text-foreground transition-colors duration-150",
              value === defaultValue
                ? "opacity-40 cursor-not-allowed"
                : "hover:bg-muted cursor-pointer",
            )}
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {tokens.map((t) => (
            <button
              key={t.token}
              type="button"
              title={t.description}
              onClick={() => {
                const input = inputRef.current;
                if (!input) {
                  onChange(`${value}{${t.token}}`);
                  return;
                }
                insertTokenAtCursor(input, t.token, value, onChange);
              }}
              className="px-2 py-0.5 text-xs font-mono rounded bg-muted hover:bg-accent border border-border text-foreground transition-colors duration-150 cursor-pointer"
            >
              {`{${t.token}}`}
            </button>
          ))}
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="opacity-70">Preview: </span>
          <span className="font-mono text-foreground/90 break-all">{preview}</span>
        </div>
      </div>
    </div>
  );
}

export function DownloadsSettings() {
  const t = useTranslations("settings.downloads");
  const { emailDownloadTemplate, attachmentDownloadTemplate, updateSetting } = useSettingsStore();

  const sampleEmail = useMemo(() => buildSampleEmail(), []);
  const sampleAttachment = useMemo(() => ({ name: "Invoice-2026-05.pdf", type: "application/pdf" }), []);

  const emlPreview = useMemo(
    () => emailExportFilename(sampleEmail, emailDownloadTemplate || DEFAULT_EMAIL_TEMPLATE),
    [sampleEmail, emailDownloadTemplate],
  );
  const attachmentPreview = useMemo(
    () =>
      attachmentDownloadFilename(
        sampleEmail,
        sampleAttachment,
        attachmentDownloadTemplate || DEFAULT_ATTACHMENT_TEMPLATE,
      ),
    [sampleEmail, sampleAttachment, attachmentDownloadTemplate],
  );

  return (
    <SettingsSection title={t("title")} description={t("description")}>
      <TemplateEditor
        label={t("email_template.label")}
        description={t("email_template.description")}
        value={emailDownloadTemplate}
        defaultValue={DEFAULT_EMAIL_TEMPLATE}
        tokens={EMAIL_TOKENS}
        preview={emlPreview}
        onChange={(next) => updateSetting("emailDownloadTemplate", next)}
        resetLabel={t("reset")}
        placeholder={DEFAULT_EMAIL_TEMPLATE}
      />
      <TemplateEditor
        label={t("attachment_template.label")}
        description={t("attachment_template.description")}
        value={attachmentDownloadTemplate}
        defaultValue={DEFAULT_ATTACHMENT_TEMPLATE}
        tokens={ATTACHMENT_TOKENS}
        preview={attachmentPreview}
        onChange={(next) => updateSetting("attachmentDownloadTemplate", next)}
        resetLabel={t("reset")}
        placeholder={DEFAULT_ATTACHMENT_TEMPLATE}
      />
    </SettingsSection>
  );
}

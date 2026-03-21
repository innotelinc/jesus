"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { X, Loader2, Globe } from "lucide-react";
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useCalendarStore } from "@/stores/calendar-store";
import { CalendarColorPicker } from "@/components/settings/calendar-management-settings";
import { toast } from "@/stores/toast-store";

interface ICalSubscriptionModalProps {
  client: IJMAPClient;
  onClose: () => void;
}

export function ICalSubscriptionModal({ client, onClose }: ICalSubscriptionModalProps) {
  const t = useTranslations("calendar.subscription");
  const tCommon = useTranslations("common");
  const addICalSubscription = useCalendarStore((s) => s.addICalSubscription);

  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3b82f6");
  const [refreshInterval, setRefreshInterval] = useState(60);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const isValid = url.trim().length > 0 && name.trim().length > 0;

  const handleSubmit = useCallback(async () => {
    let trimmedUrl = url.trim();
    if (!trimmedUrl || !name.trim()) return;

    // Convert webcal:// to https://
    if (trimmedUrl.startsWith("webcal://")) {
      trimmedUrl = trimmedUrl.replace(/^webcal:\/\//, "https://");
    }

    try {
      new URL(trimmedUrl);
    } catch {
      setError(t("invalid_url"));
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const subscription = await addICalSubscription(client, trimmedUrl, name.trim(), color, refreshInterval);
      if (subscription) {
        toast.success(t("success", { name: name.trim() }));
        onClose();
      } else {
        setError(t("error"));
      }
    } catch {
      setError(t("error"));
    } finally {
      setIsSubmitting(false);
    }
  }, [url, name, color, refreshInterval, client, addICalSubscription, onClose, t]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const focusableEls = modal.querySelectorAll<HTMLElement>(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
    );
    const firstEl = focusableEls[0];
    const lastEl = focusableEls[focusableEls.length - 1];

    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl?.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl?.focus();
      }
    };
    modal.addEventListener("keydown", handler);
    firstEl?.focus();
    return () => modal.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={onClose} aria-hidden="true" />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("title")}
        className="relative bg-background border border-border rounded-lg shadow-xl w-full max-w-md mx-4 animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{t("title")}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground"
            aria-label={tCommon("close")}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-muted-foreground">{t("description")}</p>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("url_label")}
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("url_placeholder")}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              disabled={isSubmitting}
              onKeyDown={(e) => { if (e.key === "Enter" && isValid) handleSubmit(); }}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("name_label")}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("name_placeholder")}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              disabled={isSubmitting}
              onKeyDown={(e) => { if (e.key === "Enter" && isValid) handleSubmit(); }}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("color_label")}
            </label>
            <CalendarColorPicker value={color} onChange={setColor} allowCustom />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("refresh_interval")}
            </label>
            <select
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(Number(e.target.value))}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              disabled={isSubmitting}
            >
              <option value={15}>{t("interval_15")}</option>
              <option value={30}>{t("interval_30")}</option>
              <option value={60}>{t("interval_60")}</option>
              <option value={360}>{t("interval_360")}</option>
              <option value={1440}>{t("interval_1440")}</option>
            </select>
          </div>

          {error && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-md px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                {t("subscribing")}
              </>
            ) : (
              t("subscribe")
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Trash2 } from "lucide-react";
import { format, parseISO, addHours } from "date-fns";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";
import { parseDuration } from "./event-card";

interface EventModalProps {
  event?: CalendarEvent | null;
  calendars: Calendar[];
  defaultDate?: Date;
  onSave: (data: Partial<CalendarEvent>) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}

function formatDateInput(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

function formatTimeInput(d: Date): string {
  return format(d, "HH:mm");
}

function buildDuration(startDate: Date, endDate: Date): string {
  const diffMs = endDate.getTime() - startDate.getTime();
  const totalMinutes = Math.max(0, Math.floor(diffMs / 60000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  let dur = "P";
  if (days > 0) dur += `${days}D`;
  dur += "T";
  if (hours > 0) dur += `${hours}H`;
  if (minutes > 0) dur += `${minutes}M`;
  if (dur === "PT") dur = "PT0M";
  return dur;
}

type RecurrenceOption = "none" | "daily" | "weekly" | "monthly" | "yearly";
type AlertOption = "none" | "at_time" | "5" | "15" | "30" | "60" | "1440";

export function EventModal({
  event,
  calendars,
  defaultDate,
  onSave,
  onDelete,
  onClose,
}: EventModalProps) {
  const t = useTranslations("calendar");
  const isEdit = !!event;

  const getInitialStart = (): Date => {
    if (event?.start) return parseISO(event.start);
    if (defaultDate) {
      const d = new Date(defaultDate);
      const now = new Date();
      d.setHours(now.getHours() + 1, 0, 0, 0);
      return d;
    }
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    return d;
  };

  const getInitialEnd = (): Date => {
    if (event?.start) {
      const s = parseISO(event.start);
      const dur = parseDuration(event.duration);
      return new Date(s.getTime() + dur * 60000);
    }
    return addHours(getInitialStart(), 1);
  };

  const [title, setTitle] = useState(event?.title || "");
  const [description, setDescription] = useState(event?.description || "");
  const [location, setLocation] = useState(
    event?.locations ? Object.values(event.locations)[0]?.name || "" : ""
  );
  const [startDate, setStartDate] = useState(formatDateInput(getInitialStart()));
  const [startTime, setStartTime] = useState(formatTimeInput(getInitialStart()));
  const [endDate, setEndDate] = useState(formatDateInput(getInitialEnd()));
  const [endTime, setEndTime] = useState(formatTimeInput(getInitialEnd()));
  const [allDay, setAllDay] = useState(event?.showWithoutTime || false);
  const [calendarId, setCalendarId] = useState<string>(() => {
    if (event?.calendarIds) return Object.keys(event.calendarIds)[0] || calendars[0]?.id || "";
    const defaultCal = calendars.find(c => c.isDefault);
    return defaultCal?.id || calendars[0]?.id || "";
  });
  const [recurrence, setRecurrence] = useState<RecurrenceOption>(() => {
    if (!event?.recurrenceRules?.length) return "none";
    return event.recurrenceRules[0].frequency as RecurrenceOption;
  });
  const [alert, setAlert] = useState<AlertOption>(() => {
    if (!event?.alerts) return "none";
    const first = Object.values(event.alerts)[0];
    if (!first) return "none";
    if (first.trigger["@type"] === "OffsetTrigger") {
      const offset = first.trigger.offset;
      if (offset === "PT0S") return "at_time";
      const minMatch = offset.match(/-?PT?(\d+)M$/);
      if (minMatch) return minMatch[1] as AlertOption;
      const hourMatch = offset.match(/-?PT?(\d+)H$/);
      if (hourMatch) return String(parseInt(hourMatch[1]) * 60) as AlertOption;
      const dayMatch = offset.match(/-?P(\d+)D/);
      if (dayMatch) return String(parseInt(dayMatch[1]) * 1440) as AlertOption;
    }
    return "none";
  });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleSave = useCallback(() => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    if (trimmedTitle.length > 500 || description.trim().length > 10000 || location.trim().length > 500) return;

    const startStr = allDay
      ? `${startDate}T00:00:00`
      : `${startDate}T${startTime}:00`;
    const endStr = allDay
      ? `${endDate}T23:59:59`
      : `${endDate}T${endTime}:00`;

    const start = new Date(startStr);
    let end = new Date(endStr);

    if (end <= start) {
      end = new Date(start.getTime() + 3600000);
    }

    const duration = allDay
      ? `P${Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000))}D`
      : buildDuration(start, end);

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const data: Partial<CalendarEvent> = {
      title: trimmedTitle,
      description: description.trim(),
      start: startStr,
      duration,
      timeZone,
      showWithoutTime: allDay,
      calendarIds: { [calendarId]: true },
      status: "confirmed",
      freeBusyStatus: "busy",
      privacy: "public",
    };

    if (location.trim()) {
      data.locations = {
        loc1: {
          "@type": "Location",
          name: location.trim(),
          description: null,
          locationTypes: null,
          coordinates: null,
          timeZone: null,
          links: null,
          relativeTo: null,
        },
      };
    }

    if (recurrence !== "none") {
      data.recurrenceRules = [{
        "@type": "RecurrenceRule",
        frequency: recurrence,
        interval: 1,
        rscale: "gregorian",
        skip: "omit",
        firstDayOfWeek: "mo",
        byDay: null,
        byMonthDay: null,
        byMonth: null,
        byYearDay: null,
        byWeekNo: null,
        byHour: null,
        byMinute: null,
        bySecond: null,
        bySetPosition: null,
        count: null,
        until: null,
      }];
    }

    if (alert !== "none") {
      const offset = alert === "at_time" ? "PT0S" : `-PT${alert}M`;
      data.alerts = {
        alert1: {
          "@type": "Alert",
          trigger: { "@type": "OffsetTrigger", offset, relativeTo: "start" },
          action: "display",
          acknowledged: null,
          relatedTo: null,
        },
      };
    }

    onSave(data);
  }, [title, description, location, startDate, startTime, endDate, endTime, allDay, calendarId, recurrence, alert, onSave]);

  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, handleSave]);

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
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div ref={modalRef} role="dialog" aria-modal="true" aria-label={isEdit ? t("events.edit") : t("events.create")} className="relative bg-background border border-border rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">
            {isEdit ? t("events.edit") : t("events.create")}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted transition-colors" aria-label={t("form.cancel")}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="text-sm font-medium mb-1 block">{t("form.title")}</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("form.title")}
              maxLength={500}
              autoFocus
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">{t("form.description")}</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("form.description")}
              rows={3}
              maxLength={10000}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">{t("form.location")}</label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t("form.location")}
              maxLength={500}
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="allDay"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              className="rounded border-input"
            />
            <label htmlFor="allDay" className="text-sm">{t("form.all_day_event")}</label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium mb-1 block">{t("form.start_date")}</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {!allDay && (
              <div>
                <label className="text-sm font-medium mb-1 block">{t("form.start_time")}</label>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-1 block">{t("form.end_date")}</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {!allDay && (
              <div>
                <label className="text-sm font-medium mb-1 block">{t("form.end_time")}</label>
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            )}
          </div>

          {calendars.length > 1 && (
            <div>
              <label className="text-sm font-medium mb-1 block">{t("form.calendar_select")}</label>
              <select
                value={calendarId}
                onChange={(e) => setCalendarId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {calendars.map((cal) => (
                  <option key={cal.id} value={cal.id}>
                    {cal.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium mb-1 block">{t("recurrence.title")}</label>
              <select
                value={recurrence}
                onChange={(e) => setRecurrence(e.target.value as RecurrenceOption)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="none">{t("recurrence.none")}</option>
                <option value="daily">{t("recurrence.daily")}</option>
                <option value="weekly">{t("recurrence.weekly")}</option>
                <option value="monthly">{t("recurrence.monthly")}</option>
                <option value="yearly">{t("recurrence.yearly")}</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">{t("alerts.title")}</label>
              <select
                value={alert}
                onChange={(e) => setAlert(e.target.value as AlertOption)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="none">{t("alerts.none")}</option>
                <option value="at_time">{t("alerts.at_time")}</option>
                <option value="5">{t("alerts.minutes_before", { count: 5 })}</option>
                <option value="15">{t("alerts.minutes_before", { count: 15 })}</option>
                <option value="30">{t("alerts.minutes_before", { count: 30 })}</option>
                <option value="60">{t("alerts.hours_before", { count: 1 })}</option>
                <option value="1440">{t("alerts.days_before", { count: 1 })}</option>
              </select>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-border">
          {isEdit && onDelete ? (
            showDeleteConfirm ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-red-600 dark:text-red-400">
                  {t("form.delete_confirm")}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { onDelete(event!.id); onClose(); }}
                  className="text-red-600 dark:text-red-400 border-red-300 dark:border-red-700"
                >
                  {t("events.delete")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(false)}>
                  {t("form.cancel")}
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteConfirm(true)}
                className="text-red-600 dark:text-red-400"
              >
                <Trash2 className="w-4 h-4 mr-1" />
                {t("events.delete")}
              </Button>
            )
          ) : (
            <div />
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("form.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={!title.trim()}>
              {t("form.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

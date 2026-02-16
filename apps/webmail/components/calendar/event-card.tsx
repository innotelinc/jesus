"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";
import { format, parseISO } from "date-fns";

interface EventCardProps {
  event: CalendarEvent;
  calendar?: Calendar;
  variant: "chip" | "block";
  onClick?: () => void;
  isSelected?: boolean;
}

function sanitizeColor(color: string | null | undefined, fallback = "#3b82f6"): string {
  if (!color) return fallback;
  if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
  if (/^(rgb|hsl)a?\([\d\s,.%/]+\)$/.test(color)) return color;
  return fallback;
}

function getEventColor(event: CalendarEvent, calendar?: Calendar): string {
  return sanitizeColor(event.color, sanitizeColor(calendar?.color));
}

function parseDuration(duration: string): number {
  let totalMinutes = 0;
  const weekMatch = duration.match(/(\d+)W/);
  const hourMatch = duration.match(/(\d+)H/);
  const minMatch = duration.match(/(\d+)M/);
  const dayMatch = duration.match(/(\d+)D/);
  if (weekMatch) totalMinutes += parseInt(weekMatch[1]) * 7 * 24 * 60;
  if (dayMatch) totalMinutes += parseInt(dayMatch[1]) * 24 * 60;
  if (hourMatch) totalMinutes += parseInt(hourMatch[1]) * 60;
  if (minMatch) totalMinutes += parseInt(minMatch[1]);
  return totalMinutes;
}

export function EventCard({ event, calendar, variant, onClick, isSelected }: EventCardProps) {
  const t = useTranslations("calendar");
  const color = getEventColor(event, calendar);
  const startDate = parseISO(event.start);

  const calendarName = calendar?.name || "";
  const durationMinutes = parseDuration(event.duration);
  const endTime = new Date(startDate.getTime() + durationMinutes * 60000);
  const timeString = `${format(startDate, "HH:mm")} – ${format(endTime, "HH:mm")}`;
  const ariaLabel = `${event.title || t("events.no_title")}, ${timeString}${calendarName ? `, ${calendarName}` : ""}`;

  if (variant === "chip") {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onClick?.(); }}
        aria-label={ariaLabel}
        className={cn(
          "flex items-center gap-1 w-full text-left text-xs px-1 py-0.5 rounded truncate",
          "min-h-[44px] sm:min-h-0",
          "hover:opacity-80 transition-opacity",
          isSelected && "ring-2 ring-primary"
        )}
        style={{ backgroundColor: `${color}20`, color }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="truncate">{event.title || t("events.no_title")}</span>
      </button>
    );
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      aria-label={ariaLabel}
      className={cn(
        "w-full text-left rounded px-1.5 py-0.5 text-xs overflow-hidden",
        "hover:opacity-90 transition-opacity cursor-pointer",
        isSelected && "ring-2 ring-primary"
      )}
      style={{ backgroundColor: `${color}30`, borderLeft: `3px solid ${color}`, color }}
    >
      <div className="font-medium truncate">{event.title || t("events.no_title")}</div>
      {durationMinutes > 30 && (
        <div className="opacity-80 text-[10px]">
          {timeString}
        </div>
      )}
    </button>
  );
}

export { parseDuration, getEventColor, sanitizeColor };

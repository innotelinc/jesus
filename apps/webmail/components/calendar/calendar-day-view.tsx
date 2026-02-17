"use client";

import { useMemo, useEffect, useRef, useState, useCallback, type DragEvent } from "react";
import { useTranslations, useFormatter } from "next-intl";
import { format, isToday, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import { EventCard, parseDuration } from "./event-card";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { toast } from "@/stores/toast-store";

interface CalendarDayViewProps {
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onSelectEvent: (event: CalendarEvent) => void;
  onCreateAtTime: (date: Date) => void;
  timeFormat?: "12h" | "24h";
}

const HOUR_HEIGHT = 64;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function getEventEndDate(event: CalendarEvent): Date {
  const start = new Date(event.start);
  if (!event.duration) return start;
  const days = parseInt(event.duration.match(/(\d+)D/)?.[1] || "0");
  const hours = parseInt(event.duration.match(/(\d+)H/)?.[1] || "0");
  const minutes = parseInt(event.duration.match(/(\d+)M/)?.[1] || "0");
  const weeks = parseInt(event.duration.match(/(\d+)W/)?.[1] || "0");
  const totalMs = ((weeks * 7 + days) * 24 * 60 + hours * 60 + minutes) * 60000;
  return new Date(start.getTime() + totalMs);
}

function layoutOverlappingEvents(events: CalendarEvent[]): { event: CalendarEvent; column: number; totalColumns: number }[] {
  const sorted = [...events].sort((a, b) => {
    const diff = new Date(a.start).getTime() - new Date(b.start).getTime();
    if (diff !== 0) return diff;
    return parseDuration(b.duration) - parseDuration(a.duration);
  });

  const columns: { event: CalendarEvent; end: number }[][] = [];
  const result: { event: CalendarEvent; column: number; totalColumns: number }[] = [];

  for (const event of sorted) {
    const start = parseISO(event.start);
    const startMin = start.getHours() * 60 + start.getMinutes();
    const endMin = startMin + Math.max(15, parseDuration(event.duration));
    let placed = false;
    for (let col = 0; col < columns.length; col++) {
      if (columns[col].every(e => e.end <= startMin)) {
        columns[col].push({ event, end: endMin });
        result.push({ event, column: col, totalColumns: 0 });
        placed = true;
        break;
      }
    }
    if (!placed) {
      columns.push([{ event, end: endMin }]);
      result.push({ event, column: columns.length - 1, totalColumns: 0 });
    }
  }

  const total = columns.length;
  result.forEach(r => r.totalColumns = total);
  return result;
}

export function CalendarDayView({
  selectedDate,
  events,
  calendars,
  onSelectEvent,
  onCreateAtTime,
  timeFormat = "24h",
}: CalendarDayViewProps) {
  const t = useTranslations("calendar");
  const intlFormatter = useFormatter();
  const scrollRef = useRef<HTMLDivElement>(null);

  const calendarMap = useMemo(() => {
    const map = new Map<string, Calendar>();
    calendars.forEach((c) => map.set(c.id, c));
    return map;
  }, [calendars]);

  const { timedEvents, allDayEvents } = useMemo(() => {
    const timed: CalendarEvent[] = [];
    const allDay: CalendarEvent[] = [];
    events.forEach((ev) => {
      try {
        const start = new Date(ev.start);
        const end = getEventEndDate(ev);
        const startDay = new Date(start); startDay.setHours(0, 0, 0, 0);
        const endDay = new Date(end); endDay.setHours(0, 0, 0, 0);
        const selDay = new Date(selectedDate); selDay.setHours(0, 0, 0, 0);

        const spansThisDay = startDay.getTime() <= selDay.getTime() && endDay.getTime() >= selDay.getTime();
        if (!spansThisDay) return;

        if (ev.showWithoutTime) allDay.push(ev);
        else timed.push(ev);
      } catch { /* skip invalid dates */ }
    });
    return { timedEvents: timed, allDayEvents: allDay };
  }, [events, selectedDate]);

  useEffect(() => {
    if (scrollRef.current) {
      const now = new Date();
      scrollRef.current.scrollTop = Math.max(0, (now.getHours() - 1) * HOUR_HEIGHT);
    }
  }, []);

  const today = isToday(selectedDate);
  const [nowMinutes, setNowMinutes] = useState(() => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  });
  useEffect(() => {
    const interval = setInterval(() => {
      setNowMinutes(new Date().getHours() * 60 + new Date().getMinutes());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const formatHour = (h: number): string => {
    if (timeFormat === "12h") {
      const d = new Date(2000, 0, 1, h);
      return intlFormatter.dateTime(d, { hour: "numeric", minute: "2-digit", hour12: true });
    }
    return format(new Date(2000, 0, 1, h), "HH:mm");
  };

  const layouted = useMemo(() => layoutOverlappingEvents(timedEvents), [timedEvents]);

  const [dropMinutes, setDropMinutes] = useState<number | null>(null);

  const snapMinutes = useCallback((e: DragEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const raw = (y / HOUR_HEIGHT) * 60;
    return Math.max(0, Math.min(1425, Math.round(raw / 15) * 15));
  }, []);

  const formatSnapTime = useCallback((minutes: number): string => {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (timeFormat === "12h") {
      return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
    }
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }, [timeFormat]);

  const handleDayDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("application/x-calendar-event")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const minutes = snapMinutes(e);
    setDropMinutes((prev) => prev === minutes ? prev : minutes);
  }, [snapMinutes]);

  const handleDayDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null;
    if (!e.currentTarget.contains(related)) setDropMinutes(null);
  }, []);

  const handleDayDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropMinutes(null);
    const json = e.dataTransfer.getData("application/x-calendar-event");
    if (!json) return;
    try {
      const data = JSON.parse(json);
      const minutes = snapMinutes(e);
      const newStart = new Date(selectedDate);
      newStart.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      const newStartISO = format(newStart, "yyyy-MM-dd'T'HH:mm:ss");
      if (newStartISO === data.originalStart) return;
      const client = useAuthStore.getState().client;
      if (!client) return;
      const event = useCalendarStore.getState().events.find(e => e.id === data.eventId);
      const hasParticipants = event?.participants && Object.keys(event.participants).length > 0;
      await useCalendarStore.getState().updateEvent(client, data.eventId, { start: newStartISO }, hasParticipants || undefined);
    } catch {
      toast.error(t("notifications.event_move_error"));
    }
  }, [snapMinutes, selectedDate, t]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden" role="grid" aria-label={intlFormatter.dateTime(selectedDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}>
      <div className="px-4 py-3 border-b border-border">
        <h3 className={cn("text-lg font-semibold", today && "text-primary")}>
          {intlFormatter.dateTime(selectedDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
        </h3>
      </div>

      {allDayEvents.length > 0 && (
        <div className="px-4 py-2 border-b border-border">
          <div className="text-[10px] text-muted-foreground mb-1">{t("events.all_day")}</div>
          <div className="space-y-1">
            {allDayEvents.map((ev) => {
              const calId = Object.keys(ev.calendarIds)[0];
              return (
                <EventCard
                  key={ev.id}
                  event={ev}
                  calendar={calendarMap.get(calId)}
                  variant="chip"
                  onClick={() => onSelectEvent(ev)}
                />
              );
            })}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="flex relative" style={{ height: 24 * HOUR_HEIGHT }}>
          <div className="w-16 flex-shrink-0">
            {HOURS.map((h) => (
              <div
                key={h}
                className="text-xs text-muted-foreground text-right pr-3"
                style={{ height: HOUR_HEIGHT, lineHeight: `${HOUR_HEIGHT}px` }}
              >
                {formatHour(h)}
              </div>
            ))}
          </div>

          <div
            className="flex-1 relative border-l border-border"
            role="row"
            aria-label={t("views.day")}
            onDragOver={handleDayDragOver}
            onDragLeave={handleDayDragLeave}
            onDrop={handleDayDrop}
          >
            {HOURS.map((h) => (
              <div
                key={h}
                role="gridcell"
                aria-label={formatHour(h)}
                onClick={() => {
                  const d = new Date(selectedDate);
                  d.setHours(h, 0, 0, 0);
                  onCreateAtTime(d);
                }}
                className="border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors"
                style={{ height: HOUR_HEIGHT }}
              />
            ))}

            {layouted.map(({ event: ev, column, totalColumns }) => {
              const start = parseISO(ev.start);
              const startMin = start.getHours() * 60 + start.getMinutes();
              const durMin = Math.max(15, parseDuration(ev.duration));
              const top = (startMin / 60) * HOUR_HEIGHT;
              const height = Math.max(24, (durMin / 60) * HOUR_HEIGHT);
              const calId = Object.keys(ev.calendarIds)[0];
              const leftPct = (column / totalColumns) * 100;
              const widthPct = (1 / totalColumns) * 100;

              return (
                <div
                  key={ev.id}
                  className="absolute z-10"
                  style={{ top, height, left: `${leftPct}%`, width: `${widthPct}%`, paddingLeft: 2, paddingRight: 2 }}
                >
                  <EventCard
                    event={ev}
                    calendar={calendarMap.get(calId)}
                    variant="block"
                    onClick={() => onSelectEvent(ev)}
                    draggable
                  />
                </div>
              );
            })}

            {today && (
              <div
                className="absolute left-0 right-0 z-20 pointer-events-none"
                style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
              >
                <div className="flex items-center">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500 -ml-1" />
                  <div className="flex-1 h-px bg-red-500" />
                </div>
              </div>
            )}

            {dropMinutes !== null && (
              <div
                className="absolute left-0 right-0 z-30 pointer-events-none"
                style={{ top: (dropMinutes / 60) * HOUR_HEIGHT }}
              >
                <div className="flex items-center">
                  <div className="w-2.5 h-2.5 rounded-full bg-primary -ml-1" />
                  <div className="flex-1 h-0.5 bg-primary rounded-full" />
                </div>
                <div className="absolute -top-4 left-2 text-[10px] font-medium text-primary bg-background/90 px-1 rounded shadow-sm">
                  {formatSnapTime(dropMinutes)}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

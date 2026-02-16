"use client";

import { useMemo, useEffect, useRef, useState, useCallback, type DragEvent } from "react";
import { useTranslations, useFormatter } from "next-intl";
import {
  startOfWeek, addDays, format, isSameDay, isToday, parseISO,
} from "date-fns";
import { cn } from "@/lib/utils";
import { EventCard, parseDuration } from "./event-card";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { toast } from "@/stores/toast-store";

interface CalendarWeekViewProps {
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onSelectDate: (date: Date) => void;
  onSelectEvent: (event: CalendarEvent) => void;
  onCreateAtTime: (date: Date) => void;
  firstDayOfWeek?: number;
  timeFormat?: "12h" | "24h";
}

const HOUR_HEIGHT = 60;
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

export function CalendarWeekView({
  selectedDate,
  events,
  calendars,
  onSelectDate,
  onSelectEvent,
  onCreateAtTime,
  firstDayOfWeek = 1,
  timeFormat = "24h",
}: CalendarWeekViewProps) {
  const t = useTranslations("calendar");
  const intlFormatter = useFormatter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const weekStart = (firstDayOfWeek === 0 ? 0 : 1) as 0 | 1;

  const weekDays = useMemo(() => {
    const start = startOfWeek(selectedDate, { weekStartsOn: weekStart });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [selectedDate, weekStart]);

  const calendarMap = useMemo(() => {
    const map = new Map<string, Calendar>();
    calendars.forEach((c) => map.set(c.id, c));
    return map;
  }, [calendars]);

  const { timedEvents, allDayEvents } = useMemo(() => {
    const timed: Map<string, CalendarEvent[]> = new Map();
    const allDay: Map<string, CalendarEvent[]> = new Map();

    events.forEach((ev) => {
      try {
        const start = new Date(ev.start);
        const end = getEventEndDate(ev);
        const startDay = new Date(start); startDay.setHours(0, 0, 0, 0);
        const endDay = new Date(end); endDay.setHours(0, 0, 0, 0);

        const cursor = new Date(startDay);
        while (cursor <= endDay) {
          const key = format(cursor, "yyyy-MM-dd");
          if (ev.showWithoutTime) {
            const arr = allDay.get(key) || [];
            arr.push(ev);
            allDay.set(key, arr);
          } else {
            const arr = timed.get(key) || [];
            arr.push(ev);
            timed.set(key, arr);
          }
          cursor.setDate(cursor.getDate() + 1);
        }
      } catch { /* skip invalid dates */ }
    });
    return { timedEvents: timed, allDayEvents: allDay };
  }, [events]);

  const hasAllDay = useMemo(() => {
    return weekDays.some(day => {
      const key = format(day, "yyyy-MM-dd");
      return (allDayEvents.get(key) || []).length > 0;
    });
  }, [weekDays, allDayEvents]);

  useEffect(() => {
    if (scrollRef.current) {
      const now = new Date();
      const scrollTo = Math.max(0, (now.getHours() - 1) * HOUR_HEIGHT);
      scrollRef.current.scrollTop = scrollTo;
    }
  }, []);

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

  const handleSlotClick = (day: Date, hour: number) => {
    const d = new Date(day);
    d.setHours(hour, 0, 0, 0);
    onCreateAtTime(d);
  };

  const formatHour = (h: number): string => {
    if (timeFormat === "12h") {
      const d = new Date(2000, 0, 1, h);
      return intlFormatter.dateTime(d, { hour: "numeric", minute: "2-digit", hour12: true });
    }
    return format(new Date(2000, 0, 1, h), "HH:mm");
  };

  const [dropTarget, setDropTarget] = useState<{ dayKey: string; minutes: number } | null>(null);

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

  const handleColumnDragOver = useCallback((e: DragEvent<HTMLDivElement>, dayKey: string) => {
    if (!e.dataTransfer.types.includes("application/x-calendar-event")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const minutes = snapMinutes(e);
    setDropTarget((prev) =>
      prev?.dayKey === dayKey && prev?.minutes === minutes ? prev : { dayKey, minutes }
    );
  }, [snapMinutes]);

  const handleColumnDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null;
    if (!e.currentTarget.contains(related)) setDropTarget(null);
  }, []);

  const handleColumnDrop = useCallback(async (e: DragEvent<HTMLDivElement>, day: Date) => {
    e.preventDefault();
    setDropTarget(null);
    const json = e.dataTransfer.getData("application/x-calendar-event");
    if (!json) return;
    try {
      const data = JSON.parse(json);
      const minutes = snapMinutes(e);
      const newStart = new Date(day);
      newStart.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      const newStartISO = format(newStart, "yyyy-MM-dd'T'HH:mm:ss");
      if (newStartISO === data.originalStart) return;
      const client = useAuthStore.getState().client;
      if (!client) return;
      await useCalendarStore.getState().updateEvent(client, data.eventId, { start: newStartISO });
    } catch {
      toast.error(t("notifications.event_move_error"));
    }
  }, [snapMinutes, t]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden" role="grid" aria-label={t("views.week")}>
      {hasAllDay && (
        <div className="flex border-b border-border">
          <div className="w-14 flex-shrink-0 text-[10px] text-muted-foreground p-1 text-right">
            {t("events.all_day")}
          </div>
          <div className="flex-1 grid grid-cols-7 gap-px bg-border">
            {weekDays.map((day) => {
              const key = format(day, "yyyy-MM-dd");
              const dayAllDay = allDayEvents.get(key) || [];
              return (
                <div key={key} className="bg-background p-0.5 min-h-[28px]">
                  {dayAllDay.map((ev) => {
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
              );
            })}
          </div>
        </div>
      )}

      <div className="flex border-b border-border" role="row">
        <div className="w-14 flex-shrink-0" />
        <div className="flex-1 grid grid-cols-7 border-l border-border">
          {weekDays.map((day) => {
            const todayCol = isToday(day);
            const selected = isSameDay(day, selectedDate);
            const fullLabel = intlFormatter.dateTime(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
            return (
              <button
                key={day.toISOString()}
                onClick={() => onSelectDate(day)}
                role="columnheader"
                aria-label={fullLabel}
                className={cn(
                  "text-center py-2 text-sm border-r border-border last:border-r-0 transition-colors",
                  "hover:bg-muted/50",
                  todayCol && "font-bold",
                )}
              >
                <div className="text-[10px] text-muted-foreground uppercase">
                  {intlFormatter.dateTime(day, { weekday: "short" })}
                </div>
                <div className={cn(
                  "inline-flex items-center justify-center w-7 h-7 rounded-full text-sm",
                  todayCol && "bg-primary text-primary-foreground",
                  selected && !todayCol && "bg-accent text-accent-foreground"
                )}>
                  {format(day, "d")}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="flex relative" style={{ height: 24 * HOUR_HEIGHT }}>
          <div className="w-14 flex-shrink-0">
            {HOURS.map((h) => (
              <div
                key={h}
                className="text-[10px] text-muted-foreground text-right pr-2"
                style={{ height: HOUR_HEIGHT, lineHeight: `${HOUR_HEIGHT}px` }}
              >
                {formatHour(h)}
              </div>
            ))}
          </div>

          <div className="flex-1 grid grid-cols-7 border-l border-border relative">
            {weekDays.map((day) => {
              const key = format(day, "yyyy-MM-dd");
              const dayEvents = timedEvents.get(key) || [];
              const todayCol = isToday(day);
              const layouted = layoutOverlappingEvents(dayEvents);

              return (
                <div
                  key={key}
                  className="relative border-r border-border last:border-r-0"
                  role="row"
                  aria-label={intlFormatter.dateTime(day, { weekday: "long", month: "long", day: "numeric" })}
                  onDragOver={(e) => handleColumnDragOver(e, key)}
                  onDragLeave={handleColumnDragLeave}
                  onDrop={(e) => handleColumnDrop(e, day)}
                >
                  {HOURS.map((h) => (
                    <div
                      key={h}
                      role="gridcell"
                      aria-label={`${intlFormatter.dateTime(day, { weekday: "short" })} ${formatHour(h)}`}
                      onClick={() => handleSlotClick(day, h)}
                      className="border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors"
                      style={{ height: HOUR_HEIGHT }}
                    />
                  ))}

                  {layouted.map(({ event: ev, column, totalColumns }) => {
                    const start = parseISO(ev.start);
                    const startMin = start.getHours() * 60 + start.getMinutes();
                    const durMin = Math.max(15, parseDuration(ev.duration));
                    const top = (startMin / 60) * HOUR_HEIGHT;
                    const height = Math.max(20, (durMin / 60) * HOUR_HEIGHT);
                    const calId = Object.keys(ev.calendarIds)[0];
                    const leftPct = (column / totalColumns) * 100;
                    const widthPct = (1 / totalColumns) * 100;

                    return (
                      <div
                        key={ev.id}
                        className="absolute z-10"
                        style={{ top, height, left: `${leftPct}%`, width: `${widthPct}%`, paddingLeft: 1, paddingRight: 1 }}
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

                  {todayCol && (
                    <div
                      className="absolute left-0 right-0 z-20 pointer-events-none"
                      style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                    >
                      <div className="flex items-center">
                        <div className="w-2 h-2 rounded-full bg-red-500 -ml-1" />
                        <div className="flex-1 h-px bg-red-500" />
                      </div>
                    </div>
                  )}

                  {dropTarget?.dayKey === key && (
                    <div
                      className="absolute left-0 right-0 z-30 pointer-events-none"
                      style={{ top: (dropTarget.minutes / 60) * HOUR_HEIGHT }}
                    >
                      <div className="flex items-center">
                        <div className="w-2 h-2 rounded-full bg-primary -ml-1" />
                        <div className="flex-1 h-0.5 bg-primary rounded-full" />
                      </div>
                      <div className="absolute -top-4 left-2 text-[10px] font-medium text-primary bg-background/90 px-1 rounded shadow-sm">
                        {formatSnapTime(dropTarget.minutes)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

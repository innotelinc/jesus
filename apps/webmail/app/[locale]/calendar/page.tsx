"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  addMonths, subMonths, addWeeks, subWeeks, addDays, subDays,
  format,
} from "date-fns";
import { useCalendarStore } from "@/stores/calendar-store";
import { useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useIdentityStore } from "@/stores/identity-store";
import { toast } from "@/stores/toast-store";
import { useIsMobile } from "@/hooks/use-media-query";
import { CalendarToolbar } from "@/components/calendar/calendar-toolbar";
import { CalendarMonthView } from "@/components/calendar/calendar-month-view";
import { CalendarWeekView } from "@/components/calendar/calendar-week-view";
import { CalendarDayView } from "@/components/calendar/calendar-day-view";
import { CalendarAgendaView } from "@/components/calendar/calendar-agenda-view";
import { MiniCalendar } from "@/components/calendar/mini-calendar";
import { CalendarSidebarPanel } from "@/components/calendar/calendar-sidebar-panel";
import { EventModal } from "@/components/calendar/event-modal";
import { ICalImportModal } from "@/components/calendar/ical-import-modal";
import type { CalendarEvent, CalendarParticipant } from "@/lib/jmap/types";

export default function CalendarPage() {
  const router = useRouter();
  const t = useTranslations("calendar");
  const isMobile = useIsMobile();
  const { client, isAuthenticated } = useAuthStore();
  const {
    calendars, events, selectedDate, viewMode, selectedCalendarIds,
    isLoading, isLoadingEvents, supportsCalendar, error,
    fetchCalendars, fetchEvents, createEvent, updateEvent, deleteEvent, rsvpEvent,
    setSelectedDate, setViewMode, toggleCalendarVisibility,
  } = useCalendarStore();
  const { firstDayOfWeek, timeFormat } = useSettingsStore();
  const { identities } = useIdentityStore();

  const currentUserEmails = useMemo(() =>
    identities.map(id => id.email).filter(Boolean),
    [identities]
  );

  const [showEventModal, setShowEventModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [editEvent, setEditEvent] = useState<CalendarEvent | null>(null);
  const [defaultModalDate, setDefaultModalDate] = useState<Date | undefined>();
  const [miniMonth, setMiniMonth] = useState(new Date());
  const hasFetched = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) {
      router.push("/login");
    } else if (!supportsCalendar) {
      router.push("/");
    }
  }, [isAuthenticated, supportsCalendar, router]);

  useEffect(() => {
    if (error) {
      toast.error(error);
    }
  }, [error]);

  useEffect(() => {
    if (client && !hasFetched.current) {
      hasFetched.current = true;
      fetchCalendars(client);
    }
  }, [client, fetchCalendars]);

  const dateRange = useMemo(() => {
    const d = selectedDate;
    switch (viewMode) {
      case "month": {
        const ms = startOfMonth(d);
        const me = endOfMonth(d);
        return {
          start: format(startOfWeek(ms, { weekStartsOn: firstDayOfWeek }), "yyyy-MM-dd'T'00:00:00"),
          end: format(endOfWeek(me, { weekStartsOn: firstDayOfWeek }), "yyyy-MM-dd'T'23:59:59"),
        };
      }
      case "week": {
        const ws = startOfWeek(d, { weekStartsOn: firstDayOfWeek });
        return {
          start: format(ws, "yyyy-MM-dd'T'00:00:00"),
          end: format(addDays(ws, 6), "yyyy-MM-dd'T'23:59:59"),
        };
      }
      case "day":
        return {
          start: format(d, "yyyy-MM-dd'T'00:00:00"),
          end: format(d, "yyyy-MM-dd'T'23:59:59"),
        };
      case "agenda":
        return {
          start: format(d, "yyyy-MM-dd'T'00:00:00"),
          end: format(addDays(d, 30), "yyyy-MM-dd'T'23:59:59"),
        };
    }
  }, [selectedDate, viewMode, firstDayOfWeek]);

  useEffect(() => {
    if (client && calendars.length > 0) {
      fetchEvents(client, dateRange.start, dateRange.end);
    }
  }, [client, calendars.length, dateRange, fetchEvents]);

  const navigatePrev = useCallback(() => {
    let next: Date;
    switch (viewMode) {
      case "month": next = subMonths(selectedDate, 1); break;
      case "week": next = subWeeks(selectedDate, 1); break;
      case "day": next = subDays(selectedDate, 1); break;
      case "agenda": next = subMonths(selectedDate, 1); break;
    }
    setSelectedDate(next);
    setMiniMonth(next);
  }, [viewMode, selectedDate, setSelectedDate]);

  const navigateNext = useCallback(() => {
    let next: Date;
    switch (viewMode) {
      case "month": next = addMonths(selectedDate, 1); break;
      case "week": next = addWeeks(selectedDate, 1); break;
      case "day": next = addDays(selectedDate, 1); break;
      case "agenda": next = addMonths(selectedDate, 1); break;
    }
    setSelectedDate(next);
    setMiniMonth(next);
  }, [viewMode, selectedDate, setSelectedDate]);

  const goToToday = useCallback(() => {
    setSelectedDate(new Date());
    setMiniMonth(new Date());
  }, [setSelectedDate]);

  const handleSelectDate = useCallback((date: Date) => {
    setSelectedDate(date);
    setMiniMonth(date);
  }, [setSelectedDate]);

  const handleMiniMonthChange = useCallback((date: Date) => {
    setMiniMonth(date);
    setSelectedDate(date);
  }, [setSelectedDate]);

  const openCreateModal = useCallback((date?: Date) => {
    setEditEvent(null);
    setDefaultModalDate(date || selectedDate);
    setShowEventModal(true);
  }, [selectedDate]);

  const openEditModal = useCallback((event: CalendarEvent) => {
    setEditEvent(event);
    setDefaultModalDate(undefined);
    setShowEventModal(true);
  }, []);

  const handleSaveEvent = useCallback(async (data: Partial<CalendarEvent>, sendSchedulingMessages?: boolean) => {
    if (!client) return;
    try {
      if (editEvent) {
        await updateEvent(client, editEvent.id, data, sendSchedulingMessages);
        toast.success(t("notifications.event_updated"));
      } else {
        const created = await createEvent(client, data, sendSchedulingMessages);
        if (!created) {
          toast.error(t("notifications.event_error"));
          return;
        }
        if (sendSchedulingMessages) {
          toast.success(t("notifications.invitation_sent"));
        } else {
          toast.success(t("notifications.event_created"));
        }
      }
      setShowEventModal(false);
      setEditEvent(null);
    } catch {
      toast.error(t("notifications.event_error"));
    }
  }, [client, editEvent, createEvent, updateEvent, t]);

  const handleDeleteEvent = useCallback(async (id: string, sendSchedulingMessages?: boolean) => {
    if (!client) return;
    try {
      await deleteEvent(client, id, sendSchedulingMessages);
      toast.success(t("notifications.event_deleted"));
    } catch {
      toast.error(t("notifications.event_error"));
    }
  }, [client, deleteEvent, t]);

  const handleRsvp = useCallback(async (eventId: string, participantId: string, status: CalendarParticipant['participationStatus']) => {
    if (!client) return;
    try {
      await rsvpEvent(client, eventId, participantId, status);
      toast.success(t("notifications.rsvp_updated"));
    } catch {
      toast.error(t("notifications.rsvp_error"));
    }
  }, [client, rsvpEvent, t]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
      if (showEventModal) return;

      switch (e.key) {
        case "ArrowLeft": e.preventDefault(); navigatePrev(); break;
        case "ArrowRight": e.preventDefault(); navigateNext(); break;
        case "t": goToToday(); break;
        case "m": setViewMode("month"); break;
        case "w": setViewMode("week"); break;
        case "d": setViewMode("day"); break;
        case "a": setViewMode("agenda"); break;
        case "n": openCreateModal(); break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [navigatePrev, navigateNext, goToToday, setViewMode, openCreateModal, showEventModal]);

  const visibleEvents = useMemo(() =>
    events.filter((e) => {
      const calIds = Object.keys(e.calendarIds);
      return calIds.some((id) => selectedCalendarIds.includes(id));
    }),
    [events, selectedCalendarIds]
  );

  if (!isAuthenticated || !supportsCalendar) return null;

  const renderView = () => {
    if (isLoading && calendars.length === 0) {
      return (
        <div className="flex items-center justify-center flex-1 text-muted-foreground">
          <p className="text-sm">{t("status.loading_calendars")}</p>
        </div>
      );
    }

    const viewContent = (() => {
      switch (viewMode) {
        case "month":
          return (
            <CalendarMonthView
              selectedDate={selectedDate}
              events={visibleEvents}
              calendars={calendars}
              onSelectDate={handleSelectDate}
              onSelectEvent={openEditModal}
              firstDayOfWeek={firstDayOfWeek}
            />
          );
        case "week":
          return (
            <CalendarWeekView
              selectedDate={selectedDate}
              events={visibleEvents}
              calendars={calendars}
              onSelectDate={handleSelectDate}
              onSelectEvent={openEditModal}
              onCreateAtTime={openCreateModal}
              firstDayOfWeek={firstDayOfWeek}
              timeFormat={timeFormat}
            />
          );
        case "day":
          return (
            <CalendarDayView
              selectedDate={selectedDate}
              events={visibleEvents}
              calendars={calendars}
              onSelectEvent={openEditModal}
              onCreateAtTime={openCreateModal}
              timeFormat={timeFormat}
            />
          );
        case "agenda":
          return (
            <CalendarAgendaView
              selectedDate={selectedDate}
              events={visibleEvents}
              calendars={calendars}
              onSelectEvent={openEditModal}
              timeFormat={timeFormat}
            />
          );
      }
    })();

    return (
      <div className="relative flex-1 flex flex-col overflow-hidden">
        {viewContent}
        {isLoadingEvents && calendars.length > 0 && (
          <div className="absolute inset-0 bg-background/50 flex items-center justify-center pointer-events-none">
            <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-screen bg-background">
      <CalendarToolbar
        selectedDate={selectedDate}
        viewMode={viewMode}
        onNavigateBack={() => router.push("/")}
        onPrev={navigatePrev}
        onNext={navigateNext}
        onToday={goToToday}
        onViewModeChange={setViewMode}
        onCreateEvent={() => openCreateModal()}
        onImport={() => setShowImportModal(true)}
        isMobile={isMobile}
      />

      <div className="flex flex-1 overflow-hidden">
        {!isMobile && (
          <div className="w-60 border-r border-border p-3 overflow-y-auto flex-shrink-0">
            <MiniCalendar
              selectedDate={selectedDate}
              displayMonth={miniMonth}
              onSelectDate={handleSelectDate}
              onChangeMonth={handleMiniMonthChange}
              events={events}
              firstDayOfWeek={firstDayOfWeek}
            />
            <CalendarSidebarPanel
              calendars={calendars}
              selectedCalendarIds={selectedCalendarIds}
              onToggleVisibility={toggleCalendarVisibility}
            />
          </div>
        )}

        {renderView()}
      </div>

      {showEventModal && (
        <EventModal
          event={editEvent}
          calendars={calendars}
          defaultDate={defaultModalDate}
          onSave={handleSaveEvent}
          onDelete={handleDeleteEvent}
          onRsvp={handleRsvp}
          onClose={() => { setShowEventModal(false); setEditEvent(null); }}
          currentUserEmails={currentUserEmails}
        />
      )}

      {showImportModal && client && (
        <ICalImportModal
          calendars={calendars}
          client={client}
          onClose={() => setShowImportModal(false)}
        />
      )}
    </div>
  );
}

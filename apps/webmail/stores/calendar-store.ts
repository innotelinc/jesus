import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { JMAPClient } from '@/lib/jmap/client';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { debug } from '@/lib/debug';

export type CalendarViewMode = 'month' | 'week' | 'day' | 'agenda';

interface CalendarStore {
  calendars: Calendar[];
  events: CalendarEvent[];
  selectedDate: Date;
  viewMode: CalendarViewMode;
  selectedCalendarIds: string[];
  selectedEventId: string | null;
  isLoading: boolean;
  isLoadingEvents: boolean;
  supportsCalendar: boolean;
  error: string | null;
  dateRange: { start: string; end: string } | null;

  setSupported: (supported: boolean) => void;
  fetchCalendars: (client: JMAPClient) => Promise<void>;
  fetchEvents: (client: JMAPClient, start: string, end: string) => Promise<void>;
  createEvent: (client: JMAPClient, event: Partial<CalendarEvent>) => Promise<CalendarEvent | null>;
  updateEvent: (client: JMAPClient, id: string, updates: Partial<CalendarEvent>) => Promise<void>;
  deleteEvent: (client: JMAPClient, id: string) => Promise<void>;
  setSelectedDate: (date: Date) => void;
  setViewMode: (mode: CalendarViewMode) => void;
  toggleCalendarVisibility: (calendarId: string) => void;
  setSelectedEventId: (id: string | null) => void;
  clearState: () => void;
}

const initialState = {
  calendars: [],
  events: [],
  selectedDate: new Date(),
  selectedCalendarIds: [] as string[],
  selectedEventId: null as string | null,
  isLoading: false,
  isLoadingEvents: false,
  supportsCalendar: false,
  error: null as string | null,
  dateRange: null as { start: string; end: string } | null,
};

export const useCalendarStore = create<CalendarStore>()(
  persist(
    (set, get) => ({
      ...initialState,
      viewMode: 'month' as CalendarViewMode,

      setSupported: (supported) => set({ supportsCalendar: supported }),

      fetchCalendars: async (client) => {
        set({ isLoading: true, error: null });
        try {
          const calendars = await client.getCalendars();
          const { selectedCalendarIds } = get();
          set({
            calendars,
            isLoading: false,
            selectedCalendarIds: selectedCalendarIds.length === 0
              ? calendars.map(c => c.id)
              : selectedCalendarIds,
          });
        } catch (error) {
          debug.error('Failed to fetch calendars:', error);
          set({ error: 'Failed to load calendars', isLoading: false });
        }
      },

      fetchEvents: async (client, start, end) => {
        set({ isLoadingEvents: true, error: null });
        try {
          const { selectedCalendarIds } = get();
          const events = await client.queryCalendarEvents({
            after: start,
            before: end,
            inCalendars: selectedCalendarIds.length > 0 ? selectedCalendarIds : undefined,
          });
          set({ events, isLoadingEvents: false, dateRange: { start, end } });
        } catch (error) {
          debug.error('Failed to fetch events:', error);
          set({ error: 'Failed to load events', isLoadingEvents: false });
        }
      },

      createEvent: async (client, event) => {
        set({ error: null });
        try {
          const created = await client.createCalendarEvent(event);
          set((state) => ({ events: [...state.events, created] }));
          return created;
        } catch (error) {
          debug.error('Failed to create event:', error);
          set({ error: 'Failed to create event' });
          return null;
        }
      },

      updateEvent: async (client, id, updates) => {
        set({ error: null });
        try {
          await client.updateCalendarEvent(id, updates);
          set((state) => ({
            events: state.events.map(e => e.id === id ? { ...e, ...updates } : e),
          }));
        } catch (error) {
          debug.error('Failed to update event:', error);
          set({ error: 'Failed to update event' });
          throw error;
        }
      },

      deleteEvent: async (client, id) => {
        set({ error: null });
        try {
          await client.deleteCalendarEvent(id);
          set((state) => ({
            events: state.events.filter(e => e.id !== id),
            selectedEventId: state.selectedEventId === id ? null : state.selectedEventId,
          }));
        } catch (error) {
          debug.error('Failed to delete event:', error);
          set({ error: 'Failed to delete event' });
          throw error;
        }
      },

      setSelectedDate: (date) => set({ selectedDate: date }),
      setViewMode: (mode) => set({ viewMode: mode }),

      toggleCalendarVisibility: (calendarId) => set((state) => {
        const ids = state.selectedCalendarIds;
        return {
          selectedCalendarIds: ids.includes(calendarId)
            ? ids.filter(id => id !== calendarId)
            : [...ids, calendarId],
        };
      }),

      setSelectedEventId: (id) => set({ selectedEventId: id }),

      clearState: () => set({
        ...initialState,
        selectedDate: new Date(),
      }),
    }),
    {
      name: 'calendar-storage',
      partialize: (state) => ({
        selectedCalendarIds: state.selectedCalendarIds,
        viewMode: state.viewMode,
      }),
    }
  )
);

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { JMAPClient } from '@/lib/jmap/client';
import { useEmailStore } from './email-store';
import { useIdentityStore } from './identity-store';
import { useContactStore } from './contact-store';
import { useVacationStore } from './vacation-store';
import { useCalendarStore } from './calendar-store';
import { useFilterStore } from './filter-store';
import { debug } from '@/lib/debug';
import type { Identity } from '@/lib/jmap/types';

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  serverUrl: string | null;
  username: string | null;
  client: JMAPClient | null;
  identities: Identity[];
  primaryIdentity: Identity | null;

  login: (serverUrl: string, username: string, password: string, totp?: string) => Promise<boolean>;
  logout: () => void;
  checkAuth: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      isAuthenticated: false,
      isLoading: false,
      error: null,
      serverUrl: null,
      username: null,
      client: null,
      identities: [],
      primaryIdentity: null,

      login: async (serverUrl, username, password, totp) => {
        const effectivePassword = totp ? `${password}$${totp}` : password;
        set({ isLoading: true, error: null });

        try {
          const client = new JMAPClient(serverUrl, username, effectivePassword);
          await client.connect();

          const identities = await client.getIdentities();
          const primaryIdentity = identities.length > 0 ? identities[0] : null;
          useIdentityStore.getState().setIdentities(identities);

          // Fetch contacts if server supports JMAP Contacts
          if (client.supportsContacts()) {
            const contactStore = useContactStore.getState();
            contactStore.setSupportsSync(true);
            contactStore.fetchAddressBooks(client).catch((err) => console.error('Failed to fetch address books:', err));
            contactStore.fetchContacts(client).catch((err) => console.error('Failed to fetch contacts:', err));
          } else {
            useContactStore.getState().setSupportsSync(false);
          }

          const vacationStore = useVacationStore.getState();
          if (client.supportsVacationResponse()) {
            vacationStore.setSupported(true);
            vacationStore.fetchVacationResponse(client).catch((err) => console.error('Failed to fetch vacation response:', err));
          } else {
            vacationStore.setSupported(false);
          }

          if (client.supportsCalendars()) {
            const calendarStore = useCalendarStore.getState();
            calendarStore.setSupported(true);
            calendarStore.fetchCalendars(client).catch((err) => console.error('Failed to fetch calendars:', err));
          }

          if (client.supportsSieve()) {
            const filterStore = useFilterStore.getState();
            filterStore.setSupported(true);
            filterStore.fetchFilters(client).catch((err) => debug.error('Failed to fetch filters:', err));
          }

          // Success - save state (but NOT the password)
          set({
            isAuthenticated: true,
            isLoading: false,
            serverUrl,
            username,
            client,
            identities,
            primaryIdentity,
            error: null,
          });

          return true;
        } catch (error) {
          debug.error('Login error:', error);
          let errorKey = 'generic';

          if (error instanceof Error) {
            if (error.message.includes('Invalid username or password') ||
                error.message.includes('401') ||
                error.message.includes('Unauthorized')) {
              errorKey = 'invalid_credentials';
            } else if (error.message.includes('network') ||
                       error.message.includes('Failed to fetch') ||
                       error.message.includes('NetworkError') ||
                       error.message.includes('ECONNREFUSED')) {
              errorKey = 'connection_failed';
            } else if (error.message.includes('500') ||
                       error.message.includes('502') ||
                       error.message.includes('503') ||
                       error.message.includes('504') ||
                       error.message.includes('Internal Server Error') ||
                       error.message.includes('Service Unavailable')) {
              errorKey = 'server_error';
            }
          }

          set({
            isLoading: false,
            error: errorKey,
            isAuthenticated: false,
            client: null,
          });
          return false;
        }
      },

      logout: () => {
        const state = get();

        if (state.client) {
          state.client.disconnect();
        }

        set({
          isAuthenticated: false,
          serverUrl: null,
          username: null,
          client: null,
          identities: [],
          primaryIdentity: null,
          error: null,
        });

        localStorage.removeItem('auth-storage');

        useEmailStore.setState({
          emails: [],
          mailboxes: [],
          selectedEmail: null,
          selectedMailbox: "",
          isLoading: false,
          error: null,
          searchQuery: "",
          quota: null,
        });

        useIdentityStore.getState().clearIdentities();
        useContactStore.getState().clearContacts();
        useVacationStore.getState().clearState();
        useCalendarStore.getState().clearState();
        useFilterStore.getState().clearState();
      },

      checkAuth: async () => {
        const state = get();

        if (state.isAuthenticated && !state.client) {
          try {
            sessionStorage.setItem('session_expired', 'true');
          } catch { /* sessionStorage unavailable */ }

          set({
            isAuthenticated: false,
            isLoading: false,
            client: null,
            serverUrl: null,
            username: null,
          });
        }

        set({ isLoading: false });
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        // Only persist non-sensitive data
        serverUrl: state.serverUrl,
        username: state.username,
        // Don't persist isAuthenticated since we can't restore the session without a password
      }),
    }
  )
);
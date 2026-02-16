import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ContactCard, AddressBook, ContactName } from '@/lib/jmap/types';
import type { JMAPClient } from '@/lib/jmap/client';

function getContactDisplayName(contact: ContactCard): string {
  if (contact.name?.components) {
    const given = contact.name.components.find(c => c.kind === 'given')?.value || '';
    const surname = contact.name.components.find(c => c.kind === 'surname')?.value || '';
    const full = [given, surname].filter(Boolean).join(' ');
    if (full) return full;
  }
  if (contact.nicknames) {
    const nick = Object.values(contact.nicknames)[0];
    if (nick?.name) return nick.name;
  }
  if (contact.emails) {
    const email = Object.values(contact.emails)[0];
    if (email?.address) return email.address;
  }
  return '';
}

function getContactPrimaryEmail(contact: ContactCard): string {
  if (!contact.emails) return '';
  return Object.values(contact.emails)[0]?.address || '';
}

interface ContactStore {
  contacts: ContactCard[];
  addressBooks: AddressBook[];
  selectedContactId: string | null;
  searchQuery: string;
  isLoading: boolean;
  error: string | null;
  supportsSync: boolean;

  fetchContacts: (client: JMAPClient) => Promise<void>;
  fetchAddressBooks: (client: JMAPClient) => Promise<void>;
  createContact: (client: JMAPClient, contact: Partial<ContactCard>) => Promise<void>;
  updateContact: (client: JMAPClient, id: string, updates: Partial<ContactCard>) => Promise<void>;
  deleteContact: (client: JMAPClient, id: string) => Promise<void>;

  addLocalContact: (contact: ContactCard) => void;
  updateLocalContact: (id: string, updates: Partial<ContactCard>) => void;
  deleteLocalContact: (id: string) => void;

  setSelectedContact: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  setSupportsSync: (supports: boolean) => void;
  clearContacts: () => void;

  getAutocomplete: (query: string) => Array<{ name: string; email: string }>;
}

export const useContactStore = create<ContactStore>()(
  persist(
    (set, get) => ({
      contacts: [],
      addressBooks: [],
      selectedContactId: null,
      searchQuery: '',
      isLoading: false,
      error: null,
      supportsSync: false,

      fetchContacts: async (client) => {
        set({ isLoading: true, error: null });
        try {
          const contacts = await client.getContacts();
          set({ contacts, isLoading: false });
        } catch (error) {
          console.error('Failed to fetch contacts:', error);
          set({ error: 'Failed to fetch contacts', isLoading: false });
        }
      },

      fetchAddressBooks: async (client) => {
        try {
          const addressBooks = await client.getAddressBooks();
          set({ addressBooks });
        } catch (error) {
          console.error('Failed to fetch address books:', error);
        }
      },

      createContact: async (client, contact) => {
        set({ isLoading: true, error: null });
        try {
          const created = await client.createContact(contact);
          set((state) => ({
            contacts: [...state.contacts, created],
            isLoading: false,
          }));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to create contact';
          set({ error: msg, isLoading: false });
          throw error;
        }
      },

      updateContact: async (client, id, updates) => {
        set({ error: null });
        try {
          await client.updateContact(id, updates);
          set((state) => ({
            contacts: state.contacts.map(c =>
              c.id === id ? { ...c, ...updates } : c
            ),
          }));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to update contact';
          set({ error: msg });
          throw error;
        }
      },

      deleteContact: async (client, id) => {
        set({ error: null });
        try {
          await client.deleteContact(id);
          set((state) => ({
            contacts: state.contacts.filter(c => c.id !== id),
            selectedContactId: state.selectedContactId === id ? null : state.selectedContactId,
          }));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to delete contact';
          set({ error: msg });
          throw error;
        }
      },

      addLocalContact: (contact) => set((state) => ({
        contacts: [...state.contacts, contact],
      })),

      updateLocalContact: (id, updates) => set((state) => ({
        contacts: state.contacts.map(c =>
          c.id === id ? { ...c, ...updates } : c
        ),
      })),

      deleteLocalContact: (id) => set((state) => ({
        contacts: state.contacts.filter(c => c.id !== id),
        selectedContactId: state.selectedContactId === id ? null : state.selectedContactId,
      })),

      setSelectedContact: (id) => set({ selectedContactId: id }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setSupportsSync: (supports) => set({ supportsSync: supports }),

      clearContacts: () => set({
        contacts: [],
        addressBooks: [],
        selectedContactId: null,
        searchQuery: '',
        error: null,
      }),

      getAutocomplete: (query) => {
        const { contacts } = get();
        if (!query || query.length < 1) return [];

        const lower = query.toLowerCase();
        const results: Array<{ name: string; email: string }> = [];

        for (const contact of contacts) {
          const name = getContactDisplayName(contact);
          const emails = contact.emails ? Object.values(contact.emails) : [];

          for (const emailEntry of emails) {
            if (!emailEntry.address) continue;
            if (
              name.toLowerCase().includes(lower) ||
              emailEntry.address.toLowerCase().includes(lower)
            ) {
              results.push({ name, email: emailEntry.address });
            }
          }

          if (results.length >= 10) break;
        }

        return results;
      },
    }),
    {
      name: 'contact-storage',
      partialize: (state) => ({
        contacts: state.supportsSync ? [] : state.contacts,
        supportsSync: state.supportsSync,
      }),
    }
  )
);

export { getContactDisplayName, getContactPrimaryEmail };
export type { ContactName };

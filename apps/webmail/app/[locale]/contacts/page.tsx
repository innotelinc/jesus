"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContactList } from "@/components/contacts/contact-list";
import { ContactDetail } from "@/components/contacts/contact-detail";
import { ContactForm } from "@/components/contacts/contact-form";
import { useContactStore } from "@/stores/contact-store";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "@/stores/toast-store";
import type { ContactCard } from "@/lib/jmap/types";

type View = "list" | "detail" | "create" | "edit";

export default function ContactsPage() {
  const router = useRouter();
  const t = useTranslations("contacts");
  const { client, isAuthenticated } = useAuthStore();
  const {
    contacts,
    selectedContactId,
    searchQuery,
    supportsSync,
    setSelectedContact,
    setSearchQuery,
    fetchContacts,
    createContact,
    updateContact,
    deleteContact,
    addLocalContact,
    updateLocalContact,
    deleteLocalContact,
  } = useContactStore();

  const [view, setView] = useState<View>("list");
  const hasFetched = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) {
      router.push("/login");
    }
  }, [isAuthenticated, router]);

  useEffect(() => {
    if (client && supportsSync && !hasFetched.current) {
      hasFetched.current = true;
      fetchContacts(client);
    }
  }, [client, supportsSync, fetchContacts]);

  const selectedContact = contacts.find((c) => c.id === selectedContactId) || null;

  const handleSelectContact = (id: string) => {
    setSelectedContact(id);
    setView("detail");
  };

  const handleCreateNew = () => {
    setSelectedContact(null);
    setView("create");
  };

  const handleEdit = () => {
    setView("edit");
  };

  const handleDelete = async () => {
    if (!selectedContact) return;
    if (!window.confirm(t("delete_confirm"))) return;

    try {
      if (supportsSync && client) {
        await deleteContact(client, selectedContact.id);
      } else {
        deleteLocalContact(selectedContact.id);
      }
      toast.success(t("toast.deleted"));
      setView("list");
    } catch {
      toast.error(t("toast.error_delete"));
    }
  };

  const handleSaveNew = useCallback(async (data: Partial<ContactCard>) => {
    if (supportsSync && client) {
      await createContact(client, data);
      toast.success(t("toast.created"));
    } else {
      const localContact: ContactCard = {
        id: `local-${crypto.randomUUID()}`,
        addressBookIds: {},
        ...data,
      };
      addLocalContact(localContact);
      toast.success(t("toast.created"));
    }
    setView("list");
  }, [supportsSync, client, createContact, addLocalContact, t]);

  const handleSaveEdit = useCallback(async (data: Partial<ContactCard>) => {
    if (!selectedContact) return;

    if (supportsSync && client) {
      await updateContact(client, selectedContact.id, data);
      toast.success(t("toast.updated"));
    } else {
      updateLocalContact(selectedContact.id, data);
      toast.success(t("toast.updated"));
    }
    setView("detail");
  }, [supportsSync, client, selectedContact, updateContact, updateLocalContact, t]);

  const handleCancel = () => {
    setView(selectedContact ? "detail" : "list");
  };

  if (!isAuthenticated) return null;

  return (
    <div className="flex h-screen bg-background">
      <div className="w-80 border-r border-border flex flex-col">
        <div className="p-4 border-b border-border">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/")}
            className="w-full justify-start"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t("back_to_mail")}
          </Button>
        </div>

        <ContactList
          contacts={contacts}
          selectedContactId={selectedContactId}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSelectContact={handleSelectContact}
          onCreateNew={handleCreateNew}
          supportsSync={supportsSync}
          className="flex-1"
        />
      </div>

      <div className="flex-1">
        {view === "create" && (
          <ContactForm onSave={handleSaveNew} onCancel={handleCancel} />
        )}
        {view === "edit" && selectedContact && (
          <ContactForm
            contact={selectedContact}
            onSave={handleSaveEdit}
            onCancel={handleCancel}
          />
        )}
        {(view === "list" || view === "detail") && (
          <ContactDetail
            contact={selectedContact}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        )}
      </div>
    </div>
  );
}

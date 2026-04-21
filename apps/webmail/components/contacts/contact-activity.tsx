"use client";

import { useEffect, useState } from "react";
import { useTranslations, useFormatter } from "next-intl";
import { Mail, CalendarDays, Loader2 } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { cn } from "@/lib/utils";
import type { ContactCard, Email, CalendarEvent } from "@/lib/jmap/types";

const EMAIL_LIMIT = 5;
const EVENT_LIMIT = 5;
const EVENT_LOOKAHEAD_DAYS = 365;

interface ContactActivityProps {
  contact: ContactCard;
}

function getContactEmails(contact: ContactCard): string[] {
  if (!contact.emails) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const e of Object.values(contact.emails)) {
    const addr = e.address?.trim().toLowerCase();
    if (addr && !seen.has(addr)) {
      seen.add(addr);
      result.push(addr);
    }
  }
  return result;
}

function buildEmailFilter(addresses: string[]): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [];
  for (const addr of addresses) {
    conditions.push({ from: addr });
    conditions.push({ to: addr });
  }
  if (conditions.length === 1) return conditions[0];
  return { operator: "OR", conditions };
}

function eventInvolvesContact(event: CalendarEvent, addresses: Set<string>): boolean {
  if (!event.participants) return false;
  for (const p of Object.values(event.participants)) {
    const email = p.email?.trim().toLowerCase();
    if (email && addresses.has(email)) return true;
    if (p.sendTo) {
      for (const target of Object.values(p.sendTo)) {
        const m = typeof target === "string" ? target.match(/mailto:(.+)/i) : null;
        if (m && addresses.has(m[1].trim().toLowerCase())) return true;
      }
    }
  }
  if (event.organizerCalendarAddress) {
    const m = event.organizerCalendarAddress.match(/mailto:(.+)/i);
    const org = m ? m[1].trim().toLowerCase() : event.organizerCalendarAddress.trim().toLowerCase();
    if (addresses.has(org)) return true;
  }
  return false;
}

export function ContactActivity({ contact }: ContactActivityProps) {
  const t = useTranslations("contacts.activity");
  const format = useFormatter();
  const router = useRouter();
  const client = useAuthStore((s) => s.client);
  const selectEmail = useEmailStore((s) => s.selectEmail);
  const setSelectedEventId = useCalendarStore((s) => s.setSelectedEventId);
  const setSelectedDate = useCalendarStore((s) => s.setSelectedDate);

  const [emails, setEmails] = useState<Email[] | null>(null);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [emailsLoading, setEmailsLoading] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [emailsError, setEmailsError] = useState(false);
  const [eventsError, setEventsError] = useState(false);

  const addresses = getContactEmails(contact);
  const addressKey = addresses.join(",");

  useEffect(() => {
    if (!client || addresses.length === 0) {
      setEmails([]);
      return;
    }
    let cancelled = false;
    setEmailsLoading(true);
    setEmailsError(false);
    client
      .advancedSearchEmails(buildEmailFilter(addresses), undefined, EMAIL_LIMIT, 0)
      .then((res) => {
        if (cancelled) return;
        setEmails(res.emails);
      })
      .catch(() => {
        if (cancelled) return;
        setEmailsError(true);
        setEmails([]);
      })
      .finally(() => {
        if (!cancelled) setEmailsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, addressKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!client || addresses.length === 0) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    setEventsLoading(true);
    setEventsError(false);
    const now = new Date();
    const before = new Date(now.getTime() + EVENT_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
    const addrSet = new Set(addresses);
    client
      .queryAllCalendarEvents(
        { after: now.toISOString(), before: before.toISOString() },
        [{ property: "start", isAscending: true }],
        500,
      )
      .then((all) => {
        if (cancelled) return;
        const matching = all
          .filter((e) => eventInvolvesContact(e, addrSet))
          .sort((a, b) => a.start.localeCompare(b.start))
          .slice(0, EVENT_LIMIT);
        setEvents(matching);
      })
      .catch(() => {
        if (cancelled) return;
        setEventsError(true);
        setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, addressKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (addresses.length === 0) return null;

  const handleOpenEmail = (email: Email) => {
    selectEmail(email);
    router.push("/mail");
  };

  const handleOpenEvent = (event: CalendarEvent) => {
    const start = new Date(event.start);
    if (!isNaN(start.getTime())) setSelectedDate(start);
    setSelectedEventId(event.id);
    router.push("/calendar");
  };

  const formatEmailDate = (dateStr: string) => {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return format.dateTime(d, sameYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" });
  };

  const formatEventDate = (event: CalendarEvent) => {
    const d = new Date(event.start);
    if (isNaN(d.getTime())) return event.start;
    if (event.showWithoutTime) {
      return format.dateTime(d, { weekday: "short", month: "short", day: "numeric" });
    }
    return format.dateTime(d, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  return (
    <>
      <ActivitySection icon={Mail} title={t("recent_emails")}>
        {emailsLoading ? (
          <LoadingRow />
        ) : emailsError ? (
          <p className="text-xs text-muted-foreground">{t("load_failed")}</p>
        ) : !emails || emails.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("no_emails")}</p>
        ) : (
          emails.map((email) => (
            <button
              key={email.id}
              type="button"
              onClick={() => handleOpenEmail(email)}
              className="w-full text-left p-2 -mx-2 rounded-md hover:bg-muted/60 transition-colors touch-manipulation"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium truncate">
                  {email.subject || t("no_subject")}
                </span>
                <span className="text-xs text-muted-foreground flex-shrink-0">
                  {formatEmailDate(email.receivedAt)}
                </span>
              </div>
              {email.preview && (
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {email.preview}
                </p>
              )}
            </button>
          ))
        )}
      </ActivitySection>

      <ActivitySection icon={CalendarDays} title={t("upcoming_events")}>
        {eventsLoading ? (
          <LoadingRow />
        ) : eventsError ? (
          <p className="text-xs text-muted-foreground">{t("load_failed")}</p>
        ) : !events || events.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("no_events")}</p>
        ) : (
          events.map((event) => (
            <button
              key={event.id}
              type="button"
              onClick={() => handleOpenEvent(event)}
              className="w-full text-left p-2 -mx-2 rounded-md hover:bg-muted/60 transition-colors touch-manipulation"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium truncate">
                  {event.title || t("no_title")}
                </span>
                <span className="text-xs text-muted-foreground flex-shrink-0">
                  {formatEventDate(event)}
                </span>
              </div>
            </button>
          ))
        )}
      </ActivitySection>
    </>
  );
}

function ActivitySection({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-4 border-l-[3px]", "border-l-rose-400 dark:border-l-rose-500")}>
      <div className="flex items-center gap-2 mb-2.5">
        <Icon className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      </div>
      <div className="space-y-1 pl-6">{children}</div>
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
    </div>
  );
}

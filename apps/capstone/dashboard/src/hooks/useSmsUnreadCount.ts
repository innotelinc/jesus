import { useEffect, useMemo, useState } from 'react';
import { api, type SmsMessage } from '../lib/api';
import { loadReadSmsIds, SMS_READ_CHANGED_EVENT, unreadSms } from '../lib/smsUnread';

/**
 * How many replies the operator has not opened, for the sidebar badge.
 *
 * The badge lives in the app shell, so it must never be the reason a page
 * breaks: an unreachable API means "no badge", and the SMS Inbox page is where
 * the failure is explained. It polls the same endpoint that page reads, at half
 * the cadence — a hint, not a live feed.
 */
const POLL_MS = 30_000;

export function useSmsUnreadCount(): number {
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [read, setRead] = useState<Set<string>>(loadReadSmsIds);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      // A background tab should not keep polling the phone's inbox.
      if (document.visibilityState === 'hidden') return;
      try {
        const inbox = await api.smsInbox();
        if (alive) setMessages(inbox.messages ?? []);
      } catch {
        // Best effort: keep the last count rather than flashing to zero.
      }
    };

    const sync = () => setRead(loadReadSmsIds());
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };

    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    // Same tab: the inbox page marks a thread read.
    window.addEventListener(SMS_READ_CHANGED_EVENT, sync);
    // Other tabs share the read markers; they only hear about it via storage.
    window.addEventListener('storage', sync);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener(SMS_READ_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return useMemo(() => unreadSms(messages, read).length, [messages, read]);
}

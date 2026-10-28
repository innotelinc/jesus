import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Sidebar from './Sidebar';
import SmsInbox from '../pages/SmsInbox';
import type { SmsInboxState, SmsMessage } from '../lib/api';

const mocks = vi.hoisted(() => ({
  smsInbox: vi.fn(),
  sendSms: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: { smsInbox: mocks.smsInbox, sendSms: mocks.sendSms },
}));

vi.mock('../context/DashboardDataContext', () => ({
  useDashboardData: () => ({ links: [] }),
}));

const inbound = (id: string, body: string, from = '+15551234567'): SmsMessage => ({
  id,
  from,
  body,
  received_at: '2026-10-20 10:00:00',
  sim: 0,
});

const reply = (id: string, body: string, to = '+15551234567'): SmsMessage => ({
  id,
  direction: 'out' as const,
  to,
  body,
  sent_at: '2026-10-20 10:05:00',
  transport: 'modem',
});

const inboxWith = (messages: SmsMessage[]): SmsInboxState => ({
  enabled: true,
  token_set: true,
  count: messages.length,
  messages,
});

describe('SMS Inbox sidebar badge', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.smsInbox.mockReset();
    mocks.sendSms.mockReset();
  });

  it('counts unopened replies on the inbox entry', async () => {
    mocks.smsInbox.mockResolvedValue(inboxWith([
      inbound('a1', 'can I book?'),
      inbound('a2', 'still there?'),
    ]));

    render(<MemoryRouter><Sidebar /></MemoryRouter>);

    const link = await screen.findByRole('link', { name: /SMS Inbox/ });
    await waitFor(() => expect(link).toHaveAccessibleName('SMS Inbox (2 unread)'));
    expect(within(link).getByText('2')).toBeInTheDocument();
  });

  it('does not count answers already sent or replies already read', async () => {
    // a1 was opened earlier; o1 is outbound. Only b1 is genuinely unread.
    window.localStorage.setItem('capstone.sms.read', JSON.stringify(['a1']));
    mocks.smsInbox.mockResolvedValue(inboxWith([
      inbound('a1', 'seen already'),
      reply('o1', 'our answer'),
      inbound('b1', 'brand new', '+15550002222'),
    ]));

    render(<MemoryRouter><Sidebar /></MemoryRouter>);

    const link = await screen.findByRole('link', { name: /SMS Inbox/ });
    await waitFor(() => expect(link).toHaveAccessibleName('SMS Inbox (1 unread)'));
    expect(within(link).getByText('1')).toBeInTheDocument();
  });

  it('retracts the badge when the thread is opened, and remembers that across reloads', async () => {
    mocks.smsInbox.mockResolvedValue(inboxWith([inbound('a1', 'can I book?')]));

    const { unmount } = render(
      <MemoryRouter>
        <Sidebar />
        <SmsInbox />
      </MemoryRouter>,
    );

    const link = await screen.findByRole('link', { name: /SMS Inbox/ });
    await waitFor(() => expect(link).toHaveAccessibleName('SMS Inbox (1 unread)'));

    // The inbox page auto-opens the newest thread, which is what marks it read.
    await screen.findByLabelText('Conversation with +15551234567');
    await waitFor(() => expect(link).toHaveAccessibleName('SMS Inbox'));
    expect(within(link).queryByText('1')).not.toBeInTheDocument();

    // A reload keeps it read: the markers, not the page, carry the fact.
    unmount();
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    const reloaded = await screen.findByRole('link', { name: /SMS Inbox/ });
    await waitFor(() => expect(mocks.smsInbox).toHaveBeenCalled());
    expect(reloaded).toHaveAccessibleName('SMS Inbox');
  });

  it('shows a dot instead of a number when the sidebar is collapsed', async () => {
    mocks.smsInbox.mockResolvedValue(inboxWith([inbound('a1', 'hello?')]));

    render(<MemoryRouter><Sidebar collapsed /></MemoryRouter>);

    const link = await screen.findByRole('link', { name: /SMS Inbox/ });
    await waitFor(() => expect(link).toHaveAccessibleName('SMS Inbox (1 unread)'));
    expect(within(link).queryByText('1')).not.toBeInTheDocument();
  });

  it('keeps the shell usable when the inbox cannot be read', async () => {
    mocks.smsInbox.mockRejectedValue(new Error('Dashboard API /sms-inbound failed: 503'));

    render(<MemoryRouter><Sidebar /></MemoryRouter>);

    const link = await screen.findByRole('link', { name: 'SMS Inbox' });
    await waitFor(() => expect(mocks.smsInbox).toHaveBeenCalled());
    // A failed poll leaves the name bare: no count, and no crash in the shell.
    expect(link).toHaveAccessibleName('SMS Inbox');
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
  });
});

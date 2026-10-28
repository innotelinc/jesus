import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SmsInbox from './SmsInbox';
import type { SmsInboxState, SmsMessage } from '../lib/api';

const mocks = vi.hoisted(() => ({
  smsInbox: vi.fn(),
  sendSms: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: { smsInbox: mocks.smsInbox, sendSms: mocks.sendSms },
}));

const inbound = (id: string, from: string, body: string, received = '2026-10-20 10:02:00'): SmsMessage => ({
  id,
  from,
  body,
  received_at: received,
  sim: 0,
});

const outbound = (id: string, to: string, body: string): SmsMessage => ({
  id,
  direction: 'out' as const,
  to,
  body,
  sent_at: '2026-10-20 10:05:00',
  transport: 'modem',
});

function inboxWith(messages: SmsMessage[]): SmsInboxState {
  return { enabled: true, token_set: true, count: messages.length, messages };
}

describe('SMS Inbox', () => {
  beforeEach(() => {
    mocks.smsInbox.mockReset();
    mocks.sendSms.mockReset();
  });

  it('groups replies into conversations, newest first', async () => {
    mocks.smsInbox.mockResolvedValue(inboxWith([
      inbound('a1', '+15550001111', 'old reply from ann'),
      inbound('b1', '+15550002222', 'hello from bob'),
      inbound('a2', '+15550001111', 'newer reply from ann'),
    ]));

    render(<SmsInbox />);

    const list = await screen.findByLabelText('Conversations');
    const threads = within(list).getAllByRole('button');
    expect(threads).toHaveLength(2);
    expect(threads[0]).toHaveTextContent('+15550001111');
    expect(threads[0]).toHaveTextContent('newer reply from ann');

    // The newest conversation is open by default, showing both of its messages.
    const thread = await screen.findByLabelText('Conversation with +15550001111');
    expect(within(thread).getByText('old reply from ann')).toBeInTheDocument();
    expect(within(thread).getByText('newer reply from ann')).toBeInTheDocument();
    expect(within(thread).queryByText('hello from bob')).not.toBeInTheDocument();
  });

  it('sends a reply to the open thread through the phone and reloads it', async () => {
    mocks.smsInbox
      .mockResolvedValueOnce(inboxWith([inbound('a1', '+15551234567', 'can I book?')]))
      .mockResolvedValueOnce(inboxWith([
        inbound('a1', '+15551234567', 'can I book?'),
        outbound('out-1', '+15551234567', 'yes, 3pm works'),
      ]));
    mocks.sendSms.mockResolvedValue({
      ok: true, to: '+15551234567', transport: 'modem', status: 'sent', recorded: true,
    });

    const user = userEvent.setup();
    render(<SmsInbox />);

    const thread = await screen.findByLabelText('Conversation with +15551234567');
    expect(within(thread).getByText('can I book?')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Reply to +15551234567'), 'yes, 3pm works');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(mocks.sendSms).toHaveBeenCalledWith('+15551234567', 'yes, 3pm works');
    expect(await within(thread).findByText('yes, 3pm works')).toBeInTheDocument();
    expect(await screen.findByText(/Sent through the phone \(modem\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('Reply to +15551234567')).toHaveValue('');
  });

  it('shows the phone’s reason when the reply is not sent', async () => {
    mocks.smsInbox.mockResolvedValue(inboxWith([inbound('a1', '+15551234567', 'hello?')]));
    mocks.sendSms.mockRejectedValue(new Error('the phone did not send the message: no credit'));

    const user = userEvent.setup();
    render(<SmsInbox />);

    const thread = await screen.findByLabelText('Conversation with +15551234567');
    expect(within(thread).getByText('hello?')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Reply to +15551234567'), 'trying');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('no credit');
    // The draft survives, so the operator can retry without retyping it.
    expect(screen.getByLabelText('Reply to +15551234567')).toHaveValue('trying');
  });

  it('says inbound is closed when the host has no token', async () => {
    mocks.smsInbox.mockResolvedValue({
      enabled: false, token_set: false, count: 0, messages: [],
    });

    render(<SmsInbox />);

    expect(await screen.findByText(/Inbound forwarding is closed/i)).toBeInTheDocument();
    expect(screen.getByText('No SMS yet')).toBeInTheDocument();
  });

  it('reports a failure to load instead of pretending the inbox is empty', async () => {
    mocks.smsInbox.mockRejectedValue(new Error('Dashboard API /sms-inbound failed: 500'));

    render(<SmsInbox />);

    expect(await screen.findByText(/\/sms-inbound failed: 500/)).toBeInTheDocument();
  });
});

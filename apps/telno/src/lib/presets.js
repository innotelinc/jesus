/**
 * Recipes.
 *
 * Two screens on this platform used to ask an operator to type a small
 * configuration language from memory — `dial | Ring the desk | 220` for a
 * workflow, and a blank script for a voice agent. That is a barrier disguised as
 * flexibility: the codes are not guessable, a typo fails silently, and the first
 * useful automation costs an afternoon.
 *
 * A recipe is a complete, working starting point: it names the trigger, lists
 * the steps with real targets, and comes with a sentence explaining what it is
 * for. Choosing one creates an ordinary workflow or agent — every field stays
 * editable afterwards, so a recipe is a starting point and not a mode.
 */

export const STEP_TYPES = [
  { type: 'dial', label: 'Call a number or extension', hint: 'Rings the target and connects the caller.' },
  { type: 'transfer', label: 'Transfer to a person', hint: 'Hands the call over without announcing it.' },
  { type: 'voicemail', label: 'Take a voicemail', hint: 'Plays the greeting and records the message.' },
  { type: 'sms', label: 'Send a text', hint: 'Messages the caller, or a fixed number you name.' },
  { type: 'email', label: 'Send an email', hint: 'Notifies an address with the call details.' },
  { type: 'webhook', label: 'Call a webhook', hint: 'POSTs the event to your own endpoint.' },
  { type: 'tag', label: 'Tag the call', hint: 'Labels the record for reporting and search.' },
  { type: 'wait', label: 'Wait', hint: 'A number of seconds before the next step.' },
];

export const TRIGGERS = [
  { value: 'inbound', label: 'An inbound call arrives' },
  { value: 'outbound', label: 'An outbound call is placed' },
  { value: 'schedule', label: 'On a schedule' },
  { value: 'webhook', label: 'A webhook arrives' },
  { value: 'manual', label: 'Only when run by hand' },
];

/** Workflow recipes. Targets are placeholders an operator will recognise. */
export const WORKFLOW_RECIPES = [
  {
    id: 'missed-call-text-back',
    name: 'Missed call → text back',
    trigger: 'inbound',
    description:
      'Rings the desk for 25 seconds, then texts the caller so a missed call is a conversation rather than a lost lead.',
    steps: [
      { type: 'dial', label: 'Ring the front desk', target: '100' },
      { type: 'wait', label: 'Give it 25 seconds', target: '25' },
      { type: 'sms', label: 'Text the caller back', target: 'caller' },
      { type: 'voicemail', label: 'Offer voicemail anyway', target: '100' },
    ],
  },
  {
    id: 'after-hours',
    name: 'After hours → voicemail + alert',
    trigger: 'schedule',
    description:
      'Outside business hours nobody is rung: the caller gets voicemail and the on-call address hears about it immediately.',
    steps: [
      { type: 'voicemail', label: 'Take the message', target: '100' },
      { type: 'email', label: 'Email the on-call address', target: 'oncall@example.com' },
      { type: 'tag', label: 'Mark it after-hours', target: 'after-hours' },
    ],
  },
  {
    id: 'new-number-welcome',
    name: 'New number → welcome text',
    trigger: 'manual',
    description:
      'The first message a new line sends: a short, plain welcome with the number they can be reached on.',
    steps: [
      { type: 'sms', label: 'Welcome the new holder', target: 'customer' },
      { type: 'tag', label: 'Mark the line welcomed', target: 'onboarding' },
    ],
  },
  {
    id: 'urgent-escalation',
    name: 'Unanswered 3 times → escalate',
    trigger: 'inbound',
    description:
      'Rings the desk, then the mobile, then posts to your own system, so the third attempt is never another ring.',
    steps: [
      { type: 'dial', label: 'Front desk', target: '100' },
      { type: 'dial', label: 'Duty mobile', target: '+14155550111' },
      { type: 'webhook', label: 'Tell your system', target: 'https://example.com/hooks/call' },
      { type: 'voicemail', label: 'Last resort: voicemail', target: '100' },
    ],
  },
  {
    id: 'fax-to-email',
    name: 'Fax received → email it',
    trigger: 'inbound',
    description:
      'A document the switch received is filed and mailed on, so a fax number is a mailbox rather than a machine.',
    steps: [
      { type: 'email', label: 'Mail the document on', target: 'faxes@example.com' },
      { type: 'tag', label: 'File it', target: 'fax' },
    ],
  },
];

/** Voices and languages the agents offer, with a plain-language label. */
export const VOICES = [
  { value: 'aria', label: 'Aria — warm, neutral' },
  { value: 'marcus', label: 'Marcus — low, steady' },
  { value: 'sofia', label: 'Sofia — bright, quick' },
  { value: 'nora', label: 'Nora — calm, clear' },
];

export const LANGUAGES = [
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'es-US', label: 'Spanish (United States)' },
  { value: 'fr-CA', label: 'French (Canada)' },
  { value: 'de-DE', label: 'German' },
];

/**
 * Voice-agent presets. Each one is a working persona: greeting, behaviour,
 * boundaries and where it hands off. The script is written to be edited — it is
 * a starting paragraph, not a template full of placeholders.
 */
export const AGENT_PRESETS = [
  {
    id: 'reception',
    name: 'Reception',
    voice: 'aria',
    language: 'en-US',
    greeting: 'Thanks for calling. How can I help today?',
    prompt:
      'You are the receptionist for this business. Answer in one short sentence, find out who the caller needs, and transfer to the right extension. If you do not know the extension, offer to take a message. Never quote prices, never promise a time, and never invent a person who does not work here. If the caller asks for a human, transfer immediately without further questions.',
    recordInbound: true,
  },
  {
    id: 'sales',
    name: 'Sales enquiry',
    voice: 'sofia',
    language: 'en-US',
    greeting: 'Hi — are you calling about a new line or an existing one?',
    prompt:
      'You qualify inbound sales calls. Ask whether they are buying for a home or a business, how many people will use the line, and whether they need to keep an existing number. Record the answers. Do not quote a price or a discount; say a specialist will confirm the details, then transfer to the sales extension. If they ask to cancel, transfer to support instead.',
    recordInbound: true,
  },
  {
    id: 'support',
    name: 'Support triage',
    voice: 'nora',
    language: 'en-US',
    greeting: 'Support — what is not working?',
    prompt:
      'You triage support calls. Get one sentence on the symptom, then ask when it started and whether it affects one line or every line. Do not troubleshoot more than one step. If the caller is angry, acknowledge it in a single sentence and transfer to a person. Never ask for a password, a card number or a verification code.',
    recordInbound: true,
  },
  {
    id: 'after-hours-agent',
    name: 'After-hours answering',
    voice: 'marcus',
    language: 'en-US',
    greeting: 'You have reached us outside business hours. I can take a message.',
    prompt:
      'You answer outside business hours. Say once that the office is closed and when it reopens. Take a name, a number and a one-line reason for the call, then confirm them back. Offer voicemail if they would rather leave a longer message. Never claim an urgent matter has been seen by a person; say it will be picked up when the office opens.',
    recordInbound: true,
  },
  {
    id: 'appointment',
    name: 'Appointment booking',
    voice: 'aria',
    language: 'en-US',
    greeting: 'I can book that for you — what day suits you?',
    prompt:
      'You book appointments. Ask for a preferred day and a window, confirm the name and a callback number, and read the booking back once. If the requested day is not offered, say so plainly and offer the nearest alternative. Never double-book, and never confirm a slot you were not given.',
    recordInbound: true,
  },
];

/** Everything the two screens need to offer choices instead of blank fields. */
export const presets = () => ({
  stepTypes: STEP_TYPES,
  triggers: TRIGGERS,
  workflows: WORKFLOW_RECIPES,
  agents: AGENT_PRESETS,
  voices: VOICES,
  languages: LANGUAGES,
});

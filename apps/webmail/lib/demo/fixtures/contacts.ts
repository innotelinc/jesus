import type { ContactCard, AddressBook } from '@/lib/jmap/types';

export function createDemoAddressBooks(): AddressBook[] {
  return [
    {
      id: 'demo-addressbook-personal',
      name: 'Personal',
      isDefault: true,
      isSubscribed: true,
      sortOrder: 1,
      myRights: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: false },
    },
    {
      id: 'demo-addressbook-work',
      name: 'Work',
      isDefault: false,
      isSubscribed: true,
      sortOrder: 2,
      myRights: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true },
    },
  ];
}

export function createDemoContacts(): ContactCard[] {
  return [
    // ── Personal address book ──────────────────────────────────
    {
      id: 'demo-contact-1',
      addressBookIds: { 'demo-addressbook-personal': true },
      kind: 'individual',
      name: { components: [{ kind: 'given', value: 'Alice' }, { kind: 'surname', value: 'Johnson' }] },
      emails: { e1: { address: 'alice.johnson@example.com', contexts: { work: true }, pref: 1 } },
      phones: { p1: { number: '+1-555-0101', features: { voice: true }, contexts: { work: true } } },
      organizations: { o1: { name: 'Acme Corp', units: [{ name: 'Engineering' }] } },
      titles: { t1: { name: 'Senior Engineer', kind: 'title' } },
      anniversaries: { a1: { kind: 'birth', date: { year: 1990, month: 3, day: 15 } } },
    },
    {
      id: 'demo-contact-2',
      addressBookIds: { 'demo-addressbook-personal': true },
      kind: 'individual',
      name: { components: [{ kind: 'given', value: 'Bob' }, { kind: 'surname', value: 'Chen' }] },
      emails: {
        e1: { address: 'bob.chen@example.com', contexts: { work: true }, pref: 1 },
        e2: { address: 'bob.personal@email.example', contexts: { private: true } },
      },
      phones: {
        p1: { number: '+1-555-0102', features: { voice: true }, contexts: { work: true } },
        p2: { number: '+1-555-0103', features: { cell: true }, contexts: { private: true } },
      },
      organizations: { o1: { name: 'Acme Corp', units: [{ name: 'Backend Team' }] } },
      titles: { t1: { name: 'Staff Engineer', kind: 'title' } },
    },
    {
      id: 'demo-contact-3',
      addressBookIds: { 'demo-addressbook-personal': true },
      kind: 'individual',
      name: { components: [{ kind: 'given', value: 'Sarah' }, { kind: 'surname', value: 'Kim' }] },
      emails: { e1: { address: 'sarah.kim@example.com', pref: 1 } },
      phones: { p1: { number: '+1-555-0104', features: { voice: true } } },
      organizations: { o1: { name: 'DesignCo' } },
      titles: { t1: { name: 'UX Designer', kind: 'title' } },
    },
    {
      id: 'demo-contact-4',
      addressBookIds: { 'demo-addressbook-personal': true },
      kind: 'individual',
      name: { components: [{ kind: 'given', value: 'Carlos' }, { kind: 'surname', value: 'Rivera' }] },
      emails: { e1: { address: 'carlos.rivera@example.com', pref: 1 } },
      phones: { p1: { number: '+1-555-0105', features: { cell: true } } },
      notes: { n1: { note: 'Met at the DevConf 2024 conference' } },
    },
    {
      id: 'demo-contact-5',
      addressBookIds: { 'demo-addressbook-personal': true },
      kind: 'individual',
      name: { components: [{ kind: 'given', value: 'Emma' }, { kind: 'surname', value: 'Wilson' }] },
      emails: { e1: { address: 'emma.wilson@example.com', pref: 1 } },
      addresses: {
        a1: {
          components: [
            { kind: 'number', value: '456' },
            { kind: 'name', value: 'Elm Street' },
            { kind: 'locality', value: 'Springfield' },
            { kind: 'region', value: 'IL' },
            { kind: 'postcode', value: '62701' },
          ],
          contexts: { private: true },
        },
      },
      anniversaries: { a1: { kind: 'birth', date: { month: 7, day: 22 } } },
    },
    {
      id: 'demo-contact-6',
      addressBookIds: { 'demo-addressbook-personal': true },
      kind: 'individual',
      name: { components: [{ kind: 'given', value: 'David' }, { kind: 'surname', value: 'Park' }] },
      emails: { e1: { address: 'david.park@example.com', pref: 1 } },
      phones: { p1: { number: '+82-10-1234-5678', features: { cell: true } } },
    },
    {
      id: 'demo-contact-7',
      addressBookIds: { 'demo-addressbook-personal': true },
      kind: 'org',
      name: { components: [{ kind: 'surname', value: 'Local Coffee Shop' }] },
      emails: { e1: { address: 'hello@localcoffee.example', pref: 1 } },
      phones: { p1: { number: '+1-555-0200', features: { voice: true } } },
      addresses: {
        a1: {
          components: [
            { kind: 'number', value: '789' },
            { kind: 'name', value: 'Main Street' },
            { kind: 'locality', value: 'Anytown' },
            { kind: 'region', value: 'CA' },
            { kind: 'postcode', value: '90210' },
          ],
        },
      },
    },
    {
      id: 'demo-contact-8',
      addressBookIds: { 'demo-addressbook-personal': true },
      kind: 'individual',
      name: { components: [{ kind: 'given', value: 'Lisa' }, { kind: 'surname', value: 'Tanaka' }] },
      emails: { e1: { address: 'lisa.tanaka@example.com', pref: 1 } },
    },

    // ── Work address book ──────────────────────────────────────
    {
      id: 'demo-contact-9',
      addressBookIds: { 'demo-addressbook-work': true },
      kind: 'individual',
      name: { components: [{ kind: 'given', value: 'Michael' }, { kind: 'surname', value: 'Torres' }] },
      emails: { e1: { address: 'michael.torres@company.example', contexts: { work: true }, pref: 1 } },
      phones: { p1: { number: '+1-555-0301', features: { voice: true }, contexts: { work: true } } },
      organizations: { o1: { name: 'Company Inc', units: [{ name: 'Product' }] } },
      titles: { t1: { name: 'Product Manager', kind: 'title' } },
    },
    {
      id: 'demo-contact-10',
      addressBookIds: { 'demo-addressbook-work': true },
      kind: 'individual',
      name: { components: [{ kind: 'given', value: 'Rachel' }, { kind: 'surname', value: 'Green' }] },
      emails: { e1: { address: 'rachel.green@company.example', contexts: { work: true }, pref: 1 } },
      organizations: { o1: { name: 'Company Inc', units: [{ name: 'Marketing' }] } },
      titles: { t1: { name: 'Marketing Lead', kind: 'title' } },
    },
    {
      id: 'demo-contact-11',
      addressBookIds: { 'demo-addressbook-work': true },
      kind: 'individual',
      name: { components: [{ kind: 'given', value: 'James' }, { kind: 'surname', value: 'Miller' }] },
      emails: { e1: { address: 'james.miller@company.example', contexts: { work: true }, pref: 1 } },
      organizations: { o1: { name: 'Company Inc', units: [{ name: 'Engineering' }] } },
      titles: { t1: { name: 'CTO', kind: 'title' } },
    },
    {
      id: 'demo-contact-12',
      addressBookIds: { 'demo-addressbook-work': true },
      kind: 'individual',
      name: { components: [{ kind: 'given', value: 'Priya' }, { kind: 'surname', value: 'Sharma' }] },
      emails: { e1: { address: 'priya.sharma@company.example', contexts: { work: true }, pref: 1 } },
      organizations: { o1: { name: 'Company Inc', units: [{ name: 'QA' }] } },
      titles: { t1: { name: 'QA Engineer', kind: 'title' } },
    },
    {
      id: 'demo-contact-13',
      addressBookIds: { 'demo-addressbook-work': true },
      kind: 'individual',
      name: { components: [{ kind: 'given', value: 'Ahmed' }, { kind: 'surname', value: 'Hassan' }] },
      emails: { e1: { address: 'ahmed.hassan@company.example', contexts: { work: true }, pref: 1 } },
      organizations: { o1: { name: 'Company Inc', units: [{ name: 'DevOps' }] } },
      titles: { t1: { name: 'DevOps Engineer', kind: 'title' } },
    },
    {
      id: 'demo-contact-14',
      addressBookIds: { 'demo-addressbook-work': true },
      kind: 'individual',
      name: { components: [{ kind: 'given', value: 'Maria' }, { kind: 'surname', value: 'Lopez' }] },
      emails: { e1: { address: 'maria.lopez@company.example', contexts: { work: true }, pref: 1 } },
      organizations: { o1: { name: 'Company Inc', units: [{ name: 'HR' }] } },
      titles: { t1: { name: 'HR Business Partner', kind: 'title' } },
    },
    {
      id: 'demo-contact-15',
      addressBookIds: { 'demo-addressbook-work': true },
      kind: 'individual',
      name: { components: [{ kind: 'given', value: 'Wei' }, { kind: 'surname', value: 'Zhang' }] },
      emails: { e1: { address: 'wei.zhang@company.example', contexts: { work: true }, pref: 1 } },
      organizations: { o1: { name: 'Company Inc', units: [{ name: 'Data Science' }] } },
      titles: { t1: { name: 'Data Scientist', kind: 'title' } },
    },
  ];
}

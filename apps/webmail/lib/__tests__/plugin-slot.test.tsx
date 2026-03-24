import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import type { SlotRegistration } from '@/lib/plugin-types';

// Mock the plugin store
const mockSlots: Record<string, SlotRegistration[]> = {};

vi.mock('@/stores/plugin-store', () => ({
  usePluginStore: (selector: (s: { slots: typeof mockSlots }) => unknown) =>
    selector({ slots: mockSlots }),
}));

// Import after mocks
import { PluginSlot } from '@/components/plugins/plugin-slot';
import { PluginErrorBoundary } from '@/components/plugins/plugin-error-boundary';

beforeEach(() => {
  Object.keys(mockSlots).forEach(k => delete mockSlots[k]);
});

describe('PluginSlot', () => {
  it('renders null when no registrations', () => {
    mockSlots['toolbar-actions'] = [];
    const { container } = render(
      React.createElement(PluginSlot, { name: 'toolbar-actions' })
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders null when slot has undefined registrations', () => {
    // slot entry doesn't exist at all
    const { container } = render(
      React.createElement(PluginSlot, { name: 'toolbar-actions' })
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders registered components', () => {
    const TestComponent = () => React.createElement('span', null, 'Hello Plugin');
    mockSlots['email-footer'] = [
      { pluginId: 'test', component: TestComponent, order: 100 },
    ];
    const { getByText } = render(
      React.createElement(PluginSlot, { name: 'email-footer' })
    );
    expect(getByText('Hello Plugin')).toBeTruthy();
  });

  it('sets data-plugin-slot attribute', () => {
    const TestComponent = () => React.createElement('span', null, 'x');
    mockSlots['sidebar-widget'] = [
      { pluginId: 'sw', component: TestComponent, order: 100 },
    ];
    const { container } = render(
      React.createElement(PluginSlot, { name: 'sidebar-widget' })
    );
    expect(container.querySelector('[data-plugin-slot="sidebar-widget"]')).toBeTruthy();
  });
});

describe('PluginErrorBoundary', () => {
  it('renders children when no error', () => {
    const { getByText } = render(
      React.createElement(
        PluginErrorBoundary,
        { pluginId: 'test' },
        React.createElement('span', null, 'Child')
      )
    );
    expect(getByText('Child')).toBeTruthy();
  });

  it('renders fallback on error', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ThrowingComponent = () => { throw new Error('boom'); };
    const { getByText } = render(
      React.createElement(
        PluginErrorBoundary,
        { pluginId: 'err', fallback: React.createElement('span', null, 'Error caught') },
        React.createElement(ThrowingComponent)
      )
    );
    expect(getByText('Error caught')).toBeTruthy();
    consoleSpy.mockRestore();
  });

  it('renders null on error when no fallback provided', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ThrowingComponent = () => { throw new Error('boom'); };
    const { container } = render(
      React.createElement(
        PluginErrorBoundary,
        { pluginId: 'err2' },
        React.createElement(ThrowingComponent)
      )
    );
    // ErrorBoundary renders null fallback
    expect(container.innerHTML).toBe('');
    consoleSpy.mockRestore();
  });
});

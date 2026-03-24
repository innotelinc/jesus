import { describe, it, expect, beforeEach } from 'vitest';
import {
  exposePluginExternals,
  deactivatePlugin,
  isPluginActive,
  deactivateAllPlugins,
} from '../plugin-loader';
import { clearAllHooks, pluginErrorTracker } from '../plugin-hooks';

beforeEach(() => {
  clearAllHooks();
  pluginErrorTracker.resetAll();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__PLUGIN_EXTERNALS__;
});

describe('exposePluginExternals', () => {
  it('sets window.__PLUGIN_EXTERNALS__ with React, ReactDOM, ReactJSX', () => {
    exposePluginExternals();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const externals = (globalThis as any).__PLUGIN_EXTERNALS__;
    expect(externals).toBeDefined();
    expect(externals.React).toBeDefined();
    expect(externals.ReactDOM).toBeDefined();
    expect(externals.ReactJSX).toBeDefined();
  });
});

describe('isPluginActive', () => {
  it('returns false for unknown plugin', () => {
    expect(isPluginActive('nonexistent')).toBe(false);
  });
});

describe('deactivatePlugin', () => {
  it('does nothing for unknown plugin (no error)', () => {
    expect(() => deactivatePlugin('nonexistent')).not.toThrow();
  });
});

describe('deactivateAllPlugins', () => {
  it('does not throw when no plugins active', () => {
    expect(() => deactivateAllPlugins()).not.toThrow();
  });
});

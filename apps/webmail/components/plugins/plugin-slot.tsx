'use client';

import React from 'react';
import type { SlotName } from '@/lib/plugin-types';
import { usePluginStore } from '@/stores/plugin-store';
import { PluginSlotRenderer } from './plugin-slot-renderer';

interface PluginSlotProps {
  name: SlotName;
  className?: string;
  extraProps?: Record<string, unknown>;
}

export function PluginSlot({ name, className, extraProps }: PluginSlotProps) {
  const registrations = usePluginStore(s => s.slots[name]);

  if (!registrations || registrations.length === 0) return null;

  return (
    <div className={className} data-plugin-slot={name}>
      {registrations.map((reg, i) => (
        <PluginSlotRenderer
          key={`${reg.pluginId}-${i}`}
          registration={reg}
          extraProps={extraProps}
        />
      ))}
    </div>
  );
}

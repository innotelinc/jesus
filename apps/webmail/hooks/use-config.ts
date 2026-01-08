"use client";

import { useState, useEffect } from 'react';

interface AppConfig {
  appName: string;
  jmapServerUrl: string;
  isLoading: boolean;
  error: string | null;
}

// Cache the config to avoid multiple fetches
let configCache: { appName: string; jmapServerUrl: string } | null = null;
let configPromise: Promise<{ appName: string; jmapServerUrl: string }> | null = null;

async function fetchConfig(): Promise<{ appName: string; jmapServerUrl: string }> {
  // Return cached config if available
  if (configCache) {
    return configCache;
  }

  // If a fetch is already in progress, wait for it
  if (configPromise) {
    return configPromise;
  }

  // Start a new fetch
  configPromise = fetch('/api/config')
    .then((res) => {
      if (!res.ok) {
        throw new Error('Failed to fetch config');
      }
      return res.json();
    })
    .then((data) => {
      configCache = data;
      return data;
    })
    .finally(() => {
      configPromise = null;
    });

  return configPromise;
}

/**
 * Hook to fetch runtime configuration
 *
 * Fetches app configuration from /api/config endpoint, which reads
 * environment variables at runtime (not build time).
 *
 * The config is cached after first fetch to avoid unnecessary requests.
 */
export function useConfig(): AppConfig {
  const [config, setConfig] = useState<AppConfig>({
    appName: configCache?.appName || 'Webmail',
    jmapServerUrl: configCache?.jmapServerUrl || '',
    isLoading: !configCache,
    error: null,
  });

  useEffect(() => {
    // If already cached, no need to fetch
    if (configCache) {
      setConfig({
        appName: configCache.appName,
        jmapServerUrl: configCache.jmapServerUrl,
        isLoading: false,
        error: null,
      });
      return;
    }

    fetchConfig()
      .then((data) => {
        setConfig({
          appName: data.appName,
          jmapServerUrl: data.jmapServerUrl,
          isLoading: false,
          error: null,
        });
      })
      .catch((err) => {
        setConfig((prev) => ({
          ...prev,
          isLoading: false,
          error: err.message,
        }));
      });
  }, []);

  return config;
}

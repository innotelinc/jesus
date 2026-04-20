import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '@/lib/logger';
import type { SubscriptionRecord } from './types';

// JMAP subscriptions default to "no expiry" but servers may expire at will.
// We evict mappings 30d past last activity; active devices re-register on
// every app launch so real users never age out.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
// How long a verification code sits waiting for the client to poll it.
const VERIFICATION_TTL_MS = 10 * 60 * 1000;

function getPushDir(): string {
  return process.env.PUSH_DATA_DIR || path.join(process.cwd(), 'data', 'push');
}

function subscriptionsPath(): string {
  return path.join(getPushDir(), 'subscriptions.json');
}

interface SubscriptionsFile {
  records: Record<string, SubscriptionRecord>;
}

class SubscriptionStore {
  private cache: Record<string, SubscriptionRecord> = {};
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    try {
      const raw = await readFile(subscriptionsPath(), 'utf-8');
      const parsed = JSON.parse(raw) as SubscriptionsFile;
      this.cache = parsed.records ?? {};
      this.evictExpired();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = {};
      } else {
        logger.warn('push: failed to read subscriptions', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        this.cache = {};
      }
    }
    this.loaded = true;
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  async get(id: string): Promise<SubscriptionRecord | null> {
    await this.ensureLoaded();
    const record = this.cache[id];
    if (!record) return null;
    if (this.isExpired(record)) {
      delete this.cache[id];
      await this.persist();
      return null;
    }
    return record;
  }

  async put(id: string, record: SubscriptionRecord): Promise<void> {
    await this.ensureLoaded();
    this.cache[id] = record;
    await this.persist();
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    if (id in this.cache) {
      delete this.cache[id];
      await this.persist();
    }
  }

  private isExpired(record: SubscriptionRecord): boolean {
    const age = Date.now() - (record.lastPushAt ?? record.createdAt);
    return age > TTL_MS;
  }

  private evictExpired(): void {
    for (const [id, record] of Object.entries(this.cache)) {
      if (this.isExpired(record)) delete this.cache[id];
    }
  }

  private persist(): Promise<void> {
    // Serialize writes so concurrent requests don't clobber each other.
    const next = this.writeQueue.then(() => this.flush());
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async flush(): Promise<void> {
    const dir = getPushDir();
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const target = subscriptionsPath();
    const tmp = target + '.tmp';
    const payload: SubscriptionsFile = { records: this.cache };
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    await rename(tmp, target);
  }
}

export const subscriptionStore = new SubscriptionStore();

export { VERIFICATION_TTL_MS };

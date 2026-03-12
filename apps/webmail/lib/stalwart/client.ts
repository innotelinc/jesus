/**
 * Stalwart Management API Client
 *
 * Provides typed access to Stalwart's /api/ endpoints for user self-service:
 * - Password change (PATCH /principal/{name})
 * - Display name update (PATCH /principal/{name})
 * - App passwords (POST /account/auth)
 * - TOTP 2FA management (POST /account/auth)
 * - Encryption-at-rest (GET/POST /account/crypto)
 * - Account auth info (GET /account/auth)
 */

export interface StalwartAuthInfo {
  otpEnabled: boolean;
  isAdminApp: boolean;
  appPasswords: string[];
}

export interface StalwartCryptoInfo {
  type: 'disabled' | 'pgp' | 'smime';
}

export interface StalwartPrincipal {
  id: number;
  type: string;
  name: string;
  description: string;
  emails: string | string[];
  secrets: string | string[];
  quota: number;
  roles: string[];
  lists: string[];
}

export interface PrincipalUpdateAction {
  action: 'set' | 'addItem' | 'removeItem';
  field: string;
  value: string | number;
}

export interface StalwartApiError {
  error: string;
  details: string;
  reason?: string | null;
}

export class StalwartClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(serverUrl: string, authHeader: string) {
    this.baseUrl = serverUrl.replace(/\/$/, '') + '/api';
    this.authHeader = authHeader;
  }

  // eslint-disable-next-line no-undef
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });

    if (!response.ok) {
      let errorDetail = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body.detail) errorDetail = body.detail;
        else if (body.details) errorDetail = body.details;
        else if (body.error) errorDetail = body.error;
      } catch { /* use status code */ }
      throw new Error(errorDetail);
    }

    return response.json();
  }

  /** Probe whether this server exposes Stalwart's management API */
  async probe(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/account/auth`, {
        method: 'GET',
        headers: { 'Authorization': this.authHeader },
      });
      if (response.status === 401) return true; // API exists but needs auth
      if (!response.ok) return false;
      const data = await response.json();
      return data.data !== undefined;
    } catch {
      return false;
    }
  }

  /** GET /account/auth - Fetch 2FA and app password status */
  async getAuthInfo(): Promise<StalwartAuthInfo> {
    const result = await this.request<{ data: StalwartAuthInfo }>('/account/auth');
    return result.data;
  }

  /** POST /account/auth - Update auth settings (TOTP, app passwords) */
  async updateAuth(actions: Array<{ type: string; name?: string; password?: string; url?: string }>): Promise<void> {
    await this.request<{ data: unknown }>('/account/auth', {
      method: 'POST',
      body: JSON.stringify(actions),
    });
  }

  /** Enable TOTP - returns the TOTP URL for QR code generation */
  async enableTotp(): Promise<string> {
    const result = await this.request<{ data: string }>('/account/auth', {
      method: 'POST',
      body: JSON.stringify([{ type: 'enableOtpAuth' }]),
    });
    return result.data;
  }

  /** Disable TOTP */
  async disableTotp(): Promise<void> {
    await this.request<{ data: unknown }>('/account/auth', {
      method: 'POST',
      body: JSON.stringify([{ type: 'disableOtpAuth' }]),
    });
  }

  /** Add an app password */
  async addAppPassword(name: string, password: string): Promise<void> {
    await this.request<{ data: unknown }>('/account/auth', {
      method: 'POST',
      body: JSON.stringify([{ type: 'addAppPassword', name, password }]),
    });
  }

  /** Remove an app password */
  async removeAppPassword(name: string): Promise<void> {
    await this.request<{ data: unknown }>('/account/auth', {
      method: 'POST',
      body: JSON.stringify([{ type: 'removeAppPassword', name }]),
    });
  }

  /** GET /account/crypto - Fetch encryption-at-rest settings */
  async getCryptoInfo(): Promise<StalwartCryptoInfo> {
    const result = await this.request<{ data: StalwartCryptoInfo }>('/account/crypto');
    return result.data;
  }

  /** POST /account/crypto - Update encryption-at-rest settings */
  async updateCrypto(settings: { type: string; algo?: string; certs?: string }): Promise<void> {
    await this.request<{ data: unknown }>('/account/crypto', {
      method: 'POST',
      body: JSON.stringify(settings),
    });
  }

  /** GET /principal/{name} - Fetch principal details */
  async getPrincipal(name: string): Promise<StalwartPrincipal> {
    const result = await this.request<{ data: StalwartPrincipal }>(`/principal/${encodeURIComponent(name)}`);
    return result.data;
  }

  /** PATCH /principal/{name} - Update principal fields */
  async updatePrincipal(name: string, actions: PrincipalUpdateAction[]): Promise<void> {
    await this.request<{ data: unknown }>(`/principal/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(actions),
    });
  }

  /** Change password via PATCH /principal/{name} */
  async changePassword(name: string, newPassword: string): Promise<void> {
    await this.updatePrincipal(name, [
      { action: 'set', field: 'secrets', value: newPassword },
    ]);
  }

  /** Update display name via PATCH /principal/{name} */
  async updateDisplayName(name: string, displayName: string): Promise<void> {
    await this.updatePrincipal(name, [
      { action: 'set', field: 'description', value: displayName },
    ]);
  }
}

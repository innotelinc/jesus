import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StalwartClient } from '../stalwart/client';

function mockFetchResponse(status: number, body?: unknown): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('StalwartClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let client: StalwartClient;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    client = new StalwartClient('https://mail.example.com/', 'Basic dXNlcjpwYXNz');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('constructor', () => {
    it('strips trailing slash from server URL', () => {
      const c = new StalwartClient('https://mail.example.com/', 'Basic abc');
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: { otpEnabled: false, appPasswords: [] } }));
      c.getAuthInfo();
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://mail.example.com/api/account/auth',
        expect.anything()
      );
    });
  });

  describe('probe', () => {
    it('returns true when server responds with data field', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: { otpEnabled: false } }));
      const result = await client.probe();
      expect(result).toBe(true);
    });

    it('returns true when server returns 401 (API exists but needs auth)', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(401));
      const result = await client.probe();
      expect(result).toBe(true);
    });

    it('returns false when server returns 404', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(404));
      const result = await client.probe();
      expect(result).toBe(false);
    });

    it('returns false on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('Network error'));
      const result = await client.probe();
      expect(result).toBe(false);
    });

    it('returns false when response has no data field', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { something: 'else' }));
      const result = await client.probe();
      expect(result).toBe(false);
    });
  });

  describe('getAuthInfo', () => {
    it('returns auth info on success', async () => {
      const authInfo = { otpEnabled: true, isAdminApp: false, appPasswords: ['app1'] };
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: authInfo }));

      const result = await client.getAuthInfo();
      expect(result).toEqual(authInfo);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://mail.example.com/api/account/auth',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Basic dXNlcjpwYXNz',
          }),
        })
      );
    });

    it('throws on non-ok response', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(403, { detail: 'Forbidden' }));
      await expect(client.getAuthInfo()).rejects.toThrow('Forbidden');
    });

    it('throws with HTTP status when error body is unparseable', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('not json', { status: 500 }));
      await expect(client.getAuthInfo()).rejects.toThrow('HTTP 500');
    });
  });

  describe('enableTotp', () => {
    it('sends enableOtpAuth action and returns TOTP URL', async () => {
      const totpUrl = 'otpauth://totp/user@example.com?secret=ABC123';
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: totpUrl }));

      const result = await client.enableTotp();
      expect(result).toBe(totpUrl);

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(callBody).toEqual([{ type: 'enableOtpAuth' }]);
    });
  });

  describe('disableTotp', () => {
    it('sends disableOtpAuth action', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: null }));

      await client.disableTotp();

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(callBody).toEqual([{ type: 'disableOtpAuth' }]);
    });
  });

  describe('addAppPassword', () => {
    it('sends addAppPassword action with name and password', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: null }));

      await client.addAppPassword('Thunderbird', 'secret123');

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(callBody).toEqual([{ type: 'addAppPassword', name: 'Thunderbird', password: 'secret123' }]);
    });
  });

  describe('removeAppPassword', () => {
    it('sends removeAppPassword action with name', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: null }));

      await client.removeAppPassword('Thunderbird');

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(callBody).toEqual([{ type: 'removeAppPassword', name: 'Thunderbird' }]);
    });
  });

  describe('getCryptoInfo', () => {
    it('returns crypto info on success', async () => {
      const cryptoInfo = { type: 'pgp' as const };
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: cryptoInfo }));

      const result = await client.getCryptoInfo();
      expect(result).toEqual(cryptoInfo);
    });
  });

  describe('updateCrypto', () => {
    it('sends crypto settings', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: null }));

      await client.updateCrypto({ type: 'pgp' });

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(callBody).toEqual({ type: 'pgp' });
    });
  });

  describe('getPrincipal', () => {
    it('returns principal data on success', async () => {
      const principal = {
        id: 1, type: 'individual', name: 'testuser',
        description: 'Test User', emails: ['test@example.com'],
        secrets: [], quota: 1000000, roles: ['user'], lists: [],
      };
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: principal }));

      const result = await client.getPrincipal('testuser');
      expect(result).toEqual(principal);
    });

    it('encodes special characters in username', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: {} }));

      await client.getPrincipal('user@example.com');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://mail.example.com/api/principal/user%40example.com',
        expect.anything()
      );
    });
  });

  describe('updatePrincipal', () => {
    it('sends PATCH with action array', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: null }));

      await client.updatePrincipal('testuser', [
        { action: 'set', field: 'description', value: 'New Name' },
      ]);

      const call = fetchSpy.mock.calls[0];
      expect(call[0]).toBe('https://mail.example.com/api/principal/testuser');
      expect(call[1]?.method).toBe('PATCH');
      const body = JSON.parse(call[1]?.body as string);
      expect(body).toEqual([{ action: 'set', field: 'description', value: 'New Name' }]);
    });
  });

  describe('changePassword', () => {
    it('sends set secrets action via updatePrincipal', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: null }));

      await client.changePassword('testuser', 'newPassword123');

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body).toEqual([{ action: 'set', field: 'secrets', value: 'newPassword123' }]);
    });
  });

  describe('updateDisplayName', () => {
    it('sends set description action via updatePrincipal', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, { data: null }));

      await client.updateDisplayName('testuser', 'John Doe');

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body).toEqual([{ action: 'set', field: 'description', value: 'John Doe' }]);
    });
  });

  describe('request error handling', () => {
    it('parses error.detail from response body', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(400, { detail: 'Invalid request format' }));
      await expect(client.getAuthInfo()).rejects.toThrow('Invalid request format');
    });

    it('parses error.details from response body', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(400, { details: 'Bad stuff' }));
      await expect(client.getAuthInfo()).rejects.toThrow('Bad stuff');
    });

    it('parses error.error from response body', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(400, { error: 'Something wrong' }));
      await expect(client.getAuthInfo()).rejects.toThrow('Something wrong');
    });

    it('falls back to HTTP status code on non-JSON error', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('plain text', { status: 502 }));
      await expect(client.getAuthInfo()).rejects.toThrow('HTTP 502');
    });
  });
});

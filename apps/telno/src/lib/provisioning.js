import { config } from '../config.js';

/**
 * Provisioning templates.
 *
 * These are the two formats that cover most of the estate: Yealink key/value
 * `.cfg` and Grandstream XML. Both carry the SIP account, encryption settings
 * and the heartbeat endpoint, so a phone that boots from this file starts
 * checking in without anyone typing a token into it.
 */

export const PROVISION_FORMATS = ['yealink', 'grandstream'];

const publicBase = () => config.publicUrl.replace(/\/$/, '');
const sipHost = () => {
  try {
    return new URL(config.publicUrl).hostname;
  } catch {
    return 'localhost';
  }
};

function yealink({ device, extension, token }) {
  const lines = [
    '# Telno provisioning — Yealink',
    `# device: ${device.name} (${device.mac || 'no MAC on file'})`,
    '',
    device.label ? `account.1.label = ${device.label}` : null,
    extension
      ? [
          'account.1.enable = 1',
          `account.1.display_name = ${extension.display_name}`,
          `account.1.user_name = ${extension.extension}`,
          `account.1.auth_name = ${extension.extension}`,
          `account.1.password = ${extension.secret}`,
          `account.1.sip_server.1.address = ${sipHost()}`,
          'account.1.sip_server.1.port = 5061',
          '# TLS transport — plaintext SIP is refused while TLS is enforced.',
          'account.1.sip_server.1.transport = 1',
          'account.1.srtp = 1',
          'account.1.rtp.encryption = 1',
          '',
        ].join('\n')
      : '# No extension attached: this device is infrastructure-only.',
    '',
    '# Check-in: POST this token so the platform sees the handset come up.',
    `device.checkin.url = ${publicBase()}/api/devices/heartbeat`,
    `device.checkin.token = ${token}`,
    `device.checkin.interval = ${config.devices.checkInSec}`,
  ];
  return lines.filter((line) => line !== null).join('\n') + '\n';
}

function grandstream({ device, extension, token }) {
  const esc = (value) => String(value ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
  const account = extension
    ? `
      <P271>${esc(extension.extension)}</P271>
      <P270>1</P270>
      <P3>${esc(extension.display_name)}</P3>
      <P34>${esc(extension.extension)}</P34>
      <P35>${esc(extension.secret)}</P35>
      <P47>${esc(sipHost())}</P47>
      <P48>5061</P48>
      <P40>1</P40>
      <P1836>1</P1836>
      <P1841>1</P1841>`
    : '\n      <!-- No extension attached: infrastructure-only device. -->';
  return `<?xml version="1.0" encoding="UTF-8"?>
<gs_provision version="1">
  <config version="1">
    <P192>Telno</P192>
    <P150>${esc(device.name)}</P150>${account}
    <P140>${esc(`${publicBase()}/api/devices/heartbeat`)}</P140>
    <P141>${esc(token)}</P141>
    <P142>${config.devices.checkInSec}</P142>
  </config>
</gs_provision>
`;
}

export function buildProvisioning(format, payload) {
  if (format === 'grandstream') {
    return { fileName: `${slug(payload.device.name)}.xml`, contentType: 'application/xml', body: grandstream(payload) };
  }
  return { fileName: `${slug(payload.device.name)}.cfg`, contentType: 'text/plain', body: yealink(payload) };
}

const slug = (name) =>
  String(name || 'device')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'device';

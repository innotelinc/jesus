import { config } from '../config.js';

/**
 * Provisioning templates.
 *
 * These are the formats that cover most of the estate: Yealink key/value `.cfg`,
 * Grandstream XML and Polycom's XML. Each carries the SIP account, the check-in
 * endpoint and a fresh device token, so a phone that boots from this file starts
 * checking in without anyone typing anything into it.
 *
 * Two things are deliberate. The SIP server is `telno.tel` (the provisioning
 * domain), not the public web host, so the URI a handset registers as is
 * `sip:<extension>@telno.tel` — the same name the console shows. And the
 * transport is UDP 5060, which is the listener chan_pjsip actually has: an
 * earlier template pointed handsets at 5061/TLS, a port this switch never
 * opened, so a phone fetched a config and then failed to register with nothing
 * in the log to explain why.
 */

export const PROVISION_FORMATS = ['yealink', 'grandstream', 'polycom'];

const webBase = () => config.publicUrl.replace(/\/$/, '');
const sipHost = () => config.provisioning.sipDomain;
const sipPort = () => config.provisioning.sipPort;

/** The URL a handset should be given, by MAC, with no session involved. */
export function provisioningUrl(device, format = 'yealink') {
  const mac = String(device?.mac || '').replace(/[^A-Fa-f0-9]/g, '').toLowerCase();
  const ext = format === 'grandstream' ? 'xml' : 'cfg';
  return `${config.provisioning.baseUrl}/provision/${format}/${mac || 'unknown'}.${ext}`;
}

/** Where Option 66 (or "provisioning server") points on this deployment. */
export const provisioningServer = () => config.provisioning.baseUrl;

const label = (device) => String(device?.name || 'Telno').slice(0, 40);

function yealink({ device, extension, token }) {
  const lines = [
    '# Telno provisioning — Yealink',
    `# device: ${device.name} (${device.mac || 'no MAC on file'})`,
    '',
    `account.1.label = ${label(device)}`,
    extension
      ? [
          'account.1.enable = 1',
          `account.1.display_name = ${extension.display_name}`,
          `account.1.user_name = ${extension.extension}`,
          `account.1.auth_name = ${extension.extension}`,
          `account.1.password = ${extension.secret}`,
          `account.1.sip_server.1.address = ${sipHost()}`,
          `account.1.sip_server.1.port = ${sipPort()}`,
          '# 0 = UDP: this switch listens on 5060 for handsets.',
          'account.1.sip_server.1.transport = 0',
          '# SRTP stays off on the desk-phone endpoint; the encrypted line is the',
          '# WSS softphone, which negotiates DTLS per media stream.',
          'account.1.srtp = 0',
          'account.1.rtp.encryption = 0',
          `account.1.outbound_proxy.1.address = ${sipHost()}`,
        ].join('\n')
      : '# No extension attached: this device is infrastructure-only.',
    '',
    '# Check-in: POST this token so the platform sees the handset come up.',
    `device.checkin.url = ${webBase()}/api/devices/heartbeat`,
    `device.checkin.token = ${token}`,
    `device.checkin.interval = ${config.devices.checkInSec}`,
    'auto_provision.repeat.enable = 1',
    'auto_provision.repeat.minutes = 60',
  ];
  return lines.filter((line) => line !== null).join('\n') + '\n';
}

const esc = (value) =>
  String(value ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

function grandstream({ device, extension, token }) {
  const account = extension
    ? `
      <P271>${esc(extension.extension)}</P271>
      <P270>1</P270>
      <P3>${esc(extension.display_name)}</P3>
      <P34>${esc(extension.extension)}</P34>
      <P35>${esc(extension.secret)}</P35>
      <P47>${esc(sipHost())}</P47>
      <P48>${sipPort()}</P48>
      <P40>0</P40>
      <P1836>1</P1836>
      <P1841>0</P1841>`
    : '\n      <!-- No extension attached: infrastructure-only device. -->';
  return `<?xml version="1.0" encoding="UTF-8"?>
<gs_provision version="1">
  <config version="1">
    <P192>Telno</P192>
    <P150>${esc(device.name)}</P150>${account}
    <P140>${esc(`${webBase()}/api/devices/heartbeat`)}</P140>
    <P141>${esc(token)}</P141>
    <P142>${config.devices.checkInSec}</P142>
  </config>
</gs_provision>
`;
}

function polycom({ device, extension, token }) {
  const reg = extension
    ? `
      <reg reg.1.address="${esc(extension.extension)}" />
      <reg reg.1.auth.userId="${esc(extension.extension)}" />
      <reg reg.1.auth.password="${esc(extension.secret)}" />
      <reg reg.1.displayName="${esc(extension.display_name)}" />
      <reg reg.1.server.1.address="${esc(sipHost())}" />
      <reg reg.1.server.1.port="${sipPort()}" />
      <reg reg.1.server.1.transport="UDPonly" />`
    : '\n      <!-- No extension attached: infrastructure-only device. -->';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<polycomConfig xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <device device.set="1" device.dhcp.enabled="1" />
  <device device.name="${esc(label(device))}" />${reg}
  <apps apps.ucdesk.softkey.1.label="Telno" />
  <prov prov.polling.mode="abs" prov.polling.period="3600" />
</polycomConfig>
`;
}

export function buildProvisioning(format, payload) {
  if (format === 'grandstream') {
    return { fileName: `${slug(payload.device.name)}.xml`, contentType: 'application/xml', body: grandstream(payload) };
  }
  if (format === 'polycom') {
    return { fileName: `${slug(payload.device.name)}.cfg`, contentType: 'application/xml', body: polycom(payload) };
  }
  return { fileName: `${slug(payload.device.name)}.cfg`, contentType: 'text/plain', body: yealink(payload) };
}

const slug = (name) =>
  String(name || 'device')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'device';

/**
 * Generate a self-signed S/MIME test certificate (.p12) using pkijs.
 * Usage: npx tsx scripts/generate-test-cert.ts
 */
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const cryptoEngine = new pkijs.CryptoEngine({
  crypto: crypto,
  subtle: crypto.subtle,
  name: 'webcrypto',
});
pkijs.setEngine('gen', crypto, cryptoEngine);

function stringToAB(str: string): ArrayBuffer {
  const buf = new ArrayBuffer(str.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i);
  return buf;
}

async function main() {
  const email = process.argv[2] || 'test@example.com';
  const cn = email.split('@')[0];
  const p12Password = 'test';

  console.log(`Generating S/MIME certificate for ${email}...`);

  // Generate RSA key pair for signing
  const signKeyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );

  // Build self-signed certificate
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: Date.now() });

  // Issuer = Subject (self-signed)
  for (const name of [cert.issuer, cert.subject]) {
    name.typesAndValues.push(
      new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: cn }) }),
    );
    name.typesAndValues.push(
      new pkijs.AttributeTypeAndValue({ type: '2.5.4.10', value: new asn1js.Utf8String({ value: 'Test Org' }) }),
    );
  }
  // Email in subject
  cert.subject.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({ type: '1.2.840.113549.1.9.1', value: new asn1js.IA5String({ value: email }) }),
  );

  // Validity: 1 year
  cert.notBefore.value = new Date();
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 1);
  cert.notAfter.value = notAfter;

  // Import public key and sign
  await cert.subjectPublicKeyInfo.importKey(signKeyPair.publicKey, cryptoEngine);
  await cert.sign(signKeyPair.privateKey, 'SHA-256', cryptoEngine);

  // Export private key as PKCS#8
  const pkcs8Bytes = await crypto.subtle.exportKey('pkcs8', signKeyPair.privateKey);

  // Build PKCS#12
  const passwordBuf = stringToAB(p12Password);

  const keyBag = new pkijs.PKCS8ShroudedKeyBag({
    parsedValue: pkijs.PrivateKeyInfo.fromBER(pkcs8Bytes),
  });

  await keyBag.makeInternalValues({
    password: passwordBuf,
    contentEncryptionAlgorithm: {
      name: 'AES-CBC',
      length: 256,
    } as Parameters<typeof keyBag.makeInternalValues>[0]['contentEncryptionAlgorithm'],
    hmacHashAlgorithm: 'SHA-256',
    iterationCount: 100_000,
  });

  const keyBagSafe = new pkijs.SafeBag({
    bagId: '1.2.840.113549.1.12.10.1.2',
    bagValue: keyBag,
    bagAttributes: [
      new pkijs.Attribute({
        type: '1.2.840.113549.1.9.20', // friendlyName
        values: [new asn1js.BmpString({ value: cn })],
      }),
    ],
  });

  const certBagSafe = new pkijs.SafeBag({
    bagId: '1.2.840.113549.1.12.10.1.3',
    bagValue: new pkijs.CertBag({ parsedValue: cert }),
    bagAttributes: [
      new pkijs.Attribute({
        type: '1.2.840.113549.1.9.20',
        values: [new asn1js.BmpString({ value: cn })],
      }),
    ],
  });

  const authenticatedSafe = new pkijs.AuthenticatedSafe({
    parsedValue: {
      safeContents: [
        { privacyMode: 0, value: new pkijs.SafeContents({ safeBags: [keyBagSafe] }) },
        { privacyMode: 0, value: new pkijs.SafeContents({ safeBags: [certBagSafe] }) },
      ],
    },
  });

  await authenticatedSafe.makeInternalValues({ safeContents: [{}, {}] });

  const pfx = new pkijs.PFX({
    parsedValue: {
      integrityMode: 0,
      authenticatedSafe,
    },
  });

  await pfx.makeInternalValues({
    password: passwordBuf,
    iterations: 100_000,
    pbkdf2HashAlgorithm: 'SHA-256',
    hmacHashAlgorithm: 'SHA-256',
  });

  const p12Bytes = pfx.toSchema().toBER(false);

  // Also export the public cert as PEM
  const certDer = cert.toSchema(true).toBER(false);
  const certB64 = Buffer.from(certDer).toString('base64');
  const certPem = `-----BEGIN CERTIFICATE-----\n${certB64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

  const slug = email.replace(/[@.]/g, '-');
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'local-data');
  const p12Path = join(outDir, `${slug}.p12`);
  const pemPath = join(outDir, `${slug}-cert.pem`);

  writeFileSync(p12Path, Buffer.from(p12Bytes));
  writeFileSync(pemPath, certPem);

  console.log(`\nFiles written:`);
  console.log(`  ${p12Path}`);
  console.log(`  ${pemPath}`);
  console.log(`\nCredentials:`);
  console.log(`  Email:      ${email}`);
  console.log(`  CN:         ${cn}`);
  console.log(`  Password:   ${p12Password}`);
  console.log(`  Valid until: ${notAfter.toISOString().split('T')[0]}`);
}

main().catch(console.error);

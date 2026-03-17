/**
 * Debug script for TNEF parser — dumps raw attribute structure.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx tsx scripts/debug-tnef.ts <path-to-winmail.dat>');
  process.exit(1);
}

const data = new Uint8Array(readFileSync(resolve(inputPath)));

// TNEF attribute ID names
const ATTR_NAMES: Record<number, string> = {
  0x00069003: 'attMAPIProps',
  0x0002800C: 'attBody',
  0x00069002: 'attAttachRenddata',
  0x0006800F: 'attAttachData',
  0x00018010: 'attAttachTitle',
  0x00069005: 'attAttachment (MAPI)',
  0x00028005: 'attSubject',
  0x00068007: 'attMessageClass',
  0x00078006: 'attDateSent',
  0x00078008: 'attDateModified',
  0x0006900B: 'attRecipTable',
  0x00069001: 'attOwner',
  0x00060001: 'attFrom',
  0x00078004: 'attDateStart',
  0x0001800A: 'attMessageID',
  0x00050008: 'attPriority',
  0x00040009: 'attAidOwner',
  0x00010004: 'attConversationID',
  0x0001800D: 'attParentID',
  0x00018011: 'attAttachCreateDate',
  0x00018012: 'attAttachModifyDate',
  0x00060002: 'attDateRecd',
  0x00060003: 'attAssignedTo',
};

const MAPI_PROP_NAMES: Record<number, string> = {
  0x0037: 'PR_SUBJECT',
  0x1000: 'PR_BODY',
  0x1009: 'PR_RTF_COMPRESSED',
  0x1013: 'PR_BODY_HTML',
  0x1014: 'PR_BODY_CONTENT_ID', 
  0x0E1F: 'PR_RTF_IN_SYNC',
  0x3701: 'PR_ATTACH_DATA_BIN',
  0x3702: 'PR_ATTACH_ENCODING',
  0x3703: 'PR_ATTACH_EXTENSION',
  0x3704: 'PR_ATTACH_FILENAME',
  0x3707: 'PR_ATTACH_LONG_FILENAME',
  0x370E: 'PR_ATTACH_MIME_TAG',
  0x3712: 'PR_ATTACH_CONTENT_ID',
  0x0FF9: 'PR_RECORD_KEY',
  0x0FFE: 'PR_OBJECT_TYPE',
  0x3001: 'PR_DISPLAY_NAME',
  0x3002: 'PR_ADDRTYPE',
  0x3003: 'PR_EMAIL_ADDRESS',
};

const PROP_TYPE_NAMES: Record<number, string> = {
  0x0002: 'PT_SHORT',
  0x0003: 'PT_LONG',
  0x000B: 'PT_BOOLEAN',
  0x001E: 'PT_STRING8',
  0x001F: 'PT_UNICODE',
  0x0040: 'PT_SYSTIME',
  0x0048: 'PT_CLSID',
  0x0102: 'PT_BINARY',
  0x0014: 'PT_I8',
};

function pad4(len: number): number {
  return (4 - (len % 4)) % 4;
}

const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
let offset = 0;

function readU8() { return view.getUint8(offset++); }
function readU16() { const v = view.getUint16(offset, true); offset += 2; return v; }
function readU32() { const v = view.getUint32(offset, true); offset += 4; return v; }
function readBytes(n: number) { const s = data.slice(offset, offset + n); offset += n; return s; }

const sig = readU32();
console.log(`Signature: 0x${sig.toString(16)} (expected 0x223e9f78: ${sig === 0x223e9f78 ? 'OK' : 'MISMATCH'})`);
const key = readU16();
console.log(`Key: ${key}\n`);

let attrIndex = 0;
while (offset + 11 <= data.byteLength) {
  const level = readU8();
  const attrId = readU32();
  const attrLen = readU32();

  if (attrLen > data.byteLength - offset - 2) {
    console.log(`[${attrIndex}] TRUNCATED — level=${level} id=0x${attrId.toString(16)} len=${attrLen} (remaining=${data.byteLength - offset})`);
    break;
  }

  const attrData = readBytes(attrLen);
  const checksum = readU16();

  const levelStr = level === 1 ? 'MESSAGE' : level === 2 ? 'ATTACHMENT' : `LEVEL(${level})`;
  const attrName = ATTR_NAMES[attrId] || `0x${attrId.toString(16).padStart(8, '0')}`;

  console.log(`[${attrIndex}] ${levelStr} | ${attrName} | ${attrLen} bytes | checksum=0x${checksum.toString(16)}`);

  // Dump MAPI props if this is a MAPI attr
  if (attrId === 0x00069003 || attrId === 0x00069005) {
    const propView = new DataView(attrData.buffer, attrData.byteOffset, attrData.byteLength);
    let pOff = 0;
    if (attrData.byteLength >= 4) {
      const count = propView.getUint32(pOff, true); pOff += 4;
      console.log(`    MAPI props count: ${count}`);

      for (let i = 0; i < count && pOff + 4 <= attrData.byteLength; i++) {
        const propType = propView.getUint16(pOff, true); pOff += 2;
        const propId = propView.getUint16(pOff, true); pOff += 2;

        const baseType = propType & 0x0FFF;
        const isMulti = (propType & 0x1000) !== 0;
        const propName = MAPI_PROP_NAMES[propId] || `0x${propId.toString(16).padStart(4, '0')}`;
        const typeName = PROP_TYPE_NAMES[baseType] || `0x${baseType.toString(16).padStart(4, '0')}`;

        // Named props
        if (propId >= 0x8000) {
          if (pOff + 20 > attrData.byteLength) { console.log(`    [${i}] ${propName} (${typeName}) — TRUNCATED (named prop)`); break; }
          pOff += 16; // GUID
          const kind = propView.getUint32(pOff, true); pOff += 4;
          if (kind === 0) {
            if (pOff + 4 > attrData.byteLength) break;
            pOff += 4;
          } else {
            if (pOff + 4 > attrData.byteLength) break;
            const nl = propView.getUint32(pOff, true); pOff += 4;
            if (pOff + nl > attrData.byteLength) break;
            pOff += nl + pad4(nl);
          }
        }

        if (isMulti) {
          if (pOff + 4 > attrData.byteLength) break;
          const vc = propView.getUint32(pOff, true); pOff += 4;
          console.log(`    [${i}] ${propName} (${typeName} MV x${vc})`);
          for (let j = 0; j < vc; j++) {
            // skip values
            if (baseType === 0x001E || baseType === 0x001F || baseType === 0x0102) {
              if (pOff + 4 > attrData.byteLength) break;
              const vl = propView.getUint32(pOff, true); pOff += 4;
              pOff += vl + pad4(vl);
            } else if (baseType === 0x0040 || baseType === 0x0014) {
              pOff += 8;
            } else if (baseType === 0x0048) {
              pOff += 16;
            } else if (baseType === 0x0002) {
              pOff += 4;
            } else {
              pOff += 4;
            }
          }
        } else {
          let valuePreview = '';
          const savedOff = pOff;

          if (baseType === 0x0002) {
            if (pOff + 4 <= attrData.byteLength) {
              valuePreview = `value=${propView.getUint16(pOff, true)}`;
              pOff += 4; // padded
            }
          } else if (baseType === 0x0003 || baseType === 0x000B) {
            if (pOff + 4 <= attrData.byteLength) {
              valuePreview = `value=${propView.getUint32(pOff, true)}`;
              pOff += 4;
            }
          } else if (baseType === 0x0014 || baseType === 0x0040) {
            pOff += 8;
            valuePreview = '(8 bytes)';
          } else if (baseType === 0x0048) {
            pOff += 16;
            valuePreview = '(GUID)';
          } else if (baseType === 0x001E || baseType === 0x001F || baseType === 0x0102) {
            if (pOff + 4 <= attrData.byteLength) {
              const vl = propView.getUint32(pOff, true); pOff += 4;
              if (pOff + vl <= attrData.byteLength) {
                const raw = attrData.slice(pOff, pOff + vl);
                if (baseType === 0x001F) {
                  try { valuePreview = `"${new TextDecoder('utf-16le').decode(raw).slice(0, 120)}"`; } catch { valuePreview = `(${vl} bytes)`; }
                } else if (baseType === 0x001E) {
                  try { valuePreview = `"${new TextDecoder('utf-8').decode(raw).slice(0, 120)}"`; } catch { valuePreview = `(${vl} bytes)`; }
                } else {
                  valuePreview = `(${vl} bytes binary)`;
                  if (propId === 0x1013) {
                    try { valuePreview += ` preview="${new TextDecoder('utf-8').decode(raw).slice(0, 200)}"`; } catch { /* ignore decode errors */ }
                  }
                }
                pOff += vl + pad4(vl);
              } else {
                valuePreview = `(${vl} bytes — exceeds data)`;
                pOff = savedOff + 4;
              }
            }
          } else {
            if (pOff + 4 <= attrData.byteLength) {
              pOff += 4;
              valuePreview = '(4 bytes fixed)';
            }
          }

          console.log(`    [${i}] ${propName} (${typeName}) ${valuePreview}`);
        }
      }
    }
  }

  // Preview plain text body/attach title
  if (attrId === 0x0002800C || attrId === 0x00018010) {
    try {
      const preview = new TextDecoder('utf-8').decode(attrData.slice(0, Math.min(200, attrData.byteLength)));
      console.log(`    Preview: "${preview}"`);
    } catch { /* ignore decode errors */ }
  }

  attrIndex++;
}

console.log(`\nTotal attributes: ${attrIndex}`);

/**
 * zipBuilder.js — Pure JavaScript client-side ZIP generator
 * Zero external dependencies. Conforms to PKZIP 2.0 specification.
 * Fully compatible with Windows Explorer, macOS Archive Utility, 7-Zip, Linux unzip.
 */

// CRC-32 Table
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c >>> 0;
}

function computeCRC32(uint8Array) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < uint8Array.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ uint8Array[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Generate a ZIP Blob from an array of files.
 * @param {Array<{ name: string, data: Uint8Array|ArrayBuffer }>} files
 * @returns {Blob}
 */
export function createZip(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  const encoder = new TextEncoder();

  for (const file of files) {
    const cleanName = (file.name || 'file').replace(/\s+\./g, '.').trim();
    const nameBytes = encoder.encode(cleanName);
    const dataBytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const size = dataBytes.length;
    const crc = computeCRC32(dataBytes);

    // Local file header (30 bytes + name length)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Signature
    lv.setUint16(4, 20, true);         // Version needed (2.0)
    lv.setUint16(6, 0x0800, true);     // General purpose bit flag (UTF-8 enabled: bit 11)
    lv.setUint16(8, 0, true);          // Compression method (0 = store)
    lv.setUint16(10, 0, true);         // Mod time
    lv.setUint16(12, 0, true);         // Mod date
    lv.setUint32(14, crc, true);       // CRC-32
    lv.setUint32(18, size, true);      // Compressed size
    lv.setUint32(22, size, true);      // Uncompressed size
    lv.setUint16(26, nameBytes.length, true); // Filename length
    lv.setUint16(28, 0, true);         // Extra field length
    localHeader.set(nameBytes, 30);

    localHeaders.push(localHeader, dataBytes);

    // Central directory header (46 bytes + name length)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central directory header signature
    cv.setUint16(4, 20, true);         // Version made by
    cv.setUint16(6, 20, true);         // Version needed
    cv.setUint16(8, 0x0800, true);     // Flags (UTF-8)
    cv.setUint16(10, 0, true);        // Compression (0 = store)
    cv.setUint16(12, 0, true);        // Mod time
    cv.setUint16(14, 0, true);        // Mod date
    cv.setUint32(16, crc, true);      // CRC-32
    cv.setUint32(20, size, true);     // Compressed size
    cv.setUint32(24, size, true);     // Uncompressed size
    cv.setUint16(28, nameBytes.length, true); // Filename length
    cv.setUint16(30, 0, true);        // Extra field length
    cv.setUint16(32, 0, true);        // File comment length
    cv.setUint16(34, 0, true);        // Disk number start
    cv.setUint16(36, 0, true);        // Internal file attributes
    cv.setUint32(38, 0, true);        // External file attributes
    cv.setUint32(42, offset, true);   // Relative offset of local header
    centralHeader.set(nameBytes, 46);

    centralHeaders.push(centralHeader);

    offset += localHeader.length + size;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) {
    centralDirSize += ch.length;
  }

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD signature
  ev.setUint16(4, 0, true);          // Number of this disk
  ev.setUint16(6, 0, true);          // Disk with start of central directory
  ev.setUint16(8, files.length, true);  // Total entries on this disk
  ev.setUint16(10, files.length, true); // Total entries
  ev.setUint32(12, centralDirSize, true); // Central directory size
  ev.setUint32(16, centralDirOffset, true); // Offset of start of central directory
  ev.setUint16(20, 0, true);         // Comment length

  return new Blob([...localHeaders, ...centralHeaders, eocd], { type: 'application/zip' });
}

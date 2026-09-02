/**
 * CBZ writer -- a ZIP archive using the "store" method.
 *
 * Written here rather than pulled from a ZIP library for two reasons: MV3
 * forbids remote code so any library has to be vendored into the tree anyway,
 * and a store-only writer is small enough that vendoring one is the larger
 * cost. Storing rather than deflating is also the correct choice regardless --
 * JPEG and PNG data is already compressed, so deflate spends CPU on every page
 * to save almost nothing.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
// Bit 11 tells the reader that names are UTF-8; without it, non-ASCII series
// titles come out mojibake in most comic readers.
const FLAG_UTF8 = 0x0800;
const VERSION_STORE = 20;
const UINT32_MAX = 0xffffffff;

const encoder = new TextEncoder();

/** CRC-32 (IEEE), table built once on first use. */
let crcTable = null;
function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

export function crc32(bytes) {
  if (!crcTable) crcTable = buildCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Convert a JS Date into the DOS date/time pair ZIP headers use. */
export function dosDateTime(date = new Date()) {
  // The DOS epoch starts in 1980 and cannot represent anything earlier.
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/** Little-endian field writer over a growing chunk list. */
function header(size) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  return {
    bytes,
    u16(value) {
      view.setUint16(offset, value & 0xffff, true);
      offset += 2;
    },
    u32(value) {
      view.setUint32(offset, value >>> 0, true);
      offset += 4;
    },
  };
}

/**
 * Build a CBZ from ordered page entries.
 *
 * @param {Array<{name: string, data: Uint8Array}>} entries
 * @param {{ date?: Date }} [options]
 * @returns {Blob} image/vnd.comicbook+zip
 */
export function buildCbz(entries, { date = new Date(), format = 'cbz' } = {}) {
  if (!entries.length) throw new Error('Refusing to build an empty CBZ');

  const { time: dosTime, date: dosDate } = dosDateTime(date);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);

    const local = header(30);
    local.u32(LOCAL_SIG);
    local.u16(VERSION_STORE);
    local.u16(FLAG_UTF8);
    local.u16(0); // method 0 = store
    local.u16(dosTime);
    local.u16(dosDate);
    local.u32(crc);
    local.u32(data.length);
    local.u32(data.length);
    local.u16(nameBytes.length);
    local.u16(0); // no extra field

    chunks.push(local.bytes, nameBytes, data);

    const dir = header(46);
    dir.u32(CENTRAL_SIG);
    dir.u16(VERSION_STORE); // version made by
    dir.u16(VERSION_STORE); // version needed
    dir.u16(FLAG_UTF8);
    dir.u16(0);
    dir.u16(dosTime);
    dir.u16(dosDate);
    dir.u32(crc);
    dir.u32(data.length);
    dir.u32(data.length);
    dir.u16(nameBytes.length);
    dir.u16(0); // extra
    dir.u16(0); // comment
    dir.u16(0); // disk number
    dir.u16(0); // internal attributes
    dir.u32(0); // external attributes
    dir.u32(offset); // offset of local header
    central.push(dir.bytes, nameBytes);

    offset += local.bytes.length + nameBytes.length + data.length;
    // ZIP64 would be needed past this point. A single chapter never approaches
    // 4 GiB, so fail loudly rather than emit a silently corrupt archive.
    if (offset > UINT32_MAX) {
      throw new Error('Chapter is too large for a standard ZIP archive (4 GiB limit)');
    }
  }

  const centralStart = offset;
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);

  const eocd = header(22);
  eocd.u32(EOCD_SIG);
  eocd.u16(0); // this disk
  eocd.u16(0); // disk with central directory
  eocd.u16(entries.length);
  eocd.u16(entries.length);
  eocd.u32(centralSize);
  eocd.u32(centralStart);
  eocd.u16(0); // comment length

  return new Blob([...chunks, ...central, eocd.bytes], {
    type: format === 'zip' ? 'application/zip' : 'application/vnd.comicbook+zip',
  });
}

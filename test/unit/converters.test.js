import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCbz, crc32, dosDateTime } from '../../src/offscreen/convert/cbz.js';
import { buildPdf, inspectJpeg } from '../../src/offscreen/convert/pdf.js';

/**
 * A tiny but structurally valid baseline JPEG: SOI, APP0/JFIF, SOF0 declaring
 * 8x16 with 3 components, then EOI. Enough to exercise the header parser
 * without carrying a real image into the repository.
 */
function makeJpeg({ width = 8, height = 16, components = 3, marker = 0xc0 } = {}) {
  const sof = [
    0xff, marker,
    0x00, 8 + components * 3, // segment length
    0x08,                     // sample precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    components,
  ];
  for (let i = 0; i < components; i++) sof.push(i + 1, 0x11, 0x00);
  return new Uint8Array([
    0xff, 0xd8,             // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, minimal
    ...sof,
    0xff, 0xd9,             // EOI
  ]);
}

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

/* ----------------------------------- CBZ ---------------------------------- */

test('crc32 matches the standard check vector', () => {
  // "123456789" -> 0xCBF43926 is the documented CRC-32/ISO-HDLC check value.
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('dosDateTime clamps below the 1980 DOS epoch', () => {
  const { date } = dosDateTime(new Date('1975-01-01T00:00:00Z'));
  assert.equal(date >> 9, 0, 'year field should clamp to 1980');
});

test('CBZ has the right signatures, entry count and stored sizes', async () => {
  const a = new Uint8Array([1, 2, 3, 4, 5]);
  const b = new Uint8Array([9, 9]);
  const bytes = await bytesOf(buildCbz([{ name: '001.jpg', data: a }, { name: '002.jpg', data: b }]));
  const view = new DataView(bytes.buffer);

  assert.equal(view.getUint32(0, true), 0x04034b50, 'local file header signature');
  // End-of-central-directory sits in the last 22 bytes when there is no comment.
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, 'EOCD signature');
  assert.equal(view.getUint16(eocd + 10, true), 2, 'entry count');

  // Method 0 = store: the payload must appear verbatim, uncompressed.
  assert.equal(view.getUint16(8, true), 0, 'compression method is store');
  assert.equal(view.getUint32(18, true), a.length, 'compressed size equals raw size');
});

test('CBZ marks names as UTF-8 so non-ASCII titles survive', async () => {
  const bytes = await bytesOf(buildCbz([{ name: 'ตอน-001.jpg', data: new Uint8Array([1]) }]));
  const flags = new DataView(bytes.buffer).getUint16(6, true);
  assert.equal(flags & 0x0800, 0x0800, 'UTF-8 name flag must be set');
});

test('CBZ refuses to build nothing', () => {
  assert.throws(() => buildCbz([]), /empty CBZ/);
});

/* ----------------------------------- PDF ---------------------------------- */

test('inspectJpeg reads dimensions and component count', () => {
  assert.deepEqual(inspectJpeg(makeJpeg({ width: 700, height: 1140, components: 3 })), {
    width: 700,
    height: 1140,
    components: 3,
    progressive: false,
    adobe: false,
  });
  assert.equal(inspectJpeg(makeJpeg({ components: 1 })).components, 1);
  assert.equal(inspectJpeg(makeJpeg({ marker: 0xc2 })).progressive, true);
});

test('inspectJpeg rejects non-JPEG input', () => {
  assert.throws(() => inspectJpeg(new Uint8Array([0x89, 0x50])), /Not a JPEG/);
});

test('PDF embeds JPEG data byte-for-byte', async () => {
  // This is the whole point of the writer: no re-encoding, so the
  // original-quality setting survives into the finished file.
  const jpeg = makeJpeg({ width: 700, height: 1140 });
  const bytes = await bytesOf(buildPdf([{ data: jpeg }]));
  const haystack = Array.from(bytes).join(',');
  assert.ok(haystack.includes(Array.from(jpeg).join(',')), 'source JPEG must appear verbatim');
});

test('PDF is structurally well formed with correct object offsets', async () => {
  const bytes = await bytesOf(buildPdf([{ data: makeJpeg() }, { data: makeJpeg() }], { title: 'T' }));
  const text = new TextDecoder('latin1').decode(bytes);

  assert.ok(text.startsWith('%PDF-1.7'), 'header');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'trailer');

  const startxref = Number(text.match(/startxref\s+(\d+)/)[1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref', 'startxref points at the table');

  // Every xref entry must point at the object it claims to.
  const table = text.slice(startxref).split('\n');
  const count = Number(table[1].split(' ')[1]);
  for (let id = 1; id < count; id++) {
    const offset = Number(table[1 + id + 1].slice(0, 10));
    assert.ok(text.startsWith(`${id} 0 obj`, offset), `object ${id} offset is wrong`);
  }
});

test('PDF sizes each page to its image', async () => {
  const bytes = await bytesOf(buildPdf([{ data: makeJpeg({ width: 700, height: 1140 }) }]));
  const text = new TextDecoder('latin1').decode(bytes);
  assert.ok(text.includes('/MediaBox [0 0 700 1140]'));
});

test('PDF inverts Adobe CMYK, and leaves RGB alone', async () => {
  // An Adobe-marked CMYK JPEG is stored inverted; without /Decode it renders as
  // a photographic negative.
  const cmyk = makeJpeg({ components: 4 });
  const withApp14 = new Uint8Array([
    ...cmyk.slice(0, 2),
    0xff, 0xee, 0x00, 0x0e, ...new Array(12).fill(0), // APP14
    ...cmyk.slice(2),
  ]);
  const cmykText = new TextDecoder('latin1').decode(await bytesOf(buildPdf([{ data: withApp14 }])));
  assert.ok(cmykText.includes('/DeviceCMYK'));
  assert.ok(cmykText.includes('/Decode [1 0 1 0 1 0 1 0]'));

  const rgbText = new TextDecoder('latin1').decode(await bytesOf(buildPdf([{ data: makeJpeg() }])));
  assert.ok(rgbText.includes('/DeviceRGB'));
  assert.ok(!rgbText.includes('/Decode'), 'RGB pages must not be inverted');
});

test('PDF escapes metadata that would break string syntax', async () => {
  const text = new TextDecoder('latin1').decode(
    await bytesOf(buildPdf([{ data: makeJpeg() }], { title: 'a(b)c\\d' })),
  );
  assert.ok(text.includes('(a\\(b\\)c\\\\d)'));
});

test('PDF refuses to build nothing', () => {
  assert.throws(() => buildPdf([]), /empty PDF/);
});

/**
 * PDF writer that embeds JPEG data directly.
 *
 * The point of this module is that it does NOT re-encode. A JPEG is copied into
 * the PDF as a DCTDecode stream exactly as it arrived from the CDN, so the
 * "original quality" setting survives all the way to the finished file. Routing
 * pages through a canvas -- the usual approach, and what a general-purpose PDF
 * library does unless carefully steered -- would decode and re-compress every
 * page, silently undoing that.
 *
 * Only JPEG input is accepted. Callers normalise other formats first (see
 * offscreen.js), which keeps this module free of any DOM dependency and
 * therefore testable outside a browser.
 */

const encoder = new TextEncoder();
const latin1 = (text) => {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
};

/* ---------------------------- JPEG inspection ---------------------------- */

// Start-of-frame markers. C0 baseline, C1 extended, C2 progressive, and the
// arithmetic-coded variants. C4/C8/CC are not frames despite being in range.
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * Read dimensions and component count straight out of the JPEG frame header.
 *
 * @returns {{width: number, height: number, components: number, progressive: boolean, adobe: boolean}}
 */
export function inspectJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Not a JPEG (missing SOI marker)');
  }
  let offset = 2;
  let adobe = false;

  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;

    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) break; // EOI, or start of scan data

    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2) throw new Error('Malformed JPEG segment length');

    if (marker === 0xee) adobe = true; // APP14, signals a CMYK transform

    if (SOF_MARKERS.has(marker)) {
      if (offset + 7 > bytes.length) throw new Error('Truncated JPEG frame header');
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
        components: bytes[offset + 7],
        progressive: marker === 0xc2 || marker === 0xca,
        adobe,
      };
    }
    offset += length;
  }
  throw new Error('No JPEG frame header found');
}

function colorSpaceFor(components) {
  if (components === 1) return '/DeviceGray';
  if (components === 3) return '/DeviceRGB';
  if (components === 4) return '/DeviceCMYK';
  throw new Error(`Unsupported JPEG component count: ${components}`);
}

/* ------------------------------ PDF assembly ----------------------------- */

/**
 * Build a PDF, one page per image, each page sized to its image.
 *
 * Pages are sized in PDF points at 72 dpi so a long webtoon strip stays one
 * tall page rather than being sliced across sheets, which is what makes the
 * result readable by scrolling.
 *
 * @param {Array<{data: Uint8Array, width?: number, height?: number}>} images
 * @param {{title?: string, author?: string}} [meta]
 * @returns {Blob} application/pdf
 */
export function buildPdf(images, meta = {}) {
  if (!images.length) throw new Error('Refusing to build an empty PDF');

  const chunks = [];
  let length = 0;
  const push = (part) => {
    const bytes = typeof part === 'string' ? latin1(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };

  // Object 0 is the free-list head and never written; offsets[n] is the byte
  // position of object n, which the xref table needs to be exact.
  const offsets = [0];
  let nextId = 1;
  const allocate = () => nextId++;

  const catalogId = allocate();
  const pagesId = allocate();
  const infoId = allocate();

  const pageIds = [];
  const pageObjects = [];

  for (const image of images) {
    const info = inspectJpeg(image.data);
    const width = image.width || info.width;
    const height = image.height || info.height;
    const pageId = allocate();
    const imageId = allocate();
    const contentId = allocate();
    pageIds.push(pageId);
    pageObjects.push({ pageId, imageId, contentId, width, height, info, data: image.data });
  }

  const beginObject = (id, body) => {
    offsets[id] = length;
    push(`${id} 0 obj\n${body}\n`);
  };

  push('%PDF-1.7\n');
  // A comment of high bytes marks the file as binary, so tools that sniff
  // text-vs-binary do not mangle the streams on transfer.
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  beginObject(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>\nendobj`);
  beginObject(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>\nendobj`,
  );

  const escapeText = (value) =>
    String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
  beginObject(
    infoId,
    `<< /Title (${escapeText(meta.title)}) /Author (${escapeText(meta.author)}) /Producer (Downloade-Webtoon) >>\nendobj`,
  );

  for (const page of pageObjects) {
    const { pageId, imageId, contentId, width, height, info, data } = page;

    beginObject(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj`,
    );

    // Adobe-marked CMYK JPEGs are stored inverted; /Decode flips them back.
    // Without this, four-colour pages render as photographic negatives.
    const decode = info.components === 4 && info.adobe ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
    offsets[imageId] = length;
    push(
      `${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${info.width} ` +
        `/Height ${info.height} /ColorSpace ${colorSpaceFor(info.components)} ` +
        `/BitsPerComponent 8 /Filter /DCTDecode${decode} /Length ${data.length} >>\nstream\n`,
    );
    push(data);
    push('\nendstream\nendobj\n');

    // Place the image to exactly fill the page box.
    const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
    const contentBytes = encoder.encode(content);
    offsets[contentId] = length;
    push(`${contentId} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
    push(contentBytes);
    push('\nendstream\nendobj\n');
  }

  const xrefStart = length;
  const total = nextId;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let id = 1; id < total; id++) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${total} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n` +
      `startxref\n${xrefStart}\n%%EOF\n`,
  );

  return new Blob(chunks, { type: 'application/pdf' });
}

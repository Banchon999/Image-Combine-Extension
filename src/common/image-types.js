/** Recognize supported plain image signatures; this never decrypts a payload. */
export function detectImageMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'GIF8') return 'image/gif';
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  const brand = String.fromCharCode(...bytes.slice(4, 12));
  if (brand.startsWith('ftypavif') || brand.startsWith('ftypavis')) return 'image/avif';
  return '';
}

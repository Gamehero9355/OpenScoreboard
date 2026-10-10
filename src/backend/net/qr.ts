/**
 * QR codes are rendered locally by the bundled `qrcode` library -- never by an
 * internet service -- so scanning works with the network cable unplugged.
 */
import QRCode from 'qrcode';

const svgCache = new Map<string, string>();
const pngCache = new Map<string, string>();
const MAX_CACHE = 64;

function remember(cache: Map<string, string>, key: string, value: string): string {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

export interface QrOptions {
  /** Quiet zone in modules. */
  margin?: number;
  /** Error correction level. */
  level?: 'L' | 'M' | 'Q' | 'H';
}

export async function qrSvg(text: string, options: QrOptions = {}): Promise<string> {
  const key = `${text}|${options.margin ?? 1}|${options.level ?? 'M'}`;
  const cached = svgCache.get(key);
  if (cached) return cached;
  const svg = await QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: options.level ?? 'M',
    margin: options.margin ?? 1,
    width: 512,
    color: { dark: '#000000', light: '#ffffff' },
  });
  return remember(svgCache, key, svg);
}

export async function qrPngDataUrl(text: string, width = 512, options: QrOptions = {}): Promise<string> {
  const key = `${text}|${width}|${options.margin ?? 1}|${options.level ?? 'M'}`;
  const cached = pngCache.get(key);
  if (cached) return cached;
  const dataUrl = await QRCode.toDataURL(text, {
    errorCorrectionLevel: options.level ?? 'M',
    margin: options.margin ?? 1,
    width,
    color: { dark: '#000000', light: '#ffffff' },
  });
  return remember(pngCache, key, dataUrl);
}

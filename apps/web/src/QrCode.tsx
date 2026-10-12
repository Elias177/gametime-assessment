import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

const QUIET_ZONE = 4;

/** True when `url` points at this machine itself (localhost, 127.x, ::1), which no other device can open. */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true; // not a URL anyone could scan
  }
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** `text` as a QR code, drawn as one SVG path. Always dark on white, so a phone can read it in dark mode too. */
export function QrCode({ text, label, size = 128 }: { text: string; label: string; size?: number }) {
  const { path, modules } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
      }
    }
    return { path: d, modules: count + QUIET_ZONE * 2 };
  }, [text]);

  return (
    <svg
      className="qr"
      data-testid="phone-qr"
      data-value={text}
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
    >
      <rect width={modules} height={modules} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

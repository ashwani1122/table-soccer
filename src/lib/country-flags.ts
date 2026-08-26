import * as countryFlagSvgs from "country-flag-icons/string/3x2";

const flagDataUrls = new Map<string, string>();
const flags = countryFlagSvgs as Record<string, string>;

export function countryFlagDataUrl(countryCode: string) {
  const code = countryCode.toUpperCase();
  const cached = flagDataUrls.get(code);
  if (cached) return cached;

  const svg = flags[code];
  if (!svg) return null;
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  flagDataUrls.set(code, dataUrl);
  return dataUrl;
}

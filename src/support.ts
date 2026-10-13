export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env[name] ?? "").trim().toLowerCase(),
  );
}

export function envInt(name: string, fallback: number, minimum = 0): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < minimum) {
    console.warn(`Warning: Invalid ${name} value '${raw}', using ${fallback}`);
    return fallback;
  }
  return value;
}

export function envFloat(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    console.warn(`Warning: Invalid ${name} value '${raw}', using ${fallback}`);
    return fallback;
  }
  return value;
}

export function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Canonicalize a URL for cache keys and dedupe: lowercase host, drop fragment. */
export function canonicalUrl(raw: string): string {
  const parsed = new URL(raw);
  const host = parsed.hostname.toLowerCase();
  const defaultPort =
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443");
  const netloc = defaultPort ? host : host + (parsed.port ? `:${parsed.port}` : "");
  return `${parsed.protocol.toLowerCase()}//${netloc}${parsed.pathname || "/"}${parsed.search}`;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|nbsp);|&#(?:39|x27);/g, (m) => ENTITIES[m] ?? m);
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).trim();
}

export function collapseSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

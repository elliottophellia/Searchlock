import { envFlag, envFloat, envInt, envList } from "./support.ts";

export interface SearchlockConfig {
  safesearch: "off" | "moderate" | "strict";
  ddgRegion: string;
  braveCountry: string;
  braveLanguage: string;
  ddgSearchRpm: number;
  fetchRpm: number;
  fetchHostRpm: number;
  rateStrategy: string;
  parseMode: "text" | "main" | "markdown";
  cacheTtlSec: number;
  cacheMax: number;
  refThreshold: number;
  braveTimeoutMs: number;
  braveMaxRetries: number;
  braveProxies: string[];
  allowPrivate: boolean;
}

function safesearch(): SearchlockConfig["safesearch"] {
  const value = (process.env["SEARCHLOCK_SAFESEARCH"] ?? "moderate").trim().toLowerCase();
  if (value === "off" || value === "strict" || value === "moderate") return value;
  console.warn(`Warning: Invalid SEARCHLOCK_SAFESEARCH value '${value}', using moderate`);
  return "moderate";
}

function parseMode(): SearchlockConfig["parseMode"] {
  const value = (process.env["SEARCHLOCK_PARSE_MODE"] ?? "text").trim().toLowerCase();
  if (value === "text" || value === "main" || value === "markdown") return value;
  console.warn(`Warning: Invalid SEARCHLOCK_PARSE_MODE value '${value}', using text`);
  return "text";
}

function strategy(): string {
  const value = (process.env["SEARCHLOCK_RATE_LIMIT_STRATEGY"] ?? "sliding").trim().toLowerCase();
  if (value === "sliding" || value === "token_bucket") return value;
  console.warn(`Warning: Invalid SEARCHLOCK_RATE_LIMIT_STRATEGY value '${value}', using sliding`);
  return "sliding";
}

export function loadConfig(): SearchlockConfig {
  return {
    safesearch: safesearch(),
    ddgRegion: (process.env["SEARCHLOCK_DDG_REGION"] ?? "").trim(),
    braveCountry: (process.env["SEARCHLOCK_BRAVE_COUNTRY"] ?? "us").trim() || "us",
    braveLanguage: (process.env["SEARCHLOCK_BRAVE_LANGUAGE"] ?? "en").trim() || "en",
    ddgSearchRpm: envInt("SEARCHLOCK_SEARCH_RPM", 30, 1),
    fetchRpm: envInt("SEARCHLOCK_FETCH_RPM", 20, 1),
    fetchHostRpm: envInt("SEARCHLOCK_FETCH_HOST_RPM", 0, 0),
    rateStrategy: strategy(),
    parseMode: parseMode(),
    cacheTtlSec: envInt("SEARCHLOCK_CACHE_TTL", 300, 0),
    cacheMax: envInt("SEARCHLOCK_CACHE_MAX_ENTRIES", 64, 0),
    refThreshold: envInt("SEARCHLOCK_REF_URL_THRESHOLD", 120, 0),
    braveTimeoutMs: Math.floor(envFloat("SEARCHLOCK_BRAVE_TIMEOUT", 120) * 1000),
    braveMaxRetries: envInt("SEARCHLOCK_BRAVE_MAX_RETRIES", 3, 0),
    braveProxies: envList("SEARCHLOCK_PROXY_LIST"),
    allowPrivate: envFlag("SEARCHLOCK_ALLOW_PRIVATE_URLS"),
  };
}

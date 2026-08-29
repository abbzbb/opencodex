export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

export type LoopbackOriginParse =
  | { ok: true; origin: string; host: LoopbackHost; scheme: "http" | "https"; port: number }
  | { ok: false; message: string };

const MAX_ORIGIN_LENGTH = 253;
const ASCII_PRINTABLE_NO_SPACE = /^[\x21-\x7E]+$/;

function fail(message: string): LoopbackOriginParse {
  return { ok: false, message };
}

function normalizeHextet(part: string): number | undefined {
  if (part.length === 0 || part.length > 4 || /[^0-9a-fA-F]/.test(part)) {
    return undefined;
  }
  return Number.parseInt(part, 16);
}

function expandIpv6(host: string): number[] | undefined {
  if (host.includes(".") || host.includes("%") || /[^0-9a-fA-F:]/.test(host)) {
    return undefined;
  }
  if (host.includes("::")) {
    const pieces = host.split("::");
    if (pieces.length !== 2) {
      return undefined;
    }
    const left = pieces[0] === "" ? [] : pieces[0].split(":");
    const right = pieces[1] === "" ? [] : pieces[1].split(":");
    const missing = 8 - left.length - right.length;
    if (missing < 0) {
      return undefined;
    }
    if (missing === 0 && left.length + right.length !== 8) {
      return undefined;
    }
    const parts = [...left, ...Array(missing).fill("0"), ...right];
    if (parts.length !== 8) {
      return undefined;
    }
    const nums: number[] = [];
    for (const part of parts) {
      const value = part === "0" ? 0 : normalizeHextet(part);
      if (value === undefined) {
        return undefined;
      }
      nums.push(value);
    }
    return nums;
  }
  const parts = host.split(":");
  if (parts.length !== 8) {
    return undefined;
  }
  const nums: number[] = [];
  for (const part of parts) {
    const value = normalizeHextet(part);
    if (value === undefined) {
      return undefined;
    }
    nums.push(value);
  }
  return nums;
}

function isIpv6Loopback(hostname: string): boolean {
  const expanded = expandIpv6(hostname);
  return expanded !== undefined && expanded.join(".") === "0.0.0.0.0.0.0.1";
}

function isLoopbackHost(value: string): boolean {
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || isIpv6Loopback(value);
}

function rawAuthorityHostname(input: string): string | undefined {
  const authority = input.slice(input.indexOf("://") + 3);
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0 || (authority.slice(close + 1) !== "" && !/^:\d+$/.test(authority.slice(close + 1)))) {
      return undefined;
    }
    return authority.slice(1, close);
  }
  const colon = authority.lastIndexOf(":");
  return (colon < 0 ? authority : authority.slice(0, colon)).toLowerCase();
}

function urlHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname.toLowerCase();
}

function rejectForbiddenUrlTokens(input: string): string | undefined {
  if (input.includes("@")) {
    return "origin must not include credentials";
  }
  if (input.includes("?")) {
    return "origin must not include a query";
  }
  if (input.includes("#")) {
    return "origin must not include a fragment";
  }
  if (input.includes("\\")) {
    return "origin must not include a backslash";
  }
  if (input.includes("*")) {
    return "origin must not include a wildcard";
  }
  return undefined;
}

function rejectExplicitPath(input: string): string | undefined {
  const schemeSep = input.indexOf("://");
  if (schemeSep <= 0) {
    return "origin must be an absolute http(s) URL";
  }
  const afterScheme = input.slice(schemeSep + 3);
  if (afterScheme.length === 0) {
    return "origin host is missing";
  }
  if (afterScheme.includes("/") || afterScheme.includes("\\")) {
    return "origin must not include a path";
  }
  return undefined;
}

function canonicalHost(hostname: string): string {
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return hostname;
  }
  return "[::1]";
}

/**
 * Accept only localhost / 127.0.0.1 / ::1 loopback origins after URL
 * normalization. Reject wildcard, LAN, credentials, path, query, and fragment.
 */
export function parseLoopbackOrigin(input: unknown): LoopbackOriginParse {
  if (typeof input !== "string") {
    return fail("origin must be a string");
  }
  if (input.length === 0 || input.length > MAX_ORIGIN_LENGTH) {
    return fail("origin length is invalid");
  }
  if (!ASCII_PRINTABLE_NO_SPACE.test(input)) {
    return fail("origin must be ASCII without whitespace");
  }

  const forbidden = rejectForbiddenUrlTokens(input);
  if (forbidden) {
    return fail(forbidden);
  }
  const pathError = rejectExplicitPath(input);
  if (pathError) {
    return fail(pathError);
  }
  const rawHostname = rawAuthorityHostname(input);
  if (!rawHostname || !isLoopbackHost(rawHostname)) {
    return fail("origin host must be localhost, 127.0.0.1, or ::1");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail("origin is not a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("origin scheme must be http or https");
  }
  if (input.includes("localhost.") || input.includes("127.0.0.1.")) {
    return fail("origin host must be localhost, 127.0.0.1, or ::1");
  }
  if (url.username !== "" || url.password !== "") {
    return fail("origin must not include credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    return fail("origin must not include query or fragment");
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    return fail("origin must not include a path");
  }
  const hostname = urlHostname(url);
  if (!isLoopbackHost(hostname)) {
    return fail("origin host must be localhost, 127.0.0.1, or ::1");
  }

  const scheme: "http" | "https" = url.protocol === "https:" ? "https" : "http";
  const portText = url.port === "" ? (scheme === "https" ? "443" : "80") : url.port;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fail("origin port is invalid");
  }

  const host: LoopbackHost =
    hostname === "localhost" || hostname === "127.0.0.1" ? hostname : "::1";
  const origin = `${scheme}://${canonicalHost(hostname)}:${port}`;
  return { ok: true, origin, host, scheme, port };
}

export function isLoopbackOrigin(input: unknown): input is string {
  return parseLoopbackOrigin(input).ok;
}

export function normalizeLoopbackOrigin(input: unknown): string | undefined {
  const parsed = parseLoopbackOrigin(input);
  return parsed.ok ? parsed.origin : undefined;
}

import { describe, expect, test } from "bun:test";
import {
  isLoopbackOrigin,
  LOOPBACK_HOSTS,
  normalizeLoopbackOrigin,
  parseLoopbackOrigin,
} from "../runtime/origin";

describe("loopback origin helper", () => {
  test("allowlist is localhost, 127.0.0.1, and ::1", () => {
    expect([...LOOPBACK_HOSTS]).toEqual(["localhost", "127.0.0.1", "::1"]);
  });

  test("accepts normalized http(s) loopback origins and rewrites case/port defaults", () => {
    const accepted: Array<[string, string]> = [
      ["http://localhost:10100", "http://localhost:10100"],
      ["http://127.0.0.1:10100", "http://127.0.0.1:10100"],
      ["http://[::1]:10100", "http://[::1]:10100"],
      ["https://localhost:10100", "https://localhost:10100"],
      ["https://127.0.0.1:8443", "https://127.0.0.1:8443"],
      ["https://[::1]:8443", "https://[::1]:8443"],
      ["HTTP://LOCALHOST:10100", "http://localhost:10100"],
      ["http://localhost", "http://localhost:80"],
      ["https://127.0.0.1", "https://127.0.0.1:443"],
      ["http://[0:0:0:0:0:0:0:1]:10100", "http://[::1]:10100"],
    ];
    for (const [input, canonical] of accepted) {
      const parsed = parseLoopbackOrigin(input);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.origin).toBe(canonical);
      }
      expect(isLoopbackOrigin(input)).toBe(true);
      expect(normalizeLoopbackOrigin(input)).toBe(canonical);
    }
  });

  test("rejects wildcard, LAN, credentials, path, query, and fragment", () => {
    const rejected = [
      "http://0.0.0.0:10100",
      "http://[::]:10100",
      "http://[::0]:10100",
      "http://*:10100",
      "http://192.168.1.10:10100",
      "http://10.0.0.1:10100",
      "http://172.16.1.2:10100",
      "http://opencodex.local:10100",
      "http://example.com:10100",
      "http://[2001:db8::1]:10100",
      "http://[::ffff:127.0.0.1]:10100",
      "http://user:pass@127.0.0.1:10100",
      "http://user@localhost:10100",
      "http://127.0.0.1:10100/dashboard",
      "http://localhost:10100/",
      "http://localhost:10100/index.html",
      "http://127.0.0.1:10100?x=1",
      "http://127.0.0.1:10100#frag",
      "http://localhost:10100#",
      "http://localhost:10100?",
      "ws://localhost:10100",
      "file://localhost/tmp",
      "localhost:10100",
      "//localhost:10100",
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
      "http://localhost.:10100",
      "http://127.0.0.1.:10100",
      "http://127.1:10100",
      "http://[::1%eth0]:10100",
      "https://localhost:10100/path?q=1#h",
    ];
    for (const input of rejected) {
      expect(parseLoopbackOrigin(input).ok).toBe(false);
      expect(isLoopbackOrigin(input)).toBe(false);
      expect(normalizeLoopbackOrigin(input)).toBeUndefined();
    }
  });

  test("rejects non-strings, whitespace, and empty values", () => {
    expect(parseLoopbackOrigin(null).ok).toBe(false);
    expect(parseLoopbackOrigin(10100).ok).toBe(false);
    expect(parseLoopbackOrigin("").ok).toBe(false);
    expect(parseLoopbackOrigin(" http://localhost:10100").ok).toBe(false);
    expect(parseLoopbackOrigin("http://localhost:10100 ").ok).toBe(false);
    expect(parseLoopbackOrigin("http://localhost:10100\n").ok).toBe(false);
  });
});

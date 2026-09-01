import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTHORITATIVE_RELOAD_COMMAND,
  inspectReloadGenerationTransport,
  PROBE_A_RELOAD_GENERATION_KEYS,
  validateProbeAReloadGenerationSummary,
} from "../scripts/probe-a-reload-generation";

describe("Probe A reload-generation source sentinel", () => {
  test("summary is a closed source-sentinel and refuses physical WebView claims", () => {
    const summary = inspectReloadGenerationTransport();
    expect(Object.keys(summary).sort()).toEqual([...PROBE_A_RELOAD_GENERATION_KEYS].sort());
    expect(validateProbeAReloadGenerationSummary(summary)).toEqual(summary);
    expect(summary.kind).toBe("source-sentinel");
    expect(summary.authoritativeCommand).toBe(AUTHORITATIVE_RELOAD_COMMAND);
    expect(summary.physicalWebviewEvidence).toBe(false);
    expect(summary.windowsWebView2NavigateFinished).toBe(false);
    expect(summary.sourceFragmentBuilder).toBe(false);
    expect(() =>
      validateProbeAReloadGenerationSummary({ ...summary, physicalWebviewEvidence: true }),
    ).toThrow();
    expect(() =>
      validateProbeAReloadGenerationSummary({ ...summary, extra: true }),
    ).toThrow();
    expect(() =>
      validateProbeAReloadGenerationSummary({ ...summary, kind: "cargo-proof" }),
    ).toThrow();
  });

  test("sentinel inspects sources and does not substitute for cargo tests", () => {
    const script = readFileSync(
      join(import.meta.dir, "../scripts/probe-a-reload-generation.ts"),
      "utf8",
    );
    expect(script).toContain(AUTHORITATIVE_RELOAD_COMMAND);
    expect(script).toContain("source-sentinel");
    expect(script).not.toContain("queryTransport");
    const navigation = readFileSync(
      join(import.meta.dir, "../src-tauri/src/navigation.rs"),
      "utf8",
    );
    const start = navigation.indexOf("fn canonical_app_local_reload_url_for");
    const end = navigation.indexOf("pub fn canonical_app_local_reload_url(");
    const builder = navigation.slice(start, end);
    expect(builder).toContain("set_query");
    expect(builder).toContain("canonical_reload_generation");
    expect(builder).not.toContain("query_pairs");
    expect(builder).not.toContain("set_fragment");
    expect(navigation).toContain('RELOAD_QUERY_KEY: &str = "ocx-reload"');
    const classifyStart = navigation.indexOf("fn classify_retry_query");
    const classifyEnd = navigation.indexOf("pub fn classify_canonical_page_url_for");
    const classify = navigation.slice(classifyStart, classifyEnd);
    expect(classify).toContain("url.query()");
    expect(classify).toContain("hyphenated()");
    expect(classify).not.toContain("query_pairs");
  });
});

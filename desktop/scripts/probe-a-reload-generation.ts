#!/usr/bin/env bun
/**
 * Source-sentinel for Desktop reload-generation transport.
 *
 * This inspects committed Desktop sources and fails if expected strings are
 * absent. It does **not** execute Rust URL classification, WebView navigation,
 * or Tauri PageLoadEvent::Finished. Authoritative URL/state behavior is
 * `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib`.
 *
 * Physical WebView evidence stays false.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AUTHORITATIVE_RELOAD_COMMAND =
  "cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib";

export const PROBE_A_RELOAD_GENERATION_KEYS = [
  "schemaVersion",
  "kind",
  "authoritativeCommand",
  "sourceQueryBuilder",
  "sourceFragmentBuilder",
  "sourceConsecutiveGenerationTest",
  "sourcePayloadUrlClassification",
  "physicalWebviewEvidence",
  "windowsWebView2NavigateFinished",
] as const;

export type ProbeAReloadGenerationSummary = {
  schemaVersion: 1;
  kind: "source-sentinel";
  authoritativeCommand: typeof AUTHORITATIVE_RELOAD_COMMAND;
  sourceQueryBuilder: boolean;
  sourceFragmentBuilder: boolean;
  sourceConsecutiveGenerationTest: boolean;
  sourcePayloadUrlClassification: boolean;
  physicalWebviewEvidence: false;
  windowsWebView2NavigateFinished: false;
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readDesktop(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

export function inspectReloadGenerationTransport(): ProbeAReloadGenerationSummary {
  const navigation = readDesktop("src-tauri/src/navigation.rs");
  const lib = readDesktop("src-tauri/src/lib.rs");
  const start = navigation.indexOf("fn canonical_app_local_reload_url_for");
  const end = navigation.indexOf("pub fn canonical_app_local_reload_url(");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("reload URL builder not found");
  }
  const builder = navigation.slice(start, end);
  const pageLoadStart = lib.indexOf("fn create_main_window");
  const pageLoadEnd = lib.indexOf("fn has_published_runtime");
  if (pageLoadStart < 0 || pageLoadEnd < 0 || pageLoadEnd <= pageLoadStart) {
    throw new Error("create_main_window not found");
  }
  const pageLoad = lib.slice(pageLoadStart, pageLoadEnd);

  const classifyStart = navigation.indexOf("fn classify_retry_query");
  const classifyEnd = navigation.indexOf("pub fn classify_canonical_page_url_for");
  if (classifyStart < 0 || classifyEnd < 0 || classifyEnd <= classifyStart) {
    throw new Error("classify_retry_query not found");
  }
  const classify = navigation.slice(classifyStart, classifyEnd);
  if (!classify.includes("url.query()")) {
    throw new Error("source sentinel: classify_retry_query must use url.query()");
  }
  if (classify.includes("query_pairs")) {
    throw new Error("source sentinel: classify_retry_query uses query_pairs");
  }

  const sourceQueryBuilder =
    navigation.includes('RELOAD_QUERY_KEY: &str = "ocx-reload"') &&
    builder.includes("set_query") &&
    builder.includes("canonical_reload_generation") &&
    !builder.includes("query_pairs");
  const sourceFragmentBuilder = builder.includes("set_fragment");
  const sourceConsecutiveGenerationTest = navigation.includes(
    "fn consecutive_reload_generations_are_distinct_query_documents",
  );
  const sourcePayloadUrlClassification =
    pageLoad.includes("classify_canonical_page_url(payload.url())") &&
    !pageLoad.includes("webview.url()");

  if (!sourceQueryBuilder) {
    throw new Error("source sentinel: query reload builder missing");
  }
  if (sourceFragmentBuilder) {
    throw new Error("source sentinel: fragment reload builder present");
  }
  if (!sourceConsecutiveGenerationTest) {
    throw new Error("source sentinel: consecutive generation test missing");
  }
  if (!sourcePayloadUrlClassification) {
    throw new Error("source sentinel: payload.url() classification missing");
  }

  return {
    schemaVersion: 1,
    kind: "source-sentinel",
    authoritativeCommand: AUTHORITATIVE_RELOAD_COMMAND,
    sourceQueryBuilder: true,
    sourceFragmentBuilder: false,
    sourceConsecutiveGenerationTest: true,
    sourcePayloadUrlClassification: true,
    physicalWebviewEvidence: false,
    windowsWebView2NavigateFinished: false,
  };
}

export function validateProbeAReloadGenerationSummary(value: unknown): ProbeAReloadGenerationSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("summary must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...PROBE_A_RELOAD_GENERATION_KEYS].sort();
  if (keys.join(",") !== expected.join(",")) {
    throw new Error(`summary keys must be exactly ${expected.join(",")}`);
  }
  if (record.schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1");
  }
  if (record.kind !== "source-sentinel") {
    throw new Error("kind must be source-sentinel");
  }
  if (record.authoritativeCommand !== AUTHORITATIVE_RELOAD_COMMAND) {
    throw new Error("authoritativeCommand must name the locked cargo lib tests");
  }
  if (record.sourceQueryBuilder !== true) {
    throw new Error("sourceQueryBuilder must be true");
  }
  if (record.sourceConsecutiveGenerationTest !== true) {
    throw new Error("sourceConsecutiveGenerationTest must be true");
  }
  if (record.sourcePayloadUrlClassification !== true) {
    throw new Error("sourcePayloadUrlClassification must be true");
  }
  if (record.sourceFragmentBuilder !== false) {
    throw new Error("sourceFragmentBuilder must be false");
  }
  if (record.physicalWebviewEvidence !== false) {
    throw new Error("physicalWebviewEvidence must be false");
  }
  if (record.windowsWebView2NavigateFinished !== false) {
    throw new Error("windowsWebView2NavigateFinished must be false");
  }
  return value as ProbeAReloadGenerationSummary;
}

if (import.meta.main) {
  const summary = validateProbeAReloadGenerationSummary(inspectReloadGenerationTransport());
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  assertMutableHomesInsideSandbox,
  fail,
  hashRouteStaysOnOrigin,
  isPathInsideRoot,
  mutableHomesFromEnv,
  pathsAreSame,
  validateProbeAChildResult,
  type ProbeAChildResult,
} from "./probe-a-contract";
import type { OcxConfig } from "../../src/types";

type SessionMeta = {
  token: string;
  csrf: string;
  origin: string;
};

function requireIsolationEnv(): { root: string; decoyRoot: string } {
  const root = process.env.OCX_PROBE_SANDBOX_ROOT?.trim();
  const decoyRoot = process.env.OCX_PROBE_DECOY_ROOT?.trim();
  const realHome = process.env.OCX_REAL_HOME?.trim();
  if (!root) fail("OCX_PROBE_SANDBOX_ROOT is required");
  if (!decoyRoot) fail("OCX_PROBE_DECOY_ROOT is required");
  if (process.env.OCX_TEST_HOME_GUARD !== "1") {
    fail("OCX_TEST_HOME_GUARD must be armed before imports");
  }
  if (!realHome || !pathsAreSame(realHome, decoyRoot)) {
    fail("OCX_REAL_HOME must be the decoy root before imports");
  }
  if (isPathInsideRoot(root, decoyRoot) || isPathInsideRoot(decoyRoot, root)) {
    fail("decoy root must sit outside the probe sandbox");
  }
  return { root, decoyRoot };
}

function loopbackConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "forward",
      },
    },
    codexAutoStart: false,
    oauthOpenBrowser: false,
    clientIntegrations: {
      codex: false,
      grok: false,
      "claude-desktop": false,
    },
  } as OcxConfig;
}

function wildcardConfig(): OcxConfig {
  return {
    ...loopbackConfig(),
    hostname: "0.0.0.0",
  } as OcxConfig;
}

function metaContentFromHtml(html: string, name: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const nameMatch = tag.match(/\bname="([^"]+)"/i);
    if (nameMatch?.[1] !== name) continue;
    const contentMatch = tag.match(/\bcontent="([^"]*)"/i);
    return contentMatch?.[1]?.trim() || null;
  }
  return null;
}

async function exerciseLoopbackDashboard(
  originUrl: URL,
  parseLoopbackOrigin: typeof import("../runtime/origin").parseLoopbackOrigin,
): Promise<void> {
  const origin = parseLoopbackOrigin(originUrl.origin);
  if (!origin.ok) fail("live server origin is not loopback");
  if (!hashRouteStaysOnOrigin(origin.origin, "#providers")
    || !hashRouteStaysOnOrigin(origin.origin, "#logs/debug")
    || !hashRouteStaysOnOrigin(origin.origin, "#dashboard/update")) {
    fail("hash routes must keep the exact loopback origin");
  }

  const dashboard = await fetch(originUrl, { headers: { Host: originUrl.host } });
  if (dashboard.status !== 200) fail("dashboard GET failed");
  if (dashboard.headers.get("x-frame-options") !== "DENY") fail("X-Frame-Options must be DENY");
  if (!dashboard.headers.get("content-security-policy")?.includes("frame-ancestors 'none'")) {
    fail("CSP must deny framing");
  }
  const dashboardHtml = await dashboard.text();
  if (!dashboardHtml.includes("<!doctype html>") && !dashboardHtml.includes("<!DOCTYPE html>")) {
    fail("dashboard did not serve HTML");
  }
  const session = readSessionMeta(dashboardHtml, parseLoopbackOrigin);

  const bootstrap = await fetch(new URL("/opencodex-session", originUrl), {
    headers: { Host: originUrl.host },
  });
  if (bootstrap.status !== 200) fail("session bootstrap GET failed");
  if (bootstrap.headers.get("x-frame-options") !== "DENY") fail("bootstrap X-Frame-Options must be DENY");
  const bootstrapSession = readSessionMeta(await bootstrap.text(), parseLoopbackOrigin);
  if (bootstrapSession.origin !== origin.origin) fail("bootstrap origin does not match the listener");

  const rejected = await csrfWrite(originUrl, session, false);
  if (rejected !== 401) fail("CSRF write without token must be rejected");
  const written = await csrfWrite(originUrl, session, true);
  if (written !== 200) fail("CSRF write with a minted session must succeed");

  const renewed = await fetch(new URL("/opencodex-session", originUrl), {
    cache: "no-store",
    headers: { Host: originUrl.host },
  });
  if (renewed.status !== 200) fail("session renewal document GET failed");
  const renewedSession = readSessionMeta(await renewed.text(), parseLoopbackOrigin);
  if (renewedSession.token === session.token || renewedSession.csrf === session.csrf) {
    fail("renewal document must mint a new session");
  }
  if (renewedSession.origin !== origin.origin) fail("renewed session origin drifted");
  const renewedWrite = await csrfWrite(originUrl, renewedSession, true);
  if (renewedWrite !== 200) fail("CSRF write after renewal document must succeed");
}

function readSessionMeta(
  html: string,
  parseLoopbackOrigin: typeof import("../runtime/origin").parseLoopbackOrigin,
): SessionMeta {
  const token = metaContentFromHtml(html, "opencodex-session-token");
  const csrf = metaContentFromHtml(html, "opencodex-session-csrf");
  const origin = metaContentFromHtml(html, "opencodex-session-origin");
  if (!token?.startsWith("ocx_session_") || !csrf || !origin) {
    fail("session bootstrap meta is missing or malformed");
  }
  const parsed = parseLoopbackOrigin(origin);
  if (!parsed.ok) fail("session origin is not a loopback origin");
  return { token, csrf, origin: parsed.origin };
}

function sessionHeaders(session: SessionMeta, method: string, withCsrf: boolean): HeadersInit {
  const headers: Record<string, string> = {
    Host: new URL(session.origin).host,
    Origin: session.origin,
    "X-OpenCodex-API-Key": session.token,
    "X-OpenCodex-GUI-Origin": session.origin,
  };
  if (method !== "GET" && method !== "HEAD" && withCsrf) {
    headers["X-OpenCodex-CSRF-Token"] = session.csrf;
  }
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

async function csrfWrite(origin: URL, session: SessionMeta, withCsrf: boolean): Promise<number> {
  const response = await fetch(new URL("/api/debug", origin), {
    method: "PUT",
    headers: sessionHeaders(session, "PUT", withCsrf),
    body: JSON.stringify({ debug: false }),
  });
  return response.status;
}

async function main(): Promise<ProbeAChildResult> {
  const { root, decoyRoot } = requireIsolationEnv();
  const homes = mutableHomesFromEnv(root);
  assertMutableHomesInsideSandbox(homes);
  if (!existsSync(homes.opencodexHome) || !existsSync(homes.codexHome)) {
    fail("sandbox OpenCodex/Codex homes were not created");
  }

  const {
    CODEX_HOME,
    CODEX_CONFIG_PATH,
    CODEX_PROFILE_PATH,
    DEFAULT_CATALOG_PATH,
    CODEX_MODELS_CACHE_PATH,
  } = await import("../../src/codex/paths");
  const { getConfigDir } = await import("../../src/config/paths");
  const { adminApiTokenFilePath } = await import("../../src/lib/admin-secrets");
  const {
    isTestHomeGuardArmed,
    protectedHomeForTests,
    protectedCodexHomeForTests,
  } = await import("../../src/lib/test-home-guard");
  const { saveConfig } = await import("../../src/config");
  const { initializeManagementAuthState, issueGuiSession } = await import("../../src/server/management-auth");
  const { startServer } = await import("../../src/server");
  const { parseLoopbackOrigin } = await import("../runtime/origin");

  if (!isTestHomeGuardArmed()) fail("test-home guard is not armed after imports");
  const home = homedir();
  const configDir = getConfigDir();
  const adminPath = adminApiTokenFilePath(configDir);
  const imported = [
    ["homedir", home],
    ["getConfigDir", configDir],
    ["adminApiTokenFilePath", adminPath],
    ["CODEX_HOME", CODEX_HOME],
    ["CODEX_CONFIG_PATH", CODEX_CONFIG_PATH],
    ["CODEX_PROFILE_PATH", CODEX_PROFILE_PATH],
    ["DEFAULT_CATALOG_PATH", DEFAULT_CATALOG_PATH],
    ["CODEX_MODELS_CACHE_PATH", CODEX_MODELS_CACHE_PATH],
  ] as const;
  for (const [label, value] of imported) {
    if (!isPathInsideRoot(root, value)) fail(`imported ${label} escaped the probe sandbox`);
  }
  const protectedHome = protectedHomeForTests();
  const protectedCodex = protectedCodexHomeForTests();
  if (!isPathInsideRoot(decoyRoot, protectedHome)) {
    fail("protected OpenCodex home is not inside the decoy root");
  }
  if (!isPathInsideRoot(decoyRoot, protectedCodex)) {
    fail("protected Codex home is not inside the decoy root");
  }
  if (isPathInsideRoot(root, protectedHome)) {
    fail("protected OpenCodex home must stay outside the sandbox");
  }
  if (isPathInsideRoot(root, protectedCodex)) {
    fail("protected Codex home must stay outside the sandbox");
  }

  const wildcardState = initializeManagementAuthState(wildcardConfig());
  const wildcardSession = issueGuiSession(new Request("http://127.0.0.1:10100/", {
    headers: { Host: "127.0.0.1:10100" },
  }), wildcardConfig(), wildcardState);
  if (wildcardSession) fail("wildcard bind must not mint a GUI session");

  saveConfig(loopbackConfig());
  const log = console.log;
  console.log = () => {};
  try {
    const server = startServer(0);
    try {
      assertMutableHomesInsideSandbox(mutableHomesFromEnv(root));
      for (const [label, value] of imported) {
        if (!isPathInsideRoot(root, value)) fail(`imported ${label} escaped the probe sandbox`);
      }
      await exerciseLoopbackDashboard(new URL(server.url.origin), parseLoopbackOrigin);
    } finally {
      await server.stop(true);
    }
  } finally {
    console.log = log;
  }

  return {
    schemaVersion: 1,
    bind: "loopback",
    dashboardHtml: true,
    sessionBootstrap: true,
    csrfWrite: true,
    csrfRejectedWithoutToken: true,
    sessionRenewalDocument: true,
    hashRouteUrlSameOrigin: true,
    wildcardBindHasNoSession: true,
    frameAncestorsDenied: true,
    homedirInsideSandbox: true,
    configDirInsideSandbox: true,
    adminTokenPathInsideSandbox: true,
    importedCodexPathsInsideSandbox: true,
    testHomeGuardArmed: true,
    decoyHomesInsideDecoyRoot: true,
    decoyHomesOutsideSandbox: true,
    webviewEvidence: false,
    hideRenewalEvidence: false,
  };
}

const result = validateProbeAChildResult(await main());
process.stdout.write(`${JSON.stringify(result)}\n`);

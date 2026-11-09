import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Mt5ProcessManager } from "./process-manager";
import { resolveRuntimeConfig } from "./runtime-config";
import { cacheControlFor, isCompressibleAsset } from "./static-assets";

const port = Number(process.env.PORT ?? 3000);
const manager = new Mt5ProcessManager();
const webDistDir =
  process.env.WEB_DIST_DIR ?? new URL("../../web/dist", import.meta.url).pathname;
const webDistRoot = resolve(webDistDir);
const publicNoVncUrl = process.env.PUBLIC_NOVNC_URL || undefined;
const novncPort = process.env.NOVNC_PORT ?? "17080";
const gzipCache = new Map<string, Uint8Array<ArrayBuffer>>();

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

// State-changing routes require a header that a cross-site HTML form cannot
// set. This keeps the unauthenticated control plane out of reach of arbitrary
// websites while leaving same-origin UI requests unaffected.
const ACTION_HEADER = "x-linux-mt5";

function contentType(pathname: string): string {
  if (pathname.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (pathname.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (pathname.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (pathname.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (pathname.endsWith(".json") || pathname.endsWith(".map")) {
    return "application/json";
  }
  return "application/octet-stream";
}

function gzipBody(filePath: string, mtimeMs: number, size: number): Uint8Array<ArrayBuffer> {
  const key = `${filePath}:${mtimeMs}:${size}`;
  const cached = gzipCache.get(key);
  if (cached) {
    return cached;
  }

  const body = new Uint8Array(Bun.gzipSync(readFileSync(filePath)));
  if (gzipCache.size >= 32) {
    gzipCache.clear();
  }
  gzipCache.set(key, body);
  return body;
}

function serveStaticFile(
  filePath: string,
  pathname: string,
  request: Request,
): Response {
  const stats = statSync(filePath);
  const assetPath = pathname === "/" ? "/index.html" : pathname;
  const etag = `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "cache-control": cacheControlFor(pathname),
    "content-type": contentType(assetPath),
    etag,
    vary: "Accept-Encoding",
  };

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const wantsGzip =
    stats.size > 512 &&
    isCompressibleAsset(assetPath) &&
    /\bgzip\b/.test(request.headers.get("accept-encoding") ?? "");

  if (wantsGzip) {
    const body = gzipBody(filePath, stats.mtimeMs, stats.size);
    headers["content-encoding"] = "gzip";
    headers["content-length"] = String(body.byteLength);
    return new Response(request.method === "HEAD" ? null : body, { headers });
  }

  return new Response(request.method === "HEAD" ? null : Bun.file(filePath), {
    headers,
  });
}

async function staticResponse(pathname: string, request: Request): Promise<Response> {
  if (pathname === "/favicon.ico") {
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "public, max-age=86400" },
    });
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = resolve(webDistRoot, relativePath);
  if (
    filePath.startsWith(`${webDistRoot}${sep}`) &&
    (await Bun.file(filePath).exists())
  ) {
    return serveStaticFile(filePath, pathname, request);
  }

  if (pathname.startsWith("/assets/")) {
    return new Response("Not found", {
      status: 404,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  const fallbackPath = resolve(webDistRoot, "index.html");
  if (await Bun.file(fallbackPath).exists()) {
    return serveStaticFile(fallbackPath, "/", request);
  }

  return jsonResponse({
    name: "Linux MT5 API",
    status: manager.getState(),
    noVncUrl: "/vnc.html?autoconnect=1&resize=scale&path=websockify",
  });
}

async function expertUploadFiles(request: Request): Promise<File[]> {
  const form = await request.formData();
  return [...form.getAll("files"), ...form.getAll("file")].filter(
    (value): value is File => value instanceof File && value.size > 0,
  );
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      // Deliberately no Access-Control-Allow-Origin: cross-origin callers
      // cannot pass the action-header preflight.
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": `content-type,${ACTION_HEADER}`,
        },
      });
    }

    try {
      if (request.method === "POST" && request.headers.get(ACTION_HEADER) !== "1") {
        return jsonResponse(
          { error: `Missing ${ACTION_HEADER}: 1 header.` },
          403,
        );
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        const status = manager.getState();
        const ok = status.mt5 !== "failed" && status.expert?.state !== "failed";
        return jsonResponse(
          { ok, mt5: status.mt5, expert: status.expert, lastError: status.lastError },
          ok ? 200 : 503,
        );
      }

      if (url.pathname === "/api/status" && request.method === "GET") {
        return jsonResponse(manager.getState());
      }

      if (url.pathname === "/api/runtime-config" && request.method === "GET") {
        return jsonResponse(
          resolveRuntimeConfig({
            requestUrl: request.url,
            publicNoVncUrl,
            novncPort,
            forwardedProto: request.headers.get("x-forwarded-proto"),
          }),
        );
      }

      if (url.pathname === "/api/mt5/experts" && request.method === "GET") {
        return jsonResponse(await manager.getExpertsInfo());
      }

      if (url.pathname === "/api/mt5/experts" && request.method === "POST") {
        return jsonResponse(await manager.uploadExperts(await expertUploadFiles(request)));
      }

      if (url.pathname === "/api/mt5/install" && request.method === "POST") {
        return jsonResponse(await manager.install());
      }

      if (url.pathname === "/api/mt5/launch" && request.method === "POST") {
        return jsonResponse(await manager.launch());
      }

      if (url.pathname === "/api/mt5/stop" && request.method === "POST") {
        return jsonResponse(await manager.stop());
      }

      if (url.pathname === "/api/mt5/restart" && request.method === "POST") {
        return jsonResponse(await manager.restart());
      }

      return staticResponse(url.pathname, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      manager.appendLog(`Request failed: ${message}`);
      return jsonResponse({ error: message, status: manager.getState() }, 400);
    }
  },
});

console.log(`Linux MT5 API listening on http://localhost:${server.port}`);

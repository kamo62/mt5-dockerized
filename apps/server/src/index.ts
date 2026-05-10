import { join } from "node:path";
import { Mt5ProcessManager } from "./process-manager";

const port = Number(process.env.PORT ?? 3000);
const manager = new Mt5ProcessManager();
const webDistDir =
  process.env.WEB_DIST_DIR ?? new URL("../../web/dist", import.meta.url).pathname;
const publicNoVncUrl = process.env.PUBLIC_NOVNC_URL;

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

function contentType(pathname: string): string {
  if (pathname.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (pathname.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (pathname.endsWith(".js")) {
    return "application/javascript";
  }
  if (pathname.endsWith(".svg")) {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

async function staticResponse(pathname: string): Promise<Response> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = Bun.file(join(webDistDir, relativePath));
  if (await file.exists()) {
    return new Response(file, {
      headers: { "content-type": contentType(relativePath) },
    });
  }

  const fallback = Bun.file(join(webDistDir, "index.html"));
  if (await fallback.exists()) {
    return new Response(fallback, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return jsonResponse({
    name: "Linux MT5 API",
    status: manager.getState(),
    noVncUrl: "/vnc.html?autoconnect=1&resize=scale&path=websockify",
  });
}

function runtimeConfig(request: Request): { noVncUrl: string } {
  if (publicNoVncUrl) {
    return { noVncUrl: publicNoVncUrl };
  }

  const url = new URL(request.url);
  return {
    noVncUrl: `${url.protocol}//${url.hostname}:6080/vnc.html?autoconnect=1&resize=scale&path=websockify`,
  };
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
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "content-type",
        },
      });
    }

    try {
      if (url.pathname === "/api/status" && request.method === "GET") {
        return jsonResponse(manager.getState());
      }

      if (url.pathname === "/api/runtime-config" && request.method === "GET") {
        return jsonResponse(runtimeConfig(request));
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

      return staticResponse(url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      manager.appendLog(`Request failed: ${message}`);
      return jsonResponse({ error: message, status: manager.getState() }, 400);
    }
  },
});

console.log(`Linux MT5 API listening on http://localhost:${server.port}`);

export type RuntimeConfigInput = {
  requestUrl: string;
  publicNoVncUrl?: string;
  novncPort: string;
  forwardedProto?: string | null;
};

export type RuntimeConfig = {
  noVncUrl: string;
};

const privateIpv4 =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

// A private hostname means the viewer is on the LAN (or loopback), where the
// direct noVNC port is much faster than hairpinning through a public proxy.
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host.endsWith(".local") ||
    privateIpv4.test(host)
  );
}

function directNoVncUrl(url: URL, port: string): string {
  return `${url.protocol}//${url.hostname}:${port}/vnc.html?autoconnect=1&resize=scale&path=websockify`;
}

export function resolveRuntimeConfig(input: RuntimeConfigInput): RuntimeConfig {
  const url = new URL(input.requestUrl);
  const forwardedProto = input.forwardedProto?.split(",")[0]?.trim();
  const secure = url.protocol === "https:" || forwardedProto === "https";

  if (input.publicNoVncUrl) {
    const configured = new URL(input.publicNoVncUrl);
    if (!secure && isPrivateHostname(url.hostname) && configured.hostname !== url.hostname) {
      return { noVncUrl: directNoVncUrl(url, input.novncPort) };
    }
    return { noVncUrl: input.publicNoVncUrl };
  }

  return { noVncUrl: directNoVncUrl(url, input.novncPort) };
}

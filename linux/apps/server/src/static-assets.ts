const compressible = /\.(?:css|html|js|json|map|svg)$/i;

export function isCompressibleAsset(pathname: string): boolean {
  return compressible.test(pathname);
}

export function cacheControlFor(pathname: string): string {
  if (pathname.startsWith("/assets/")) {
    return "public, max-age=31536000, immutable";
  }
  if (pathname === "/" || pathname.endsWith(".html")) {
    return "no-cache";
  }
  return "public, max-age=3600";
}

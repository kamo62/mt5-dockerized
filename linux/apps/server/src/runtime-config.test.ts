import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const linuxRoot = join(import.meta.dir, "../../..");
const compose = readFileSync(join(linuxRoot, "docker-compose.yml"), "utf8");
const readme = readFileSync(join(linuxRoot, "README.md"), "utf8");
const entrypoint = readFileSync(join(linuxRoot, "docker/entrypoint.sh"), "utf8");

test("Compose can name separate Linux MT5 containers from env files", () => {
  expect(compose).toContain('container_name: "${LINUX_MT5_CONTAINER_NAME:-linux-mt5}"');
});

test("Compose publishes raw VNC for local stream tools", () => {
  expect(compose).toContain('- "${VNC_PORT:-15900}:5900"');
});

test("README distinguishes raw VNC from noVNC browser URLs", () => {
  expect(readme).toContain("VNC_PORT=15900");
  expect(readme).toContain("noVNC browser URL");
  expect(readme).toContain("TigerVNC");
});

test("PulseAudio is disabled by default but can be enabled explicitly", () => {
  expect(compose).toContain('ENABLE_AUDIO: "${ENABLE_AUDIO:-false}"');
  expect(entrypoint).toContain('ENABLE_AUDIO="${ENABLE_AUDIO:-false}"');
  expect(entrypoint).toContain("PulseAudio disabled");
});

test("WebView2 install is opt-in because it can hang under Wine", () => {
  expect(compose).toContain('MT5_INSTALL_WEBVIEW2: "${MT5_INSTALL_WEBVIEW2:-false}"');
  expect(readme).toContain("MT5_INSTALL_WEBVIEW2=false");
  expect(readme).toContain("WebView2 install is skipped by default");
});

test("Compose keeps EA autoload inputs in local overrides", () => {
  expect(compose).not.toContain("MT5_STARTUP_CONFIG");
  expect(compose).not.toContain("MT5_EA_");
  expect(readme).toContain("docker-compose.override.yml");
  expect(readme).toContain('MT5_STARTUP_CONFIG: "true"');
});

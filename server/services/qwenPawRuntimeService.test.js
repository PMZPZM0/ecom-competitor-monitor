import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  QWENPAW_CDN_ORIGIN,
  defaultQwenPawInstallDirectory,
  downloadQwenPawOfficialPackage,
  qwenPawBundledPluginSource,
  qwenPawLocalRuntimeStatus,
  qwenPawOfficialPackagePlan,
  qwenPawRuntimeStatus,
  qwenPawRuntimePaths,
  selectQwenPawOfficialPackage,
} from "./qwenPawRuntimeService.js";

function manifestFile({ platform = "win-tauri", type = "exe", url = "/files/apps/desktop/win-tauri/QwenPaw.exe" } = {}) {
  return {
    platforms: { [platform]: { latest: "latest" } },
    files: {
      latest: {
        id: "latest",
        platform,
        type,
        version: "2.0.1",
        filename: type === "exe" ? "QwenPaw.exe" : "QwenPaw.zip",
        url,
        size_bytes: 123,
        sha256: "a".repeat(64),
      },
    },
  };
}

test("QwenPaw defaults to the agreed Windows D drive directory", () => {
  assert.equal(defaultQwenPawInstallDirectory({ platform: "win32" }), "D:\\电商监控数据\\QwenPaw");
  assert.equal(
    defaultQwenPawInstallDirectory({ platform: "darwin", homeDirectory: "/Users/tester" }),
    path.join("/Users/tester", "Library", "Application Support", "电商竞品监控", "QwenPaw"),
  );
});

test("packaged QwenPaw plugin resolves from Electron's unpacked resource directory", () => {
  const source = qwenPawBundledPluginSource({
    sourceDirectory: "D:/workspace/server/services",
    unpackedDirectory: "D:/Program Files/电商竞品监控/resources/app.asar.unpacked",
    platform: "win32",
  });
  assert.equal(
    source,
    path.win32.join("D:/Program Files/电商竞品监控/resources/app.asar.unpacked", "server", "qwenpaw-plugins", "ecommerce-qr-delivery"),
  );
  assert.equal(
    qwenPawBundledPluginSource({ sourceDirectory: "D:/workspace/server/services", unpackedDirectory: "", platform: "win32" }),
    path.win32.resolve("D:/workspace/server/qwenpaw-plugins/ecommerce-qr-delivery"),
  );
});

test("Electron packaging keeps the QwenPaw plugin outside app.asar for the local runtime", async () => {
  const builderConfig = await fs.readFile(new URL("../../electron-builder.yml", import.meta.url), "utf8");
  const electronMain = await fs.readFile(new URL("../../electron/main.mjs", import.meta.url), "utf8");
  assert.match(builderConfig, /asarUnpack:[\s\S]*server\/qwenpaw-plugins\/\*\*\/\*/);
  assert.match(electronMain, /ECOM_MONITOR_UNPACKED_DIR/);
});

test("an older QwenPaw installation without metadata is offered an in-place verified update", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qwenpaw-legacy-runtime-test-"));
  const platform = "win32";
  const arch = "x64";
  const originalFetch = globalThis.fetch;
  try {
    const paths = qwenPawRuntimePaths(directory, { platform });
    await fs.mkdir(path.dirname(paths.backend), { recursive: true });
    await fs.writeFile(paths.backend, "runtime marker");
    globalThis.fetch = async () => new Response(JSON.stringify(manifestFile()), { status: 200 });
    const status = await qwenPawRuntimeStatus(directory, { checkLatest: true, platform, arch });
    assert.equal(status.installed, true);
    assert.equal(status.version, "");
    assert.equal(status.latestVersion, "2.0.1");
    assert.equal(status.updateAvailable, true);
    assert.equal(status.installDirectory, path.normalize(directory));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("QwenPaw package selection never sends an Apple Silicon package to Intel macOS", () => {
  assert.deepEqual(qwenPawOfficialPackagePlan({ platform: "win32", arch: "x64" }), {
    platform: "win32", arch: "x64", manifestPlatform: "win-tauri", packageType: "exe", universal: false,
  });
  assert.deepEqual(qwenPawOfficialPackagePlan({ platform: "darwin", arch: "arm64" }), {
    platform: "darwin", arch: "arm64", manifestPlatform: "mac-tauri", packageType: "zip", universal: false,
  });
  assert.throws(() => qwenPawOfficialPackagePlan({ platform: "darwin", arch: "x64" }), /Intel Mac/);
  assert.throws(() => qwenPawOfficialPackagePlan({ platform: "win32", arch: "arm64" }), /暂不支持/);
});

test("QwenPaw package URLs are restricted to the official CDN", () => {
  const selected = selectQwenPawOfficialPackage(manifestFile(), qwenPawOfficialPackagePlan({ platform: "win32", arch: "x64" }));
  assert.equal(new URL(selected.url).origin, QWENPAW_CDN_ORIGIN);
  assert.throws(() => selectQwenPawOfficialPackage(manifestFile({ url: "https://example.com/QwenPaw.exe" }), qwenPawOfficialPackagePlan({ platform: "win32", arch: "x64" })), /官方 CDN/);
});

test("QwenPaw download verifies SHA-256 and removes a corrupt package", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qwenpaw-download-test-"));
  const destination = path.join(directory, "QwenPaw.exe");
  const content = Buffer.from("official-qwenpaw-package");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(content, { status: 200, headers: { "content-length": String(content.length) } });
  try {
    const pkg = {
      url: `${QWENPAW_CDN_ORIGIN}/files/QwenPaw.exe`,
      version: "2.0.1",
      sizeBytes: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    };
    await downloadQwenPawOfficialPackage(pkg, destination);
    assert.deepEqual(await fs.readFile(destination), content);
    await assert.rejects(downloadQwenPawOfficialPackage({ ...pkg, sha256: "0".repeat(64) }, destination), /校验失败/);
    await assert.rejects(fs.access(destination));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("QwenPaw status only trusts the backend inside the selected directory", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qwenpaw-runtime-test-"));
  try {
    const paths = qwenPawRuntimePaths(directory);
    assert.equal(qwenPawLocalRuntimeStatus(directory).installed, false);
    await fs.mkdir(path.dirname(paths.backend), { recursive: true });
    await fs.writeFile(paths.backend, "runtime marker");
    const status = qwenPawLocalRuntimeStatus(directory);
    assert.equal(status.installed, true);
    assert.equal(status.installDirectory, path.normalize(directory));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("QwenPaw bootstrap source has no GitHub, PyPI, uv, or pip installation fallback", async () => {
  const source = await fs.readFile(new URL("./qwenPawRuntimeService.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /github\.com|api\.github|pypi|pip\s+install|ensureUv/i);
  assert.match(source, /download\.qwenpaw\.agentscope\.io/);
});

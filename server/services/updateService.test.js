import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, selectReleaseAsset } from "./updateService.js";

test("version comparison handles tags and different segment lengths", () => {
  assert.equal(compareVersions("v1.0.5", "1.0.4"), 1);
  assert.equal(compareVersions("1.0.4", "v1.0.4"), 0);
  assert.equal(compareVersions("1.0.4", "1.1.0"), -1);
  assert.equal(compareVersions("1.0.5", "1.0.5-beta.1"), 0);
});

test("release asset selection matches the current OS and CPU", () => {
  const assets = [
    { name: "电商竞品监控-1.0.5-win-x64.exe", browser_download_url: "https://github.com/PMZPZM0/ecom-competitor-monitor/releases/download/v1.0.5/win.exe" },
    { name: "电商竞品监控-1.0.5-mac-x64.dmg", browser_download_url: "https://github.com/PMZPZM0/ecom-competitor-monitor/releases/download/v1.0.5/mac-x64.dmg" },
    { name: "电商竞品监控-1.0.5-mac-arm64.dmg", browser_download_url: "https://github.com/PMZPZM0/ecom-competitor-monitor/releases/download/v1.0.5/mac-arm64.dmg" },
  ];
  assert.equal(selectReleaseAsset(assets, "win32", "x64")?.name, assets[0].name);
  assert.equal(selectReleaseAsset(assets, "darwin", "x64")?.name, assets[1].name);
  assert.equal(selectReleaseAsset(assets, "darwin", "arm64")?.name, assets[2].name);
  assert.equal(selectReleaseAsset([{ name: "bad.exe", browser_download_url: "https://example.com/bad.exe" }], "win32", "x64"), null);
});

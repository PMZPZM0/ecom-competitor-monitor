import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecret } from "./secretService.js";
import { normalizeCloudSync, syncCloudReports } from "./cloudSyncService.js";

function cloudConfig() {
  return normalizeCloudSync({
    endpoint: "http://127.0.0.1:4330",
    deviceId: "device_1",
    deviceName: "本机联调",
    tokenEncrypted: encryptSecret("test-device-token"),
    teamId: "team_1",
    teamName: "测试团队",
    storeNames: ["测试店铺"],
    lastCursor: 3,
    scopeVersion: 1,
  });
}

test("cloud sync keeps local uploads while replacing only cloud-origin reports", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /cursor=3/);
    assert.equal(init.headers["x-ecom-cloud-device-token"], "test-device-token");
    return new Response(JSON.stringify({
      team: { id: "team_1", name: "测试团队" },
      device: { scopeVersion: 1, stores: [{ name: "测试店铺" }] },
      full: true,
      cursor: 9,
      activeRemoteIds: ["remote_new"],
      removedIds: [],
      reports: [{
        remoteId: "remote_new",
        revision: 9,
        updatedAt: "2026-07-29T00:00:00.000Z",
        storeName: "测试店铺",
        report: {
          id: "ops_remote_new",
          type: "product",
          storeName: "测试店铺",
          reportDate: "2026-07-28",
          periodStart: "2026-07-28",
          periodEnd: "2026-07-28",
          periodLabel: "2026-07-28",
          periodKind: "day",
          detectedType: "product",
          sourceName: "云端管理后台",
          fileName: "商品排行.csv",
          kind: "csv",
          columns: ["商品ID"],
          rows: [{ productId: "1001", productName: "测试商品", grossRevenue: 100 }],
          screenshotPath: "",
          screenshotMimeType: "",
          importedAt: "2026-07-29T00:00:00.000Z",
          dataSignature: "a".repeat(64),
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await syncCloudReports({
      cloudSync: cloudConfig(),
      reports: [
        { id: "local_1", type: "product", storeName: "本机店铺", rows: [], sourceName: "本机导入" },
        {
          id: "old_cloud", type: "product", storeName: "测试店铺", rows: [], sourceName: "云端同步 · 测试团队",
          cloudOrigin: { endpoint: "http://127.0.0.1:4330", teamId: "team_1", remoteReportId: "remote_old", revision: 2, syncedAt: "2026-07-28T00:00:00.000Z" },
        },
      ],
    });
    assert.equal(result.reports.length, 2);
    assert.ok(result.reports.some((report) => report.id === "local_1"));
    assert.ok(result.reports.some((report) => report.cloudOrigin?.remoteReportId === "remote_new"));
    assert.equal(result.reports.some((report) => report.cloudOrigin?.remoteReportId === "remote_old"), false);
    assert.deepEqual(result.result, { inserted: 1, updated: 0, removed: 1, full: true, total: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloud sync updates a matching cloud report without counting it as a deletion", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    team: { id: "team_1", name: "测试团队" },
    device: { scopeVersion: 1, stores: [{ name: "测试店铺" }] },
    full: false,
    cursor: 10,
    removedIds: [],
    reports: [{
      remoteId: "remote_same", revision: 10, updatedAt: "2026-07-29T00:00:00.000Z", storeName: "测试店铺",
      report: { id: "remote", type: "product", storeName: "测试店铺", reportDate: "2026-07-29", periodStart: "2026-07-29", periodEnd: "2026-07-29", periodLabel: "2026-07-29", periodKind: "day", detectedType: "product", sourceName: "云端", fileName: "更新.csv", kind: "csv", columns: [], rows: [], screenshotPath: "", screenshotMimeType: "", importedAt: "2026-07-29T00:00:00.000Z", dataSignature: "b".repeat(64) },
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await syncCloudReports({
      cloudSync: cloudConfig(),
      reports: [{ id: "old_cloud", type: "product", storeName: "测试店铺", rows: [], cloudOrigin: { endpoint: "http://127.0.0.1:4330", teamId: "team_1", remoteReportId: "remote_same", revision: 3, syncedAt: "2026-07-28T00:00:00.000Z" } }],
    });
    assert.equal(result.reports.length, 1);
    assert.equal(result.reports[0].fileName, "更新.csv");
    assert.deepEqual(result.result, { inserted: 0, updated: 1, removed: 0, full: false, total: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

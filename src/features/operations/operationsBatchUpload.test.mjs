import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("./OperationsAssistant.tsx", import.meta.url));
const source = await readFile(sourcePath, "utf8");

test("local operations upload exposes a real multi-file queue", () => {
  assert.match(source, /ref=\{reportFileInput\}[\s\S]*?type="file"[\s\S]*?multiple[\s\S]*?Array\.from\(event\.target\.files \|\| \[\]\)/);
  assert.match(source, /async function inspectReports\(files: File\[\]\)/);
  assert.match(source, /reportBatch\.map\(\(item, index\) =>/);
  assert.match(source, /点击某一份单独修正上方报表类型与统计日期/);
});

test("local operations batch import preserves successes and retries failures", () => {
  assert.match(source, /status: "uploading"/);
  assert.match(source, /status: "success"/);
  assert.match(source, /status: "upload-error"/);
  assert.match(source, /已成功的不会重复导入，修正失败项后可直接重试/);
  assert.match(source, /await refreshArchive\(\);[\s\S]*?setBusy\(""\);/);
});

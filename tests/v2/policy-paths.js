import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { realPathBoundaryReason, unsafePathReason } from "../../src/v2/policy/path-boundary.js";
import {
  findSerialOnlyMatches,
  hasAmbiguousPathPattern,
  isAbsolutePathLike,
  isPathInside,
  isWithinAnyPath,
  normalizeFilesystemCase,
  normalizeLockPath,
  normalizeLockPathList,
  overlaps,
  unsafeChangedFiles,
} from "../../src/v2/policy/paths.js";

const normalizationCases = [
  ["./src\\feature\\", "src/feature"],
  ["src//feature///file.js", "src/feature/file.js"],
  ["src/feature/**", "src/feature"],
  [" src/feature/* ", "src/feature"],
  ["", ""],
];
for (const [input, expected] of normalizationCases) {
  assert.equal(normalizeLockPath(input), expected, input);
}
assert.deepEqual(normalizeLockPathList(["src\\api", "./src/api", "src/api/"]), ["src/api"]);

const absoluteCases = [
  ["C:\\repo\\file.js", true],
  ["D:/repo/file.js", true],
  ["\\\\server\\share\\file.js", true],
  ["/repo/file.js", true],
  ["repo/file.js", false],
];
for (const [input, expected] of absoluteCases) {
  assert.equal(isAbsolutePathLike(input), expected, input);
}

assert.equal(
  normalizeFilesystemCase("Src/API.js"),
  process.platform === "win32" ? "src/api.js" : "Src/API.js"
);
assert.deepEqual(overlaps(["src\\api"], ["src/api/routes.js"]), ["src\\api", "src/api/routes.js"]);
assert.deepEqual(
  overlaps(["Src/API"], ["src/api/routes.js"]),
  process.platform === "win32" ? ["Src/API", "src/api/routes.js"] : null
);
assert.equal(overlaps(["src/app"], ["src/application"]), null);

const pathMembershipCases = [
  ["private.key", ["*.key"], true],
  ["certs/service.pem", ["**/*.pem"], true],
  ["secrets/token.txt", ["secrets/**"], true],
  ["apps/api/secrets/token.txt", ["**/secrets/**"], true],
  ["src/app.js", ["src/*.js"], true],
  ["src/nested/app.js", ["src/*.js"], false],
  ["src/application/file.js", ["src/app"], false],
];
for (const [file, allowed, expected] of pathMembershipCases) {
  assert.equal(isWithinAnyPath(file, allowed), expected, `${file} in ${allowed.join(",")}`);
}
assert.deepEqual(unsafeChangedFiles(["src/ok.js", "docs/no.md"], ["src/**"]), ["docs/no.md"]);
assert.equal(hasAmbiguousPathPattern(["src/app.js", "src/*.test.js"]), true);
assert.equal(hasAmbiguousPathPattern(["src/app.js"]), false);
assert.equal(findSerialOnlyMatches(["src/routes/api.js"]).length > 0, true);

const root = await mkdtemp(path.join(tmpdir(), "codex-policy-paths-"));
try {
  await mkdir(path.join(root, "src"));
  assert.equal(realPathBoundaryReason("src/new-file.js", root), "");
  assert.match(realPathBoundaryReason("src/file.js", path.join(root, "missing-root")), /^Allowed root does not exist:/);

  const boundaryCases = [
    ["../outside", /includes parent traversal/],
    ["nested/../../outside", /includes parent traversal/],
    ["~/secret", /home-directory shortcut/],
    [".", /targets a filesystem root/],
    ["line\nbreak", /contains control characters/],
    [path.resolve(root, "..", "outside"), /resolves outside the allowed root/],
  ];
  for (const [input, expected] of boundaryCases) {
    assert.match(unsafePathReason([input], root), expected, input);
  }
  assert.equal(unsafePathReason(["src/new-file.js"], root), "");
  assert.equal(unsafePathReason([path.join(root, "src", "new-file.js")], root), "");

  assert.equal(isPathInside(root, path.join(root, "src", "file.js")), true);
  assert.equal(isPathInside(root, root), false);
  assert.equal(isPathInside(root, path.resolve(root, "..", `${path.basename(root)}-sibling`)), false);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("V2 policy path helper tests passed.");

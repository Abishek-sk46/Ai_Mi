import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getFileContent,
  getInitialSelectedFile,
  hasFile,
  type FileCollection,
} from "./file-explorer-utils";

describe("file-explorer empty-file and file-existence handling", () => {
  it("allows selecting and rendering an existing empty file ('')", () => {
    const files: FileCollection = {
      "app/page.tsx": "export default function Page() { return <main />; }",
      "components/empty.ts": "",
    };

    assert.equal(hasFile(files, "components/empty.ts"), true);
    assert.equal(getFileContent(files, "components/empty.ts"), "");
  });

  it("selects an empty file on initial load when it is the first entry", () => {
    const files: FileCollection = {
      "a-empty.ts": "",
      "app/page.tsx": "export default function Page() { return <main />; }",
    };

    const initial = getInitialSelectedFile(files);
    assert.equal(initial, "a-empty.ts");
    assert.equal(hasFile(files, initial), true);
    assert.equal(getFileContent(files, initial), "");
  });

  it("preserves existing behavior for non-empty files", () => {
    const files: FileCollection = {
      "app/page.tsx": "export default function Page() { return <h1>Hi</h1>; }",
    };

    assert.equal(hasFile(files, "app/page.tsx"), true);
    assert.equal(
      getFileContent(files, "app/page.tsx"),
      "export default function Page() { return <h1>Hi</h1>; }"
    );
  });

  it("handles missing, null, and undefined file paths safely without returning undefined", () => {
    const files: FileCollection = {
      "app/page.tsx": "content",
    };

    assert.equal(hasFile(files, "components/missing.ts"), false);
    assert.equal(hasFile(files, null), false);
    assert.equal(hasFile(files, undefined), false);

    assert.equal(getFileContent(files, "components/missing.ts"), null);
    assert.equal(getFileContent(files, null), null);
    assert.equal(getFileContent(files, undefined), null);
  });

  it("allows copying empty file content ('') and skips copying missing files", () => {
    const files: FileCollection = {
      "components/empty.ts": "",
    };
    const copied: string[] = [];

    const copyIfPresent = (selectedFile: string | null) => {
      const content = getFileContent(files, selectedFile);
      if (content !== null) {
        copied.push(content);
      }
    };

    copyIfPresent("components/empty.ts");
    copyIfPresent("components/missing.ts");
    copyIfPresent(null);

    assert.deepEqual(copied, [""]);
  });

  it("handles an empty file collection safely", () => {
    const files: FileCollection = {};

    assert.equal(getInitialSelectedFile(files), null);
    assert.equal(hasFile(files, "app/page.tsx"), false);
    assert.equal(getFileContent(files, "app/page.tsx"), null);
  });

  it("rejects inherited Object.prototype keys like constructor and toString", () => {
    const files: FileCollection = {
      "app/page.tsx": "content",
    };

    for (const protoKey of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      assert.equal(hasFile(files, protoKey), false, `Expected "${protoKey}" to be rejected`);
      assert.equal(getFileContent(files, protoKey), null, `Expected "${protoKey}" content to be null`);
    }
  });
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { searchContent, searchNames } from "../dist/search-engine.js";
import { readTailLines, readTextRange } from "../dist/fs-ops.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rob-dc-opt-"));
try {
  const large = path.join(dir, "large.log");
  const lines = Array.from({ length: 20_000 }, (_, i) => `line-${i} needle`).join("\n") + "\n";
  await fs.writeFile(large, lines, "utf8");

  const content = await searchContent({
    cwd: dir,
    query: "needle",
    literal: true,
    ignoreCase: false,
    includeHidden: false,
    globs: [],
    maxResults: 7,
    maxChars: 100_000,
    filesOnly: false
  });
  assert.equal(content.matches.length, 7);
  assert.equal(content.truncated, true);

  const names = await searchNames({
    cwd: dir,
    query: "large",
    literal: true,
    ignoreCase: true,
    includeHidden: false,
    globs: [],
    maxResults: 5,
    maxChars: 100_000
  });
  assert.equal(names.matches.length, 1);

  const tail = await readTailLines(large, 3, 64 * 1024);
  assert.equal(tail.returnedLines, 3);
  assert.match(tail.content, /line-19999 needle$/);

  const range = await readTextRange(large, 10_000, 3);
  assert.equal(range.returnedLines, 3);
  assert.match(range.content, /^line-9999 needle/);

  const crlf = path.join(dir, "crlf.log");
  await fs.writeFile(crlf, "alpha\r\nbeta\r\ngamma\r\n", "utf8");
  const crlfRange = await readTextRange(crlf, 2, 2);
  assert.equal(crlfRange.content, "beta\ngamma");
  assert.equal(crlfRange.returnedLines, 2);
  assert.equal(crlfRange.hasMoreLines, false);

  const beyondEof = await readTextRange(crlf, 4, 2);
  assert.equal(beyondEof.content, "");
  assert.equal(beyondEof.returnedLines, 0);

  const noTrailingNewline = path.join(dir, "no-trailing-newline.log");
  await fs.writeFile(noTrailingNewline, "one\ntwo\nthree", "utf8");
  const noTrailingTail = await readTailLines(noTrailingNewline, 2, 64 * 1024);
  assert.equal(noTrailingTail.content, "two\nthree");

  console.log(JSON.stringify({
    ok: true,
    streamedSearchResults: content.matches.length,
    tailLines: tail.returnedLines
  }));
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

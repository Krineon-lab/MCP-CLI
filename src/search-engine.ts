import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";

interface CollectOptions {
  args: string[];
  cwd: string;
  maxResults: number;
  maxChars: number;
  accept?: (line: string) => boolean;
}

export async function collectRipgrepLines(options: CollectOptions): Promise<{
  code: number;
  matches: string[];
  stderr: string;
  truncated: boolean;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(rgPath, options.args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const matches: string[] = [];
    let stderr = "";
    let remainder = "";
    let chars = 0;
    let truncated = false;
    let stoppedEarly = false;

    const accept = options.accept ?? (() => true);

    const processLine = (line: string) => {
      if (!accept(line)) return;
      const lineChars = line.length + 1;
      if (matches.length >= options.maxResults || chars + lineChars > options.maxChars) {
        truncated = true;
        if (!stoppedEarly) {
          stoppedEarly = true;
          child.kill();
        }
        return;
      }
      matches.push(line);
      chars += lineChars;
    };

    child.stdout.on("data", (chunk: string) => {
      const text = remainder + chunk;
      const parts = text.split(/\r?\n/);
      remainder = parts.pop() ?? "";
      for (const line of parts) {
        if (stoppedEarly) break;
        if (line) processLine(line);
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (!stoppedEarly && remainder) processLine(remainder);
      resolve({
        code: stoppedEarly ? 0 : (code ?? 0),
        matches,
        stderr,
        truncated
      });
    });
  });
}

export async function searchNames(options: {
  cwd: string;
  query: string;
  literal: boolean;
  ignoreCase: boolean;
  includeHidden: boolean;
  globs: string[];
  maxResults: number;
  maxChars: number;
}) {
  const args = ["--files", "--color", "never"];
  if (options.includeHidden) args.push("--hidden");
  for (const glob of options.globs) args.push("-g", glob);

  let accept: (value: string) => boolean;
  if (options.literal) {
    const needle = options.ignoreCase ? options.query.toLowerCase() : options.query;
    accept = (value) => (options.ignoreCase ? value.toLowerCase() : value).includes(needle);
  } else {
    const re = new RegExp(options.query, options.ignoreCase ? "i" : undefined);
    accept = (value) => re.test(value);
  }

  return await collectRipgrepLines({
    args,
    cwd: options.cwd,
    maxResults: options.maxResults,
    maxChars: options.maxChars,
    accept
  });
}

export async function searchContent(options: {
  cwd: string;
  query: string;
  literal: boolean;
  ignoreCase: boolean;
  includeHidden: boolean;
  globs: string[];
  maxResults: number;
  maxChars: number;
  filesOnly: boolean;
}) {
  const args = options.filesOnly
    ? ["--files-with-matches", "--color", "never"]
    : ["--line-number", "--column", "--no-heading", "--color", "never"];
  if (options.includeHidden) args.push("--hidden");
  if (options.ignoreCase) args.push("-i");
  if (options.literal) args.push("-F");
  for (const glob of options.globs) args.push("-g", glob);
  args.push("--", options.query, ".");

  return await collectRipgrepLines({
    args,
    cwd: options.cwd,
    maxResults: options.maxResults,
    maxChars: options.maxChars
  });
}

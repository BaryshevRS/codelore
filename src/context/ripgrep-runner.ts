import { spawn } from "node:child_process";
import { relative } from "node:path";
import { rgPath } from "@vscode/ripgrep";

export interface RipgrepHit {
  file: string;
  line: number;
  column: number;
  matched: string;
}

export interface RipgrepOptions {
  rootDir: string;
  excludeFiles?: string[];
}

const BASE_GLOBS = ["*.ts", "*.js"];
const BASE_EXCLUDES = ["!node_modules", "!dist", "!build", "!.codelore", "!coverage"];

export async function searchLiteral(literal: string, options: RipgrepOptions): Promise<RipgrepHit[]> {
  if (literal.length === 0) {
    return [];
  }

  const args: string[] = ["--json", "--fixed-strings", "--no-config"];
  for (const include of BASE_GLOBS) {
    args.push("-g", include);
  }
  for (const exclude of BASE_EXCLUDES) {
    args.push("-g", exclude);
  }
  for (const file of options.excludeFiles ?? []) {
    const rel = relative(options.rootDir, file);
    if (rel && !rel.startsWith("..")) {
      args.push("-g", `!${rel}`);
    }
  }
  args.push("--", literal, ".");

  return new Promise((resolve, reject) => {
    const proc = spawn(rgPath, args, { cwd: options.rootDir });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 1) {
        resolve([]);
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString();
        reject(new Error(`ripgrep exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        const stdout = Buffer.concat(stdoutChunks).toString();
        resolve(parseRipgrepJson(stdout, options.rootDir));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseRipgrepJson(stdout: string, rootDir: string): RipgrepHit[] {
  const hits: RipgrepHit[] = [];
  for (const rawLine of stdout.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    let event: RipgrepEvent;
    try {
      event = JSON.parse(trimmed) as RipgrepEvent;
    } catch {
      continue;
    }
    if (event.type !== "match") {
      continue;
    }
    const data = event.data;
    const filePath = data.path.text;
    const absolute = filePath.startsWith("/") ? filePath : `${rootDir}/${filePath}`;
    const lineNumber = data.line_number;
    const lineText = data.lines.text ?? "";
    for (const sub of data.submatches ?? []) {
      const matched = sub.match.text ?? "";
      const column = byteOffsetToColumn(lineText, sub.start) + 1;
      hits.push({ file: absolute, line: lineNumber, column, matched });
    }
  }
  return hits;
}

function byteOffsetToColumn(line: string, byteOffset: number): number {
  if (byteOffset <= 0) {
    return 0;
  }
  const buffer = Buffer.from(line, "utf8");
  const slice = buffer.subarray(0, byteOffset).toString("utf8");
  return slice.length;
}

interface RipgrepEventData {
  path: { text: string };
  // biome-ignore lint/style/useNamingConvention: ripgrep JSON wire format uses snake_case
  line_number: number;
  lines: { text?: string };
  submatches?: Array<{ match: { text?: string }; start: number; end: number }>;
}

interface RipgrepEvent {
  type: string;
  data: RipgrepEventData;
}

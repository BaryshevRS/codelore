export interface DiffFileChange {
  path: string;
  ranges: Array<{ startLine: number; endLine: number }>;
}

function parseDiffFileHeader(line: string): string | null {
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  return m ? m[2] : null;
}

function parsePlusHeader(line: string): string | null {
  const m = /^\+\+\+ b\/(.+)$/.exec(line);
  return m ? m[1] : null;
}

function parseHunkHeader(line: string): { startLine: number; endLine: number } | null {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) {
    return null;
  }
  const startLine = Number(m[1]);
  const count = m[2] ? Number(m[2]) : 1;
  return { startLine, endLine: count === 0 ? startLine : startLine + count - 1 };
}

export function parseUnifiedDiff(diff: string): DiffFileChange[] {
  const files: DiffFileChange[] = [];
  let current: DiffFileChange | undefined;

  for (const line of diff.split(/\r?\n/)) {
    const filePath = parseDiffFileHeader(line);
    if (filePath) {
      current = { path: filePath, ranges: [] };
      files.push(current);
      continue;
    }

    const plusPath = parsePlusHeader(line);
    if (plusPath) {
      current = current ?? { path: plusPath, ranges: [] };
      if (!files.includes(current)) {
        files.push(current);
      }
      current.path = plusPath;
      continue;
    }

    const hunk = parseHunkHeader(line);
    if (hunk && current) {
      current.ranges.push(hunk);
    }
  }

  return files;
}

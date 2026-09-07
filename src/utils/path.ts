import { relative, resolve } from "node:path";

export function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function relativeProjectPath(rootDir: string, path: string): string {
  return toPosixPath(relative(rootDir, resolve(path)));
}

export function isProbablyExcluded(relativePath: string): boolean {
  return (
    relativePath.includes("/node_modules/") ||
    relativePath.startsWith("node_modules/") ||
    relativePath.includes("/dist/") ||
    relativePath.startsWith("dist/") ||
    relativePath.includes("/build/") ||
    relativePath.startsWith("build/") ||
    relativePath.includes("/.codelore/") ||
    relativePath.startsWith(".codelore/")
  );
}

export function encodeResourceId(id: string): string {
  return encodeURIComponent(id);
}

export function decodeResourceId(id: string): string {
  return decodeURIComponent(id);
}

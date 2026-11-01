import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { TeaError } from "./types.js";

/**
 * Prepare an output directory without following a symlinked directory or
 * writing through a symlinked file. Creates the directory when missing.
 */
export const prepareOutputDirectory = async (
  outputDir: string,
): Promise<string> => {
  if (typeof outputDir !== "string" || outputDir.trim() === "")
    throw new TeaError("invalid_input", "outputDir must be a non-empty path");
  const resolved = resolve(outputDir);
  try {
    await mkdir(resolved, { recursive: true });
  } catch {
    throw new TeaError(
      "invalid_output",
      `cannot create output directory: ${resolved}`,
    );
  }
  const info = await lstat(resolved);
  if (info.isSymbolicLink())
    throw new TeaError("unsafe_output", "output directory is a symlink");
  if (!info.isDirectory())
    throw new TeaError("invalid_output", "outputDir is not a directory");
  return realpath(resolved);
};

/** Write a file, refusing to overwrite without consent or follow a symlink. */
export const writeOutputFile = async (
  targetPath: string,
  content: string,
  overwrite: boolean,
): Promise<void> => {
  try {
    const info = await lstat(targetPath);
    if (info.isSymbolicLink())
      throw new TeaError(
        "unsafe_output",
        `refusing to write through a symlink: ${targetPath}`,
      );
    if (!overwrite)
      throw new TeaError(
        "already_exists",
        `output file already exists (pass overwrite to replace it): ${targetPath}`,
      );
  } catch (cause) {
    if (cause instanceof TeaError) throw cause;
    if (!isMissing(cause)) throw cause;
  }
  await writeFile(targetPath, content, { flag: overwrite ? "w" : "wx" });
};

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === "ENOENT";

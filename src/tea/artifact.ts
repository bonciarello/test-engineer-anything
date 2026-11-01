import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

import { writeOutputFile } from "./output.js";
import { TeaError } from "./types.js";

const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const manifestSchema = z.strictObject({
  format: z.literal("tea-artifact-manifest"),
  formatVersion: z.literal(1),
  kind: z.enum(["contract", "source"]),
  testFile: z.string().min(1),
  planFile: z.string().min(1),
  testSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  planSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});

export type ArtifactKind = "contract" | "source";

interface WriteManifestInput {
  readonly kind: ArtifactKind;
  readonly testPath: string;
  readonly planPath: string;
  readonly testContent: string;
  readonly planContent: string;
  readonly overwrite: boolean;
}

/** Write the sidecar identity shared by both TEA artifact families. */
export const writeArtifactManifest = async (
  input: WriteManifestInput,
): Promise<string> => {
  const manifestPath = artifactManifestPath(input.testPath);
  const manifest = {
    format: "tea-artifact-manifest",
    formatVersion: 1,
    kind: input.kind,
    testFile: basename(input.testPath),
    planFile: basename(input.planPath),
    testSha256: digest(input.testContent),
    planSha256: digest(input.planContent),
  } as const;
  await writeOutputFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    input.overwrite,
  );
  return manifestPath;
};

/** Require an intact TEA manifest before executing a caller-selected test. */
export const admitGeneratedArtifact = async (
  testPath: string,
): Promise<ArtifactKind> => {
  await regularFile(testPath, "test artifact", "not_found");
  const manifestPath = artifactManifestPath(testPath);
  const manifestText = await regularFile(
    manifestPath,
    "artifact manifest",
    "artifact_manifest_missing",
  );
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText) as unknown;
  } catch {
    throw new TeaError(
      "invalid_artifact_manifest",
      "artifact manifest is not valid JSON",
    );
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success)
    throw new TeaError(
      "invalid_artifact_manifest",
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  const manifest = parsed.data;
  if (manifest.testFile !== basename(testPath))
    throw new TeaError(
      "invalid_artifact_manifest",
      "manifest test filename does not match the selected artifact",
    );
  if (
    manifest.planFile !== basename(manifest.planFile) ||
    manifest.planFile === "." ||
    manifest.planFile === ".."
  )
    throw new TeaError(
      "invalid_artifact_manifest",
      "manifest plan filename must be a sibling file",
    );
  const planPath = join(dirname(testPath), manifest.planFile);
  const planText = await regularFile(
    planPath,
    "artifact plan",
    "artifact_plan_missing",
  );
  if (digest(await readFile(testPath)) !== manifest.testSha256)
    throw new TeaError(
      "artifact_digest_mismatch",
      "test artifact digest does not match its manifest; regenerate the suite",
    );
  if (digest(planText) !== manifest.planSha256)
    throw new TeaError(
      "artifact_digest_mismatch",
      "test plan digest does not match its manifest; regenerate the suite",
    );
  return manifest.kind;
};

export const artifactManifestPath = (testPath: string): string =>
  `${testPath}.manifest.json`;

const regularFile = async (
  path: string,
  label: string,
  missingCode: string,
): Promise<string> => {
  let info;
  try {
    info = await lstat(path);
  } catch (cause) {
    if (isMissing(cause))
      throw new TeaError(missingCode, `${label} does not exist: ${path}`);
    throw cause;
  }
  if (info.isSymbolicLink())
    throw new TeaError("unsafe_artifact", `${label} must not be a symlink`);
  if (!info.isFile())
    throw new TeaError("unsafe_artifact", `${label} is not a regular file`);
  const limit =
    missingCode === "artifact_manifest_missing"
      ? MAX_MANIFEST_BYTES
      : MAX_ARTIFACT_BYTES;
  if (info.size > limit)
    throw new TeaError(
      "artifact_too_large",
      `${label} exceeds the ${limit}-byte admission limit`,
    );
  return readFile(path, "utf8");
};

const digest = (content: string | Buffer): string =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === "ENOENT";

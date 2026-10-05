// ============================================================
// wpi — Image identity and build inputs
// ============================================================
// Everything that goes into `docker build` is collected here
// once, and the image tag is derived from it:
//
//   pi-agent:<pi version>-<fingerprint of the build inputs>
//
// The fingerprint covers the generated Dockerfile (including a
// project's docker.extension), the entrypoint, and the bundled
// package/ and settings/ directories. So:
//   - projects with different docker.extension blocks get
//     different images instead of overwriting one shared tag
//   - changing docker.extension or updating wpi yields a tag
//     that does not exist yet, which triggers a rebuild
// ============================================================

import * as path from "path";
import * as fs from "fs";
import { createHash } from "crypto";
import { generateDockerfile, generateEntrypoint } from "./templates";

// Module root (sibling to dist/)
const MODULE_ROOT = path.join(__dirname, "..");

/** Repository name of every image wpi builds. */
export const IMAGE_REPOSITORY = "pi-agent";

/** One file of the docker build context, addressed by its path inside the context. */
export interface BuildContextFile {
  path: string;
  content: Buffer;
}

/**
 * Collect the complete docker build context:
 *   - Dockerfile (generated from template)
 *   - entrypoint.sh (generated from template)
 *   - package/ (built-in, from installed module)
 *   - settings/ (built-in, from installed module)
 *
 * Sorted by path so the result, and therefore the fingerprint, is deterministic.
 */
export function collectBuildContext(piVersion: string, dockerfileExtension?: string): BuildContextFile[] {
  const files: BuildContextFile[] = [
    { path: "Dockerfile", content: Buffer.from(generateDockerfile(dockerfileExtension, piVersion)) },
    { path: "entrypoint.sh", content: Buffer.from(generateEntrypoint()) },
  ];

  // Built-in package (always present in installed module)
  const builtinPackageDir = path.join(MODULE_ROOT, "package");
  if (fs.existsSync(builtinPackageDir)) {
    files.push(...readTree(builtinPackageDir, "package"));
  } else {
    files.push(...placeholderPackage());
  }

  // Built-in settings (always present in installed module)
  const builtinSettingsDir = path.join(MODULE_ROOT, "settings");
  if (fs.existsSync(builtinSettingsDir)) {
    files.push(...readTree(builtinSettingsDir, "settings"));
  } else {
    files.push(placeholderSettings());
  }

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Short, stable identifier of a build context's contents. */
export function fingerprintBuildContext(files: BuildContextFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    // Length-prefix both fields so no path/content pair can be mistaken for another.
    hash.update(`${Buffer.byteLength(file.path)}:${file.path}\n${file.content.length}:`);
    hash.update(file.content);
  }
  return hash.digest("hex").slice(0, 12);
}

/** Image tag for a pi version and optional Dockerfile extension. */
export function imageTag(piVersion: string, dockerfileExtension?: string): string {
  return `${IMAGE_REPOSITORY}:${piVersion}-${fingerprintBuildContext(collectBuildContext(piVersion, dockerfileExtension))}`;
}

function readTree(dir: string, contextDir: string): BuildContextFile[] {
  const files: BuildContextFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Skip node_modules — the Docker build runs npm install for the package
    if (entry.name === "node_modules") continue;
    const sourcePath = path.join(dir, entry.name);
    // POSIX separators: these are paths inside the (Linux) build context.
    const contextPath = `${contextDir}/${entry.name}`;
    // Follow symlinks (a linked-in extension is copied like a real one), but a
    // dangling link must not break every command that resolves the image tag.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(sourcePath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...readTree(sourcePath, contextPath));
    } else if (stat.isFile() && !entry.name.endsWith(".test.ts")) {
      // Tests never run inside the image; leaving them out also keeps a
      // test-only edit from invalidating the image.
      files.push({ path: contextPath, content: fs.readFileSync(sourcePath) });
    }
  }
  return files;
}

function placeholderPackage(): BuildContextFile[] {
  return [
    { path: "package/extensions/.gitkeep", content: Buffer.alloc(0) },
    { path: "package/themes/.gitkeep", content: Buffer.alloc(0) },
    {
      path: "package/package.json",
      content: Buffer.from(
        JSON.stringify(
          {
            name: "wpi-defaults",
            version: "1.0.0",
            private: true,
            description: "No customizations",
            keywords: ["pi-package"],
            pi: {
              extensions: ["./extensions"],
              themes: ["./themes"],
            },
            peerDependencies: {
              "@earendil-works/pi-coding-agent": "*",
            },
          },
          null,
          2
        )
      ),
    },
  ];
}

function placeholderSettings(): BuildContextFile {
  return {
    path: "settings/default-settings.json",
    content: Buffer.from(JSON.stringify({ defaultThinkingLevel: "medium", autoCompact: true }, null, 2)),
  };
}

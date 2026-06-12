// ============================================================
// wpi — Template loading
// ============================================================
// Reads Dockerfile and entrypoint.sh from the templates/
// directory and injects the pi version. The template files
// are plain Dockerfile/bash with {{piVersion}} placeholders.
//
// This keeps the infrastructure code in real files that are
// easy to read and edit, rather than embedded strings.
// ============================================================

import * as path from "path";
import * as fs from "fs";
import { PI_VERSION } from "./config";

// Templates are in the templates/ directory, sibling to dist/
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

/**
 * Load and populate the Dockerfile template.
 * {{piVersion}} is injected with the given version (defaults to the
 * baked-in PI_VERSION constant), and an optional extension block
 * (from .pi/wpi.yml) is appended at the end.
 */
export function generateDockerfile(extension?: string, piVersion: string = PI_VERSION): string {
  const templatePath = path.join(TEMPLATES_DIR, "Dockerfile");
  let content = fs.readFileSync(templatePath, "utf-8");
  content = content.replace(/\{\{piVersion\}\}/g, piVersion);

  if (extension) {
    content =
      content.trimEnd() +
      "\n\n# ---------- Extension from .pi/wpi.yml ----------\n" +
      extension.trimEnd() +
      "\n";
  }

  return content;
}

/**
 * Load the entrypoint.sh template.
 * No dynamic injection needed — it's fully static.
 */
export function generateEntrypoint(): string {
  const templatePath = path.join(TEMPLATES_DIR, "entrypoint.sh");
  return fs.readFileSync(templatePath, "utf-8");
}

// ============================================================
// wpi — Pinned Pi version
// ============================================================
// Kept in its own module so both config resolution and template
// generation can depend on it without depending on each other.
//
// When bumping, update the @earendil-works/* devDependencies in
// package.json to the same version: the bundled extensions are
// typechecked and tested against those packages.
// ============================================================

/** Pi version shipped by this version of wpi. */
export const PI_VERSION = "1.0.0";

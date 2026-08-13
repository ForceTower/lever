/**
 * Strict semver parsing and precedence comparison (spec 0001 §4).
 *
 * Self-contained rather than `Bun.semver` so that "what does a version clause
 * match" is pinned by this code and the contract fixtures, not by a runtime's
 * range semantics. Precedence follows semver.org §11: numeric major/minor/patch,
 * then prerelease (absence ranks higher; identifiers compared numerically when
 * both numeric, ASCII-lexically otherwise). Build metadata is ignored.
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
}

// The official semver.org regex, anchored, with named groups removed.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function parseSemver(input: string): Semver | undefined {
  const match = SEMVER_RE.exec(input);
  if (!match) return undefined;
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease:
      prerelease === undefined
        ? []
        : prerelease.split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)),
  };
}

export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < shared; i++) {
    const idA = a.prerelease[i];
    const idB = b.prerelease[i];
    if (idA === undefined || idB === undefined || idA === idB) continue;
    const numA = typeof idA === "number";
    const numB = typeof idB === "number";
    if (numA && numB) return idA < idB ? -1 : 1;
    if (numA !== numB) return numA ? -1 : 1; // numeric identifiers rank lower
    return idA < idB ? -1 : 1;
  }
  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length < b.prerelease.length ? -1 : 1;
}

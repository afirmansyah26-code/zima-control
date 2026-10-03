/**
 * Zima Control Center — Backup Exclusion Pattern Matcher
 *
 * Deterministic pattern matching for PERSISTENT_FILES exclusion rules.
 * Reference: docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md (Section 4)
 */

/**
 * Converts a glob pattern (e.g. "*.tmp", "cache/**", "temp/*") to a RegExp.
 */
function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim().replace(/\\/g, "/");
  let regexStr = "^";
  let i = 0;

  while (i < normalized.length) {
    const c = normalized[i];
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
          continue;
        } else {
          regexStr += ".*";
          i += 2;
          continue;
        }
      } else {
        regexStr += "[^/]*";
        i++;
        continue;
      }
    } else if (c === "?") {
      regexStr += "[^/]";
      i++;
    } else if ("/[].+^$(){}|".includes(c)) {
      regexStr += `\\${c}`;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }

  regexStr += "(?:/.*)?$";
  return new RegExp(regexStr);
}

/**
 * Checks whether a normalized relative path matches any of the exclusion rules.
 * @param relativePath Relative path from the source root (using forward slashes, e.g. "uploads/photo.jpg")
 * @param exclusions Array of exclusion patterns
 */
export function isPathExcluded(
  relativePath: string,
  exclusions?: readonly string[] | null,
): boolean {
  if (!exclusions || exclusions.length === 0) {
    return false;
  }

  const cleanRelative = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleanRelative) return false;

  for (const rawPattern of exclusions) {
    const pattern = rawPattern.trim().replace(/\\/g, "/");
    if (!pattern) continue;

    // Direct exact match
    if (cleanRelative === pattern || cleanRelative.startsWith(`${pattern}/`)) {
      return true;
    }

    // Basename match (e.g. pattern "*.tmp" or "ignored.txt")
    const basename = cleanRelative.split("/").pop() ?? cleanRelative;
    if (pattern === basename) {
      return true;
    }

    // Glob pattern match
    try {
      const reg = globToRegExp(pattern);
      if (reg.test(cleanRelative) || reg.test(basename)) {
        return true;
      }
    } catch {
      // If regex compilation fails, fallback to simple substring or exact
      if (cleanRelative.includes(pattern)) {
        return true;
      }
    }
  }

  return false;
}

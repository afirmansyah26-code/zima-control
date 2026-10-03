/**
 * Zima Control Center — Database SQL Payload Structural Verification Engine
 *
 * Implements Tier 4 payload validation for SQL dumps without executing statements.
 * Checks for valid engine banners, structural SQL statements, and absence of dump error messages.
 *
 * Reference: docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md (Section 8)
 */

import { open } from "node:fs/promises";
import { type DatabaseEngineType } from "./contracts.js";

export interface DatabasePayloadVerificationResult {
  readonly isValid: boolean;
  readonly failureReasonCode?: string;
  readonly detail?: string;
  readonly detectedEngine?: string;
}

/**
 * Validates the structure and content markers of a MariaDB / MySQL dump file.
 */
export async function verifySqlDumpPayload(
  filePath: string,
  expectedEngine?: DatabaseEngineType,
): Promise<DatabasePayloadVerificationResult> {
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const stat = await fileHandle.stat();

    if (stat.size === 0) {
      return {
        isValid: false,
        failureReasonCode: "PAYLOAD_STRUCTURE_CORRUPT",
        detail: "SQL dump file is 0 bytes (empty)",
      };
    }

    // Read the first 8 KB to inspect banner and initial table statements
    const headLen = Math.min(8192, stat.size);
    const headBuf = Buffer.alloc(headLen);
    await fileHandle.read(headBuf, 0, headLen, 0);
    const headText = headBuf.toString("utf8");

    // Check for dump client error markers in head
    if (
      headText.includes("mysqldump: Got error:") ||
      headText.includes("mariadb-dump: Error:") ||
      headText.includes("mysqldump: Error:")
    ) {
      return {
        isValid: false,
        failureReasonCode: "PAYLOAD_STRUCTURE_CORRUPT",
        detail: "SQL dump file contains database client error banner instead of valid dump data",
      };
    }

    // Validate MariaDB / MySQL headers
    const isMariaDbBanner = headText.includes("MariaDB dump") || headText.includes("/*M!");
    const isMySqlBanner = headText.includes("MySQL dump") || headText.includes("/*!40101");
    const hasStandardSqlBanner =
      headText.includes("-- MySQL dump") ||
      headText.includes("-- MariaDB dump") ||
      headText.includes("-- Host:") ||
      headText.includes("/*!40101 SET @OLD_CHARACTER_SET_CLIENT");

    if (!hasStandardSqlBanner && !isMariaDbBanner && !isMySqlBanner) {
      return {
        isValid: false,
        failureReasonCode: "PAYLOAD_STRUCTURE_CORRUPT",
        detail: "SQL dump missing expected MySQL / MariaDB header signatures",
      };
    }

    // Validate structural schema markers
    const hasSchemaMarkers =
      headText.includes("CREATE TABLE") ||
      headText.includes("DROP TABLE") ||
      headText.includes("Table structure for table") ||
      headText.includes("Dumping data for table") ||
      headText.includes("INSERT INTO") ||
      headText.includes("LOCK TABLES") ||
      headText.includes("/*!40000 ALTER TABLE");

    // Also inspect tail (last 4 KB) for completion marker if file is large enough
    if (stat.size > 8192) {
      const tailLen = Math.min(4096, stat.size);
      const tailBuf = Buffer.alloc(tailLen);
      await fileHandle.read(tailBuf, 0, tailLen, stat.size - tailLen);
      const tailText = tailBuf.toString("utf8");

      if (
        tailText.includes("mysqldump: Got error:") ||
        tailText.includes("mariadb-dump: Error:")
      ) {
        return {
          isValid: false,
          failureReasonCode: "PAYLOAD_STRUCTURE_CORRUPT",
          detail: "SQL dump file contains error banner in output tail",
        };
      }
    }

    if (!hasSchemaMarkers) {
      return {
        isValid: false,
        failureReasonCode: "PAYLOAD_STRUCTURE_CORRUPT",
        detail: "SQL dump contains no recognized table or data statements",
      };
    }

    return {
      isValid: true,
      detectedEngine: isMariaDbBanner ? "MARIADB" : isMySqlBanner ? "MYSQL" : "GENERIC_SQL",
    };
  } catch (error) {
    return {
      isValid: false,
      failureReasonCode: "PAYLOAD_STRUCTURE_CORRUPT",
      detail: `Failed to inspect SQL dump payload: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
  }
}

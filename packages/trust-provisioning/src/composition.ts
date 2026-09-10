import type { PrismaClient } from "@prisma/client";
import { PrismaTrustRepository } from "@zima-control-center/core/trust-persistence-internal";
import { TrustProvisioningCoordinator, type ProvisioningCoordinatorOptions } from "./coordinator.js";
import type { TrustFilesystem } from "./filesystem.js";

export function createTrustProvisioningCoordinator(
  prisma: PrismaClient,
  filesystem: TrustFilesystem,
  options: ProvisioningCoordinatorOptions,
): TrustProvisioningCoordinator {
  return new TrustProvisioningCoordinator(new PrismaTrustRepository(prisma), filesystem, options);
}

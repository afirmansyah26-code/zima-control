import type { PrismaClient } from "@zima-control-center/trust-prisma-client";
import { PrismaTrustRepository } from "@zima-control-center/trust-persistence";
import { TrustProvisioningCoordinator, type ProvisioningCoordinatorOptions } from "./coordinator.js";
import type { TrustFilesystem } from "./filesystem.js";

export function createTrustProvisioningCoordinator(
  prisma: PrismaClient,
  filesystem: TrustFilesystem,
  options: ProvisioningCoordinatorOptions,
): TrustProvisioningCoordinator {
  return new TrustProvisioningCoordinator(new PrismaTrustRepository(prisma), filesystem, options);
}

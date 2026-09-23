/** Optional operator CLI; the scheduled Lambda uses the same implementation. */
import { prisma } from "../src/lib/prisma";
import { reconcileKubernetesLabs } from "../src/lib/recruit/reconcile-kubernetes-labs";

reconcileKubernetesLabs(prisma).then((summary) => {
  console.log(JSON.stringify(summary));
  if (summary.failed) process.exitCode = 1;
}).catch(() => {
  console.error("Lab reconciliation failed. Check server configuration and runtime availability.");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());

/** Build only; does not read cloud secrets, migrate the DB, or deploy resources. */
import { build } from "esbuild";
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(join(root, "build"), { recursive: true });
const staging = await mkdtemp(join(root, "build", "lab-reconcile-"));
const artifact = join(staging, "artifact");
await mkdir(artifact);
const generated = join(artifact, "node_modules", ".prisma", "client");
const schema = (await readFile(join(root, "prisma", "schema.prisma"), "utf8")).replace(
  /generator client\s*\{[^}]*\}/,
  `generator client {\n  provider = "prisma-client-js"\n  output = ${JSON.stringify(generated.replaceAll("\\", "/"))}\n  binaryTargets = ["rhel-openssl-3.0.x"]\n}`,
);
const schemaPath = join(staging, "schema.prisma");
await writeFile(schemaPath, schema);
await new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, [join(root, "node_modules", "prisma", "build", "index.js"), "generate", "--schema", schemaPath], {
    cwd: root, shell: false, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, DATABASE_URL: "postgresql://build:build@localhost:5432/build", PRISMA_GENERATE_SKIP_AUTOINSTALL: "true" },
  });
  child.once("error", reject);
  child.once("close", (code) => code === 0 ? resolveRun() : reject(new Error("Prisma client generation failed")));
});
await stat(join(generated, "libquery_engine-rhel-openssl-3.0.x.so.node"));
await cp(join(root, "node_modules", "@prisma", "client"), join(artifact, "node_modules", "@prisma", "client"), { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ["infra/kubernetes-labs/reconciliation/handler.ts"],
  outfile: join(artifact, "index.js"), bundle: true, platform: "node", target: "node22", format: "cjs",
  external: ["@prisma/client"], tsconfig: join(root, "tsconfig.json"), legalComments: "none",
});
await writeFile(join(artifact, "package.json"), JSON.stringify({ name: "uniqassess-lab-reconciler", private: true, type: "commonjs" }));
await writeFile(join(root, "build", "lab-reconciler-artifact.json"), JSON.stringify({ artifact, zip: `${staging}.zip` }));
console.log(JSON.stringify({ artifact, zip: `${staging}.zip`, runtime: "nodejs22.x", architecture: "x86_64", handler: "index.handler" }));

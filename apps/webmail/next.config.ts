import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

let gitCommitHash = "unknown";
try {
  gitCommitHash = execSync("git rev-parse --short HEAD").toString().trim();
} catch {
  // git not available
}

let appVersion = "0.0.0";
try {
  appVersion = readFileSync(join(import.meta.dirname, "VERSION"), "utf-8").trim();
} catch {
  // VERSION file not found
}

// Subpath deployment, e.g. NEXT_PUBLIC_BASE_PATH=/webmail. Read at build time
// because Next.js bakes basePath into emitted asset URLs and route metadata.
// Trailing slash is stripped; an empty/missing value disables the feature.
const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH?.trim() ?? "";
const basePath = rawBasePath.replace(/\/+$/, "");
if (basePath && !basePath.startsWith("/")) {
  throw new Error(
    `NEXT_PUBLIC_BASE_PATH must start with "/" (got: ${JSON.stringify(rawBasePath)})`
  );
}

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["192.168.1.51"],
  basePath: basePath || undefined,
  turbopack: {
    root: import.meta.dirname,
  },
  env: {
    NEXT_PUBLIC_GIT_COMMIT: gitCommitHash,
    NEXT_PUBLIC_APP_VERSION: appVersion,
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);

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

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["192.168.1.51"],
  turbopack: {
    root: import.meta.dirname,
  },
  env: {
    NEXT_PUBLIC_GIT_COMMIT: gitCommitHash,
    NEXT_PUBLIC_APP_VERSION: appVersion,
  },
};

const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);

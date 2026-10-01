/** @type {import('next').NextConfig} */
const nextConfig = {
  // The APG packages are symlinked (link:) into the built pnpm workspace and
  // read schema/template files with node:fs — keep them external so route
  // handlers load them natively instead of bundling them.
  serverExternalPackages: ["@apgraph/core", "@apgraph/connectors", "@apgraph/schema"],
};

export default nextConfig;

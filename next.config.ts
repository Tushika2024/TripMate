import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PayPal Agent Toolkit pulls in server-only deps; keep it out of the client bundle.
  serverExternalPackages: ["@paypal/agent-toolkit"],
};

export default nextConfig;

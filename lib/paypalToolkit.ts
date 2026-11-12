// PayPal Agent Toolkit (official): exposes PayPal APIs as AI-SDK tools.
// The agent only gets READ access (get_order). Money-moving actions are executed
// by our backend after human approval, never directly by the model.
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";

let toolkit: PayPalAgentToolkit | null = null;

export function paypalReadTools() {
  if (!toolkit) {
    toolkit = new PayPalAgentToolkit({
      clientId: process.env.PAYPAL_CLIENT_ID || "",
      clientSecret: process.env.PAYPAL_CLIENT_SECRET || "",
      configuration: {
        actions: { orders: { get: true } },
        context: { sandbox: (process.env.PAYPAL_API_BASE || "sandbox").includes("sandbox") },
      },
    });
  }
  return toolkit.getTools(); // { get_order }
}

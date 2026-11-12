// Runs once when the Next.js server starts: launch the autopilot loop (Node runtime only).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAutopilot } = await import("./lib/autopilot");
    startAutopilot();
  }
}

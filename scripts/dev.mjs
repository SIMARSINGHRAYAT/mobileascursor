import { spawn } from "node:child_process";

console.log("\n=======================================================");
console.log("  🚀 Starting Mobile as Cursor (Next.js + Companion)");
console.log("=======================================================\n");

// 1. Start Companion Server (Windows Input Injector + Relay)
const companion = spawn("npx", ["tsx", "companion/src/index.ts"], {
  stdio: "inherit",
  shell: true,
});

// 2. Start Next.js Development Server
const next = spawn("npx", ["next", "dev"], {
  stdio: "inherit",
  shell: true,
});

function cleanup() {
  try {
    companion.kill();
    next.kill();
  } catch {
    // Ignore
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("exit", cleanup);

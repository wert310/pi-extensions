/**
 * Rate Limit Handler Extension
 * 
 * Adds proper backoff for 429 rate limit errors, especially for TU Wien endpoint.
 * Instead of immediate retry, waits for a configurable duration before retrying.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Default delay for rate limit errors (in milliseconds)
const DEFAULT_RATE_LIMIT_DELAY_MS = 60000; // 60 seconds

// Pattern to detect rate limit errors
const RATE_LIMIT_PATTERNS = [
  /429/i,
  /rate\s*limit/i,
  /too\s*many\s*requests/i,
  /request\s*limit/i,
];

export default function (pi: ExtensionAPI) {
  let lastRateLimitTime = 0;
  let rateLimitCount = 0;
  let rateLimitDelayMs = DEFAULT_RATE_LIMIT_DELAY_MS;

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Rate limit handler loaded. Will wait 60s before retrying on 429 errors.", "info");
  });

  pi.on("error", async (event, ctx) => {
    const errorMessage = event.error?.message || event.error?.toString() || "";
    
    // Check if this is a rate limit error
    const isRateLimit = RATE_LIMIT_PATTERNS.some(pattern => pattern.test(errorMessage));
    
    if (isRateLimit) {
      const now = Date.now();
      rateLimitCount++;
      
      // Calculate delay with exponential backoff for repeated rate limits
      // First occurrence: 60s, Second: 90s, Third+: 120s
      let delayMs = DEFAULT_RATE_LIMIT_DELAY_MS;
      if (rateLimitCount >= 2) delayMs = 90000;
      if (rateLimitCount >= 3) delayMs = 120000;
      
      ctx.ui.notify(
        `Rate limit detected. Waiting ${delayMs / 1000}s before retry... (count: ${rateLimitCount})`,
        "warning"
      );
      
      lastRateLimitTime = now;
      
      // Wait for the delay
      await new Promise(resolve => setTimeout(resolve, delayMs));
      
      ctx.ui.notify("Resuming after rate limit delay...", "info");
    }
  });

  // Reset rate limit counter on successful completion
  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "assistant" && event.message.stopReason === "stop") {
      // Successful response, reset counter
      rateLimitCount = 0;
    }
  });

  // Command to check rate limit status
  pi.registerCommand("rate-limit-status", {
    description: "Show rate limit handler status",
    handler: async (_args, ctx) => {
      const lastHit = lastRateLimitTime ? 
        `${Math.round((Date.now() - lastRateLimitTime) / 1000)}s ago` : 
        "never";
      ctx.ui.notify(
        `Rate limit status:\n- Count: ${rateLimitCount}\n- Last hit: ${lastHit}\n- Current delay: ${rateLimitDelayMs / 1000}s`,
        "info"
      );
    }
  });

  // Command to reset rate limit counter
  pi.registerCommand("rate-limit-reset", {
    description: "Reset rate limit counter",
    handler: async (_args, ctx) => {
      rateLimitCount = 0;
      lastRateLimitTime = 0;
      ctx.ui.notify("Rate limit counter reset.", "info");
    }
  });
}

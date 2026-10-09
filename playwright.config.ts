import { defineConfig } from "@playwright/test";

// No webServer: these tests exercise the chroma-key against synthetic frames,
// so they don't need the Next app, a LiveKit token, or a live avatar.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    headless: true,
  },
});

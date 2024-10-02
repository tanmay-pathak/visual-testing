import process from "node:process";
import { performUrlComparison } from "./visual-testing-utils.ts";

/**
 * Main function to run the visual tests.
 */
async function main() {
  const args = process.argv.slice(2);
  const url1 = args[0];
  const url2 = args[1];
  if (!url1 || !url2) {
    process.exit(1);
  }

  await performUrlComparison(url1, url2);
}

main().catch(console.error);

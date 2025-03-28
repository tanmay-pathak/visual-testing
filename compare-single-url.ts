import process from "node:process";
import {
  DEFAULT_VIEWPORT_WIDTH,
  performUrlComparison,
} from "./visual-testing-utils.ts";

/**
 * Main function to run the visual tests.
 *
 * Usage: node compare-single-url.js <url1> <url2> [width]
 * Example: deno --allow-read --allow-env --allow-sys --allow-ffi --allow-write --allow-run --allow-net compare-single-url.ts https://zu.com/work https://deploy-preview-198--zuc-web.netlify.app/work 1500
 */
async function main() {
  const args = process.argv.slice(2);
  const url1 = args[0];
  const url2 = args[1];
  // Check if third argument is a number for width
  const viewportWidth = args[2] && !isNaN(Number(args[2]))
    ? Number(args[2])
    : DEFAULT_VIEWPORT_WIDTH;

  if (!url1 || !url2) {
    console.error(
      "Please provide two URLs to compare as command-line arguments.",
    );
    console.error(
      "Example: npx ts-node compare-single-url.ts https://zu.com/about https://deploy-preview-198--zuc-web.netlify.app/about [width]",
    );
    process.exit(1);
  }

  await performUrlComparison(url1, url2, viewportWidth);
}

main().catch(console.error);

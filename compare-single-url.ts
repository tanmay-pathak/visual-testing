import process from "node:process";
import { parseArgs } from "node:util";
import {
  createRunSubdirectory,
  getErrorMessage,
  performUrlComparison,
} from "./visual-testing-utils.ts";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;

function printHelp(): void {
  console.log(`Usage:
  deno run --env-file=.env --allow-all compare-single-url.ts <url_1> <url_2> [options]

Options:
  --timeout-ms <ms>      Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --retries <n>          Retries for screenshot requests (default: ${DEFAULT_RETRIES})
  --retry-delay-ms <ms>  Base retry delay (default: ${DEFAULT_RETRY_DELAY_MS})
  --run-name <name>      Optional label for the run output folder
  --help, -h             Show this help
`);
}

function parsePositiveInt(
  value: string | undefined,
  flagName: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for --${flagName}: ${value}`);
  }

  return parsed;
}

/**
 * Main function to run the visual tests.
 */
async function main(): Promise<number> {
  let parsedArgs;

  try {
    parsedArgs = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        "timeout-ms": { type: "string" },
        retries: { type: "string" },
        "retry-delay-ms": { type: "string" },
        "run-name": { type: "string" },
      },
    });
  } catch (error) {
    console.error(getErrorMessage(error));
    printHelp();
    return 1;
  }

  if (parsedArgs.values.help) {
    printHelp();
    return 0;
  }

  const url1 = parsedArgs.positionals[0];
  const url2 = parsedArgs.positionals[1];

  if (!url1 || !url2) {
    console.error("Please provide both URL positional arguments.");
    printHelp();
    return 1;
  }

  try {
    const runChangesDir = await createRunSubdirectory(
      "changes",
      "single-url",
      parsedArgs.values["run-name"],
    );
    console.log(`Diff output directory: ${runChangesDir}`);

    await performUrlComparison(url1, url2, {
      timeoutMs:
        parsePositiveInt(parsedArgs.values["timeout-ms"], "timeout-ms") ??
          DEFAULT_TIMEOUT_MS,
      retries: parsePositiveInt(parsedArgs.values.retries, "retries") ??
        DEFAULT_RETRIES,
      retryDelayMs: parsePositiveInt(
        parsedArgs.values["retry-delay-ms"],
        "retry-delay-ms",
      ) ?? DEFAULT_RETRY_DELAY_MS,
    }, runChangesDir);

    return 0;
  } catch (error) {
    console.error(`Failed to compare URLs: ${getErrorMessage(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await main();
  if (code !== 0) {
    process.exit(code);
  }
}

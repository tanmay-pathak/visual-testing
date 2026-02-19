import pLimit from "p-limit";
import process from "node:process";
import { parseArgs } from "node:util";
import { fetchSitemapUrls } from "./sitemap-utils.ts";
import { getErrorMessage, logError } from "./visual-testing-utils.ts";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_WARN_THRESHOLD = 10;

interface ScriptConfig {
  sitemapUrl?: string;
  concurrency: number;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  maxUrls?: number;
  yes: boolean;
  help: boolean;
}

function printHelp(): void {
  console.log(`Usage:
  deno run --allow-all open-sitemap-urls.ts <sitemap_url> [options]

Options:
  --concurrency <n>      Number of parallel Safari open commands (default: ${DEFAULT_CONCURRENCY})
  --timeout-ms <ms>      Sitemap request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --retries <n>          Retries for sitemap fetch (default: ${DEFAULT_RETRIES})
  --retry-delay-ms <ms>  Base retry delay (default: ${DEFAULT_RETRY_DELAY_MS})
  --max-urls <n>         Open at most n URLs
  --yes                  Skip the large-run confirmation wait
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

function getScriptConfig(args: string[]): ScriptConfig {
  const parsedArgs = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      concurrency: { type: "string" },
      "timeout-ms": { type: "string" },
      retries: { type: "string" },
      "retry-delay-ms": { type: "string" },
      "max-urls": { type: "string" },
      yes: { type: "boolean" },
    },
  });

  return {
    sitemapUrl: parsedArgs.positionals[0],
    concurrency:
      parsePositiveInt(parsedArgs.values.concurrency, "concurrency") ??
        DEFAULT_CONCURRENCY,
    timeoutMs:
      parsePositiveInt(parsedArgs.values["timeout-ms"], "timeout-ms") ??
        DEFAULT_TIMEOUT_MS,
    retries: parsePositiveInt(parsedArgs.values.retries, "retries") ??
      DEFAULT_RETRIES,
    retryDelayMs: parsePositiveInt(
      parsedArgs.values["retry-delay-ms"],
      "retry-delay-ms",
    ) ?? DEFAULT_RETRY_DELAY_MS,
    maxUrls: parsePositiveInt(parsedArgs.values["max-urls"], "max-urls"),
    yes: parsedArgs.values.yes ?? false,
    help: parsedArgs.values.help ?? false,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens a URL in Safari.
 */
async function openUrlInSafari(url: string): Promise<boolean> {
  try {
    console.log(`Opening URL in Safari: ${url}`);

    const command = new Deno.Command("open", {
      args: ["-a", "Safari", url],
    });

    const { code, stderr } = await command.output();

    if (code !== 0) {
      const stderrText = new TextDecoder().decode(stderr).trim();
      throw new Error(stderrText || `open command failed with code ${code}`);
    }

    await sleep(1_000);
    return true;
  } catch (error) {
    logError(`Error opening URL in Safari: ${url}`, error);
    return false;
  }
}

/**
 * Main function to open URLs from a sitemap in Safari.
 */
async function main(): Promise<number> {
  let config: ScriptConfig;

  try {
    config = getScriptConfig(process.argv.slice(2));
  } catch (error) {
    console.error(getErrorMessage(error));
    printHelp();
    return 1;
  }

  if (config.help) {
    printHelp();
    return 0;
  }

  if (!config.sitemapUrl) {
    console.error(
      "Please provide a sitemap URL as the first positional argument.",
    );
    printHelp();
    return 1;
  }

  try {
    const urls = await fetchSitemapUrls(config.sitemapUrl, {
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      retryDelayMs: config.retryDelayMs,
      maxUrls: config.maxUrls,
    });

    if (urls.length === 0) {
      console.error("No URLs found in the sitemap.");
      return 1;
    }

    if (urls.length > DEFAULT_WARN_THRESHOLD && !config.yes) {
      console.log(`Warning: About to open ${urls.length} URLs in Safari.`);
      console.log("Press Ctrl+C to cancel or wait 5 seconds to continue...");
      await sleep(5_000);
    }

    const limit = pLimit(config.concurrency);
    let failedCount = 0;

    const tasks = urls.map((url) =>
      limit(async () => {
        const success = await openUrlInSafari(url);
        if (!success) {
          failedCount++;
        }
      })
    );

    await Promise.all(tasks);

    if (failedCount > 0) {
      console.error(`Finished with ${failedCount} URL open failure(s).`);
      return 1;
    }

    console.log("All URLs have been opened in Safari.");
    return 0;
  } catch (error) {
    console.error(`Error in main process: ${getErrorMessage(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await main();
  if (code !== 0) {
    process.exit(code);
  }
}

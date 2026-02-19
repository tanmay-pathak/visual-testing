export type FieldType = "string" | "url" | "int" | "boolean";

export interface TaskFieldDefinition {
  key: string;
  label: string;
  description?: string;
  type: FieldType;
  required?: boolean;
  positional?: number;
  flag?: string;
  defaultValue?: string | number | boolean;
  advanced?: boolean;
}

export interface TaskDefinition {
  id: string;
  label: string;
  description: string;
  advanced?: boolean;
  preRunWarning?: string;
  fields: TaskFieldDefinition[];
}

export const TASK_MANIFEST: TaskDefinition[] = [
  {
    id: "compare:prod-preview",
    label: "Compare prod vs preview (sitemap)",
    description:
      "Compares production URLs from a sitemap against a preview domain and writes visual diffs.",
    fields: [
      {
        key: "sitemapUrl",
        label: "Sitemap URL",
        description: "Production sitemap URL.",
        type: "url",
        required: true,
        positional: 0,
      },
      {
        key: "previewDomain",
        label: "Preview domain",
        description: "Preview domain or full URL (optional).",
        type: "string",
        positional: 1,
      },
      {
        key: "runName",
        label: "Run name",
        description: "Readable label for output folder name.",
        type: "string",
        flag: "run-name",
      },
      {
        key: "maxUrls",
        label: "Max URLs",
        description: "Process at most this many filtered sitemap URLs.",
        type: "int",
        flag: "max-urls",
      },
      {
        key: "screenshotConcurrency",
        label: "Screenshot concurrency",
        description: "Parallel screenshot requests.",
        type: "int",
        flag: "concurrency",
        advanced: true,
      },
      {
        key: "comparisonConcurrency",
        label: "Comparison concurrency",
        description: "Parallel pixel comparisons.",
        type: "int",
        flag: "comparison-concurrency",
        advanced: true,
      },
      {
        key: "fileIoConcurrency",
        label: "File I/O concurrency",
        description: "Parallel file writes.",
        type: "int",
        flag: "file-io-concurrency",
        advanced: true,
      },
      {
        key: "timeoutMs",
        label: "Timeout (ms)",
        type: "int",
        flag: "timeout-ms",
        advanced: true,
      },
      {
        key: "retries",
        label: "Retries",
        type: "int",
        flag: "retries",
        advanced: true,
      },
      {
        key: "retryDelayMs",
        label: "Retry delay (ms)",
        type: "int",
        flag: "retry-delay-ms",
        advanced: true,
      },
      {
        key: "cacheTtlMs",
        label: "Cache TTL (ms)",
        type: "int",
        flag: "cache-ttl-ms",
        advanced: true,
      },
      {
        key: "cacheCleanupAgeMs",
        label: "Cache cleanup age (ms)",
        type: "int",
        flag: "cache-cleanup-age-ms",
        advanced: true,
      },
      {
        key: "noCache",
        label: "Disable cache",
        description: "Set --no-cache.",
        type: "boolean",
        flag: "no-cache",
        defaultValue: false,
        advanced: true,
      },
    ],
  },
  {
    id: "compare:url",
    label: "Compare two URLs",
    description: "Compares screenshots for two URLs and writes a visual diff.",
    fields: [
      {
        key: "url1",
        label: "URL 1",
        type: "url",
        required: true,
        positional: 0,
      },
      {
        key: "url2",
        label: "URL 2",
        type: "url",
        required: true,
        positional: 1,
      },
      {
        key: "runName",
        label: "Run name",
        description: "Readable label for output folder name.",
        type: "string",
        flag: "run-name",
      },
      {
        key: "timeoutMs",
        label: "Timeout (ms)",
        type: "int",
        flag: "timeout-ms",
        advanced: true,
      },
      {
        key: "retries",
        label: "Retries",
        type: "int",
        flag: "retries",
        advanced: true,
      },
      {
        key: "retryDelayMs",
        label: "Retry delay (ms)",
        type: "int",
        flag: "retry-delay-ms",
        advanced: true,
      },
    ],
  },
  {
    id: "compare:branches",
    label: "Compare current branch vs target branch",
    description:
      "Checks out main + target branch and compares one URL screenshot.",
    preRunWarning:
      "This task requires a clean git working tree. The underlying script enforces this.",
    fields: [
      {
        key: "url",
        label: "URL",
        type: "url",
        required: true,
        positional: 0,
      },
      {
        key: "branchName",
        label: "Branch name",
        type: "string",
        required: true,
        positional: 1,
      },
      {
        key: "runName",
        label: "Run name",
        description: "Readable label for output folder name.",
        type: "string",
        flag: "run-name",
      },
      {
        key: "timeoutMs",
        label: "Timeout (ms)",
        type: "int",
        flag: "timeout-ms",
        advanced: true,
      },
      {
        key: "retries",
        label: "Retries",
        type: "int",
        flag: "retries",
        advanced: true,
      },
      {
        key: "retryDelayMs",
        label: "Retry delay (ms)",
        type: "int",
        flag: "retry-delay-ms",
        advanced: true,
      },
    ],
  },
  {
    id: "sitemap:screenshots",
    label: "Take sitemap screenshots",
    description: "Fetches sitemap URLs and saves screenshots.",
    fields: [
      {
        key: "sitemapUrl",
        label: "Sitemap URL",
        type: "url",
        required: true,
        positional: 0,
      },
      {
        key: "maxUrls",
        label: "Max URLs",
        description: "Process at most this many URLs.",
        type: "int",
        flag: "max-urls",
      },
      {
        key: "concurrency",
        label: "Concurrency",
        type: "int",
        flag: "concurrency",
        advanced: true,
      },
      {
        key: "timeoutMs",
        label: "Timeout (ms)",
        type: "int",
        flag: "timeout-ms",
        advanced: true,
      },
      {
        key: "retries",
        label: "Retries",
        type: "int",
        flag: "retries",
        advanced: true,
      },
      {
        key: "retryDelayMs",
        label: "Retry delay (ms)",
        type: "int",
        flag: "retry-delay-ms",
        advanced: true,
      },
    ],
  },
  {
    id: "sitemap:open",
    label: "Open sitemap URLs in Safari",
    description: "Fetches sitemap URLs and opens them in Safari.",
    fields: [
      {
        key: "sitemapUrl",
        label: "Sitemap URL",
        type: "url",
        required: true,
        positional: 0,
      },
      {
        key: "maxUrls",
        label: "Max URLs",
        description: "Open at most this many URLs.",
        type: "int",
        flag: "max-urls",
      },
      {
        key: "yes",
        label: "Skip large-run warning",
        description: "Set --yes to skip 5 second wait on large runs.",
        type: "boolean",
        flag: "yes",
        defaultValue: false,
      },
      {
        key: "concurrency",
        label: "Concurrency",
        type: "int",
        flag: "concurrency",
        advanced: true,
      },
      {
        key: "timeoutMs",
        label: "Timeout (ms)",
        type: "int",
        flag: "timeout-ms",
        advanced: true,
      },
      {
        key: "retries",
        label: "Retries",
        type: "int",
        flag: "retries",
        advanced: true,
      },
      {
        key: "retryDelayMs",
        label: "Retry delay (ms)",
        type: "int",
        flag: "retry-delay-ms",
        advanced: true,
      },
    ],
  },
  {
    id: "check",
    label: "Run static checks",
    description: "Runs format check, lint, and type checking.",
    advanced: true,
    fields: [],
  },
  {
    id: "test",
    label: "Run tests",
    description: "Runs Deno tests.",
    advanced: true,
    fields: [],
  },
];

export function getTaskDefinitionById(
  taskId: string,
): TaskDefinition | undefined {
  return TASK_MANIFEST.find((task) => task.id === taskId);
}

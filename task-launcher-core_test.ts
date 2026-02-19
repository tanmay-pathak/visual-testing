import {
  buildCommandArgs,
  loadHistory,
  mergeTaskValues,
  saveHistory,
  validateField,
} from "./task-launcher-core.ts";
import { getTaskDefinitionById } from "./task-manifest.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T): void {
  const actualSerialized = JSON.stringify(actual);
  const expectedSerialized = JSON.stringify(expected);

  assert(
    actualSerialized === expectedSerialized,
    `Expected ${expectedSerialized}, got ${actualSerialized}`,
  );
}

function getTask(taskId: string) {
  const task = getTaskDefinitionById(taskId);
  assert(!!task, `Expected task ${taskId} to exist`);
  return task!;
}

Deno.test("buildCommandArgs builds required-only args for main user tasks", () => {
  assertEquals(
    buildCommandArgs(getTask("compare:prod-preview"), {
      sitemapUrl: "https://example.com/sitemap.xml",
    }),
    ["compare:prod-preview", "https://example.com/sitemap.xml"],
  );

  assertEquals(
    buildCommandArgs(getTask("compare:url"), {
      url1: "https://example.com/one",
      url2: "https://example.com/two",
    }),
    ["compare:url", "https://example.com/one", "https://example.com/two"],
  );

  assertEquals(
    buildCommandArgs(getTask("compare:branches"), {
      url: "https://example.com/work",
      branchName: "feature/test",
    }),
    ["compare:branches", "https://example.com/work", "feature/test"],
  );

  assertEquals(
    buildCommandArgs(getTask("sitemap:screenshots"), {
      sitemapUrl: "https://example.com/sitemap.xml",
    }),
    ["sitemap:screenshots", "https://example.com/sitemap.xml"],
  );

  assertEquals(
    buildCommandArgs(getTask("sitemap:open"), {
      sitemapUrl: "https://example.com/sitemap.xml",
    }),
    ["sitemap:open", "https://example.com/sitemap.xml"],
  );
});

Deno.test("buildCommandArgs includes optional flags and omits false boolean flags", () => {
  const args = buildCommandArgs(getTask("sitemap:open"), {
    sitemapUrl: "https://example.com/sitemap.xml",
    maxUrls: 20,
    yes: true,
    timeoutMs: 60_000,
    retries: 3,
  });

  assertEquals(args, [
    "sitemap:open",
    "https://example.com/sitemap.xml",
    "--max-urls",
    "20",
    "--yes",
    "--timeout-ms",
    "60000",
    "--retries",
    "3",
  ]);

  const falseBooleanArgs = buildCommandArgs(getTask("sitemap:open"), {
    sitemapUrl: "https://example.com/sitemap.xml",
    yes: false,
  });

  assertEquals(falseBooleanArgs, [
    "sitemap:open",
    "https://example.com/sitemap.xml",
  ]);
});

Deno.test("validateField rejects non-positive integers", () => {
  const maxUrlsField = getTask("sitemap:open").fields.find((field) =>
    field.key === "maxUrls"
  );
  assert(!!maxUrlsField, "Expected maxUrls field");

  assertEquals(validateField(maxUrlsField!, "0").valid, false);
  assertEquals(validateField(maxUrlsField!, "-5").valid, false);
  assertEquals(validateField(maxUrlsField!, "abc").valid, false);
  assertEquals(validateField(maxUrlsField!, "10").valid, true);
});

Deno.test("validateField rejects malformed URLs", () => {
  const urlField = getTask("compare:url").fields.find((field) =>
    field.key === "url1"
  );
  assert(!!urlField, "Expected url1 field");

  assertEquals(validateField(urlField!, "not-a-url").valid, false);
  assertEquals(
    validateField(urlField!, "https://example.com/path").valid,
    true,
  );
});

Deno.test("mergeTaskValues uses defaults, then history, then current input", () => {
  const task = getTask("compare:prod-preview");

  const merged = mergeTaskValues(
    task,
    {
      noCache: true,
      runName: "old-run",
    },
    {
      runName: "new-run",
      noCache: false,
    },
  );

  assertEquals(merged.noCache, false);
  assertEquals(merged.runName, "new-run");
});

Deno.test("unknown history fields are ignored safely by merge and command build", () => {
  const task = getTask("compare:url");

  const merged = mergeTaskValues(
    task,
    {
      unknownField: "ignored",
      runName: "from-history",
    },
    {
      url1: "https://example.com/one",
      url2: "https://example.com/two",
    },
  );

  assertEquals(merged.unknownField, undefined);

  const args = buildCommandArgs(task, {
    ...merged,
    unknownField: "still-ignored",
  });

  assertEquals(args, [
    "compare:url",
    "https://example.com/one",
    "https://example.com/two",
    "--run-name",
    "from-history",
  ]);
});

Deno.test("loadHistory handles missing/corrupt files and saveHistory roundtrips", async () => {
  const readPermission = await Deno.permissions.query({ name: "read" });
  const writePermission = await Deno.permissions.query({ name: "write" });
  if (
    readPermission.state !== "granted" || writePermission.state !== "granted"
  ) {
    console.log(
      "Skipping history file roundtrip test without read/write permissions.",
    );
    return;
  }

  const tempDir = await Deno.makeTempDir();

  try {
    const historyPath = `${tempDir}/history.json`;

    const missingHistory = await loadHistory(historyPath);
    assertEquals(missingHistory, {});

    await Deno.writeTextFile(historyPath, "{ this is not valid json");
    const corruptHistory = await loadHistory(historyPath);
    assertEquals(corruptHistory, {});

    const history = {
      "compare:url": {
        url1: "https://example.com/one",
        runName: "sample",
      },
    };

    await saveHistory(historyPath, history);
    const loaded = await loadHistory(historyPath);
    assertEquals(loaded, history);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

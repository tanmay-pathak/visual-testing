import process from "node:process";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  getTaskDefinitionById,
  TASK_MANIFEST,
  type TaskDefinition,
  type TaskFieldDefinition,
} from "./task-manifest.ts";
import {
  buildCommandArgs,
  getVisibleTasks,
  loadHistory,
  mergeTaskValues,
  saveHistory,
  type TaskHistory,
  type TaskValue,
  type TaskValueMap,
  validateField,
} from "./task-launcher-core.ts";

const HISTORY_PATH = path.join(".cache", "task-launcher-history.json");

interface LauncherFlags {
  task?: string;
  advanced: boolean;
  dryRun: boolean;
  noHistory: boolean;
  help: boolean;
}

function printHelp(): void {
  console.log(`Usage:
  deno task ui [options]

Options:
  --task <taskId>   Preselect a task and skip the task menu
  --advanced        Show advanced tasks and advanced fields
  --dry-run         Print resolved command without executing
  --no-history      Do not read/write remembered values
  --help, -h        Show this help
`);
}

function parseLauncherFlags(args: string[]): LauncherFlags {
  const parsedArgs = parseArgs({
    args,
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h" },
      task: { type: "string" },
      advanced: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "no-history": { type: "boolean" },
    },
  });

  return {
    task: parsedArgs.values.task,
    advanced: parsedArgs.values.advanced ?? false,
    dryRun: parsedArgs.values["dry-run"] ?? false,
    noHistory: parsedArgs.values["no-history"] ?? false,
    help: parsedArgs.values.help ?? false,
  };
}

function shellQuoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) {
    return arg;
  }

  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function commandPreview(command: string[]): string {
  return command.map(shellQuoteArg).join(" ");
}

function printTaskMenu(tasks: TaskDefinition[]): void {
  console.log("Available tasks:");
  tasks.forEach((task, index) => {
    console.log(`  ${index + 1}. ${task.id} - ${task.description}`);
  });
}

function selectTaskFromMenu(tasks: TaskDefinition[]): TaskDefinition | null {
  if (tasks.length === 0) {
    return null;
  }

  while (true) {
    printTaskMenu(tasks);
    const raw = prompt("Select task number", "1");

    if (raw === null) {
      return null;
    }

    const choice = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(choice) && choice >= 1 && choice <= tasks.length) {
      return tasks[choice - 1];
    }

    console.error(`Invalid selection: ${raw}`);
  }
}

function parseBooleanInput(raw: string): boolean | undefined {
  const normalized = raw.trim().toLowerCase();
  if (["y", "yes", "true", "1"].includes(normalized)) {
    return true;
  }

  if (["n", "no", "false", "0"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function formatFieldDefault(
  field: TaskFieldDefinition,
  value: TaskValue,
): string {
  if (value === undefined) {
    return "";
  }

  if (field.type === "boolean") {
    return value === true ? "y" : "n";
  }

  return `${value}`;
}

function promptFieldValue(
  field: TaskFieldDefinition,
  defaultValue: TaskValue,
): { cancelled: true } | { cancelled: false; value: TaskValue } {
  while (true) {
    if (field.description) {
      console.log(`- ${field.label}: ${field.description}`);
    }

    const requiredLabel = field.required ? " (required)" : "";
    const defaultText = formatFieldDefault(field, defaultValue);

    let promptMessage = `${field.label}${requiredLabel}`;
    if (field.type === "boolean") {
      promptMessage += " [y/n]";
    }

    const raw = prompt(promptMessage, defaultText || undefined);
    if (raw === null) {
      return { cancelled: true };
    }

    let candidate: unknown;
    const trimmed = raw.trim();
    if (field.type === "boolean") {
      if (trimmed.length === 0 && typeof defaultValue === "boolean") {
        candidate = defaultValue;
      } else {
        const parsed = parseBooleanInput(trimmed);
        if (parsed === undefined) {
          console.error(`${field.label} must be yes/no.`);
          continue;
        }
        candidate = parsed;
      }
    } else if (trimmed.length === 0) {
      if (defaultValue !== undefined) {
        candidate = defaultValue;
      } else {
        candidate = undefined;
      }
    } else {
      candidate = trimmed;
    }

    const validation = validateField(field, candidate);
    if (!validation.valid) {
      console.error(validation.error);
      continue;
    }

    return { cancelled: false, value: validation.normalizedValue };
  }
}

function getTaskByFlag(
  taskId: string,
  advancedMode: boolean,
): TaskDefinition | undefined {
  const fullTask = getTaskDefinitionById(taskId);
  if (!fullTask) {
    return undefined;
  }

  if (fullTask.advanced && !advancedMode) {
    return undefined;
  }

  return getVisibleTasks([fullTask], advancedMode)[0];
}

function printValidTaskIds(advancedMode: boolean): void {
  const ids = getVisibleTasks(TASK_MANIFEST, advancedMode).map((task) =>
    task.id
  );
  console.error(`Valid task IDs: ${ids.join(", ")}`);
}

function extractPersistableValues(
  task: TaskDefinition,
  values: TaskValueMap,
): Record<string, string | number | boolean> {
  const persisted: Record<string, string | number | boolean> = {};

  for (const field of task.fields) {
    const value = values[field.key];
    if (value === undefined) {
      continue;
    }

    if (
      typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean"
    ) {
      persisted[field.key] = value;
    }
  }

  return persisted;
}

async function persistHistoryIfEnabled(
  noHistory: boolean,
  historyPath: string,
  history: TaskHistory,
  fullTask: TaskDefinition,
  visibleTask: TaskDefinition,
  values: TaskValueMap,
): Promise<void> {
  if (noHistory) {
    return;
  }

  const nextTaskValues = {
    ...(history[fullTask.id] ?? {}),
    ...extractPersistableValues(visibleTask, values),
  };

  for (const field of visibleTask.fields) {
    if (values[field.key] === undefined) {
      delete nextTaskValues[field.key];
    }
  }

  history[fullTask.id] = nextTaskValues;

  try {
    await saveHistory(historyPath, history);
  } catch (error) {
    const message = error instanceof Error ? error.message : `${error}`;
    console.warn(`Warning: failed to save history: ${message}`);
  }
}

function getTaskForRun(flags: LauncherFlags): TaskDefinition | null {
  const visibleTasks = getVisibleTasks(TASK_MANIFEST, flags.advanced);

  if (flags.task) {
    const selectedByFlag = getTaskByFlag(flags.task, flags.advanced);
    if (selectedByFlag) {
      return selectedByFlag;
    }

    const fullTask = getTaskDefinitionById(flags.task);
    if (fullTask?.advanced && !flags.advanced) {
      console.error(
        `Task \"${flags.task}\" is advanced-only. Re-run with --advanced.`,
      );
      printValidTaskIds(flags.advanced);
      return null;
    }

    console.error(`Unknown task: ${flags.task}`);
    printValidTaskIds(flags.advanced);
    return null;
  }

  return selectTaskFromMenu(visibleTasks);
}

async function main(): Promise<number> {
  let flags: LauncherFlags;

  try {
    flags = parseLauncherFlags(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : `${error}`;
    console.error(message);
    printHelp();
    return 1;
  }

  if (flags.help) {
    printHelp();
    return 0;
  }

  const selectedVisibleTask = getTaskForRun(flags);
  if (!selectedVisibleTask) {
    return flags.task ? 1 : 0;
  }

  const selectedFullTask = getTaskDefinitionById(selectedVisibleTask.id);
  if (!selectedFullTask) {
    console.error(`Task definition not found for ${selectedVisibleTask.id}.`);
    return 1;
  }

  if (selectedVisibleTask.preRunWarning) {
    console.log(`Warning: ${selectedVisibleTask.preRunWarning}`);
  }

  const history = flags.noHistory ? {} : await loadHistory(HISTORY_PATH);
  const taskHistoryValues = history[selectedVisibleTask.id] ?? {};
  const defaultValues = mergeTaskValues(
    selectedVisibleTask,
    taskHistoryValues,
    {},
  );
  const enteredValues: TaskValueMap = {};

  for (const field of selectedVisibleTask.fields) {
    const result = promptFieldValue(field, defaultValues[field.key]);
    if (result.cancelled) {
      console.log("Cancelled.");
      return 0;
    }

    enteredValues[field.key] = result.value;
  }

  const mergedValues = mergeTaskValues(
    selectedVisibleTask,
    taskHistoryValues,
    enteredValues,
  );

  let taskArgs: string[];
  try {
    taskArgs = buildCommandArgs(selectedVisibleTask, mergedValues);
  } catch (error) {
    const message = error instanceof Error ? error.message : `${error}`;
    console.error(`Invalid task arguments: ${message}`);
    return 1;
  }

  const denoArgs = ["task", ...taskArgs];
  console.log("\nResolved command:");
  console.log(`  ${commandPreview(["deno", ...denoArgs])}`);

  if (flags.dryRun) {
    await persistHistoryIfEnabled(
      flags.noHistory,
      HISTORY_PATH,
      history,
      selectedFullTask,
      selectedVisibleTask,
      mergedValues,
    );
    console.log("Dry run complete. Command was not executed.");
    return 0;
  }

  const shouldRun = confirm("Run this command now?");
  if (!shouldRun) {
    console.log("Cancelled.");
    return 0;
  }

  await persistHistoryIfEnabled(
    flags.noHistory,
    HISTORY_PATH,
    history,
    selectedFullTask,
    selectedVisibleTask,
    mergedValues,
  );

  try {
    const command = new Deno.Command("deno", {
      args: denoArgs,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    const child = command.spawn();
    const status = await child.status;
    return status.code;
  } catch (error) {
    const message = error instanceof Error ? error.message : `${error}`;
    console.error(`Failed to execute command: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await main();
  if (code !== 0) {
    process.exit(code);
  }
}

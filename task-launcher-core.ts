import path from "node:path";
import {
  type TaskDefinition,
  type TaskFieldDefinition,
} from "./task-manifest.ts";

export type TaskValue = string | number | boolean | undefined;
export type TaskValueMap = Record<string, TaskValue>;
export type TaskHistory = Record<
  string,
  Record<string, string | number | boolean>
>;

export interface ValidationResult {
  valid: boolean;
  normalizedValue?: TaskValue;
  error?: string;
}

function isPrimitiveValue(value: unknown): value is string | number | boolean {
  return ["string", "number", "boolean"].includes(typeof value);
}

export function getVisibleTasks(
  manifest: TaskDefinition[],
  advancedMode: boolean,
): TaskDefinition[] {
  return manifest
    .filter((task) => advancedMode || !task.advanced)
    .map((task) => ({
      ...task,
      fields: task.fields.filter((field) => advancedMode || !field.advanced),
    }));
}

export function validateField(
  field: TaskFieldDefinition,
  value: unknown,
): ValidationResult {
  if (value === undefined || value === null || value === "") {
    if (field.required) {
      return {
        valid: false,
        error: `${field.label} is required.`,
      };
    }

    return { valid: true, normalizedValue: undefined };
  }

  if (field.type === "boolean") {
    if (typeof value !== "boolean") {
      return {
        valid: false,
        error: `${field.label} must be true/false.`,
      };
    }

    return { valid: true, normalizedValue: value };
  }

  const stringValue = typeof value === "string" ? value.trim() : `${value}`;

  if (stringValue.length === 0) {
    if (field.required) {
      return {
        valid: false,
        error: `${field.label} is required.`,
      };
    }

    return { valid: true, normalizedValue: undefined };
  }

  if (field.type === "string") {
    return { valid: true, normalizedValue: stringValue };
  }

  if (field.type === "url") {
    try {
      const normalized = new URL(stringValue).toString();
      return { valid: true, normalizedValue: normalized };
    } catch {
      return {
        valid: false,
        error: `${field.label} must be a valid absolute URL.`,
      };
    }
  }

  if (field.type === "int") {
    const parsed = Number.parseInt(stringValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      return {
        valid: false,
        error: `${field.label} must be a positive integer.`,
      };
    }

    return { valid: true, normalizedValue: parsed };
  }

  return {
    valid: false,
    error: `Unsupported field type for ${field.label}.`,
  };
}

function getPositionalFields(task: TaskDefinition): TaskFieldDefinition[] {
  return [...task.fields]
    .filter((field) => field.positional !== undefined)
    .sort((a, b) => (a.positional ?? 0) - (b.positional ?? 0));
}

export function buildCommandArgs(
  task: TaskDefinition,
  values: TaskValueMap,
): string[] {
  const args: string[] = [task.id];

  for (const field of getPositionalFields(task)) {
    const rawValue = values[field.key];
    const validation = validateField(field, rawValue);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    if (validation.normalizedValue !== undefined) {
      args.push(`${validation.normalizedValue}`);
    }
  }

  for (const field of task.fields) {
    if (!field.flag) {
      continue;
    }

    const rawValue = values[field.key];
    const validation = validateField(field, rawValue);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    if (field.type === "boolean") {
      if (validation.normalizedValue === true) {
        args.push(`--${field.flag}`);
      }
      continue;
    }

    if (validation.normalizedValue !== undefined) {
      args.push(`--${field.flag}`, `${validation.normalizedValue}`);
    }
  }

  return args;
}

export function mergeTaskValues(
  task: TaskDefinition,
  historyValues: Record<string, unknown> = {},
  currentValues: TaskValueMap = {},
): TaskValueMap {
  const merged: TaskValueMap = {};

  for (const field of task.fields) {
    if (field.defaultValue !== undefined) {
      merged[field.key] = field.defaultValue;
    }

    const historyValue = historyValues[field.key];
    if (isPrimitiveValue(historyValue)) {
      merged[field.key] = historyValue;
    }

    if (Object.hasOwn(currentValues, field.key)) {
      merged[field.key] = currentValues[field.key];
    }
  }

  return merged;
}

export async function loadHistory(filePath: string): Promise<TaskHistory> {
  try {
    const content = await Deno.readTextFile(filePath);
    const parsed = JSON.parse(content);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const sanitizedHistory: TaskHistory = {};

    for (const [taskId, taskValues] of Object.entries(parsed)) {
      if (
        !taskValues || typeof taskValues !== "object" ||
        Array.isArray(taskValues)
      ) {
        continue;
      }

      const sanitizedValues: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(taskValues)) {
        if (isPrimitiveValue(value)) {
          sanitizedValues[key] = value;
        }
      }

      sanitizedHistory[taskId] = sanitizedValues;
    }

    return sanitizedHistory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {};
    }

    console.warn(
      `Warning: failed to parse history file at ${filePath}. Ignoring existing history.`,
    );
    return {};
  }
}

export async function saveHistory(
  filePath: string,
  history: TaskHistory,
): Promise<void> {
  await Deno.mkdir(path.dirname(filePath), { recursive: true });
  const serialized = `${JSON.stringify(history, null, 2)}\n`;
  await Deno.writeTextFile(filePath, serialized);
}

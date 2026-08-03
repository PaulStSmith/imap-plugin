import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "./accounts.js";

export interface PluginPreferences {
  smtpActionsEnabled: boolean;
}

const DEFAULT_PREFERENCES: PluginPreferences = {
  smtpActionsEnabled: false
};

function preferencesPath(): string {
  return join(configDir(), "preferences.json");
}

export async function readPreferences(): Promise<PluginPreferences> {
  try {
    const parsed = JSON.parse(await readFile(preferencesPath(), "utf8")) as Partial<PluginPreferences>;
    return {
      ...DEFAULT_PREFERENCES,
      ...parsed
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_PREFERENCES;
    }

    throw error;
  }
}

export async function updatePreferences(next: Partial<PluginPreferences>): Promise<PluginPreferences> {
  const preferences = {
    ...(await readPreferences()),
    ...next
  };
  const path = preferencesPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
  return preferences;
}

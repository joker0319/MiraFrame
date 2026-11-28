import type { ConfigValue } from "./common";

export interface ConfigItem {
  key: string;
  value: ConfigValue;
  is_sensitive: boolean;
  is_masked: boolean;
  source: "db" | "env" | "default";
}

export interface ConfigUpdatePayload {
  configs?: Record<string, ConfigValue>;
}

export interface TestConnectionPayload {
  service?: "llm" | "image" | "video";
  config_overrides?: Record<string, string | null>;
}

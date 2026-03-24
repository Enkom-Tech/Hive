export function hiveEnv(key: string): string | undefined {
  return process.env[`HIVE_${key}`];
}

export function setHiveEnv(key: string, value: string): void {
  process.env[`HIVE_${key}`] = value;
}


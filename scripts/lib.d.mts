import type { ChildProcess } from "node:child_process";
export const ROOT: string;
export function envPath(): string;
export function loadEnv(): Record<string, string>;
export function useNetworkEnv(name?: string): string | undefined;
export function waitFor<T>(fn: () => Promise<T> | T, label: string, timeoutMs?: number): Promise<NonNullable<T>>;
export function run(name: string, cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string>; shell?: boolean; quiet?: (line: string) => boolean }): ChildProcess;
export function binIn(pkg: string, name: string): string;
export function stopAll(children: ChildProcess[]): void;

export function queueReadiness(options?: { env?: NodeJS.ProcessEnv }): any;
export function acquireModelSlot(meta: any, options?: { signal?: any; onWaiting?: any; env?: NodeJS.ProcessEnv }): Promise<any>;
export function queueQuery(operation: string, input?: any, options?: { env?: NodeJS.ProcessEnv }): Promise<any>;
export function closeQueue(): Promise<void>;

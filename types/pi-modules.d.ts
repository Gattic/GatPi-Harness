// Local declaration shims for the installed Pi packages. The harness is checked
// out beside the Pi source tree; these shims keep the static gate runnable
// without requiring the monorepo's node_modules to be linked into the harness.

declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionAPI = any;
  export interface ExtensionContext {
    ui: {
      custom<T = any>(...args: any[]): any;
      input<T = any>(...args: any[]): any;
      select<T = any>(...args: any[]): any;
      [key: string]: any;
    };
    [key: string]: any;
  }
  export type ExtensionCommandContext = ExtensionContext;
  export type AgentToolResult<T = unknown> = T;
  export type Theme = any;
  export type CustomEditor = any;
  export const CustomEditor: any;
  export const createCodemodeExtension: any;
  export const withFileMutationQueue: any;
  export const convertToLlm: any;
  export const serializeConversation: any;
}

declare module "@earendil-works/pi-ai" {
  export const builtinProviders: any;
  export const complete: any;
  export const StringEnum: any;
  export type Model<T = any> = any;
  export interface SimpleStreamOptions { signal?: any; [key: string]: any; }
  export type TranscriptContext = any;
}

declare module "@earendil-works/pi-ai/compat" {
  export const builtinProviders: any;
  export const complete: any;
  export const StringEnum: any;
  export type Model<T = any> = any;
  export interface SimpleStreamOptions { signal?: any; [key: string]: any; }
  export type TranscriptContext = any;
  export type Api = any;
  export type AssistantMessage = any;
  export type AssistantMessageEventStream = any;
  export const createAssistantMessageEventStream: any;
  export const getApiProvider: any;
}

declare module "@earendil-works/pi-ai/providers/all" {
  export const builtinProviders: any;
}

declare module "@earendil-works/pi-tui" {
  export type TUI = any;
  export const TUI: any;
  export type Key = any;
  export const Key: any;
  export type KeyId = any;
  export type EditorOptions = any;
  export type EditorTheme = any;
  export type Text = any;
  export const Text: any;
  export const matchesKey: any;
  export const truncateToWidth: any;
  export const visibleWidth: any;
  export const wrapTextWithAnsi: any;
}

declare module "typebox" {
  export const Type: {
    Unsafe<T = any>(...args: any[]): any;
    [key: string]: any;
  };
  export type Static<T> = T;
  export type TSchema = any;
}

declare module "*pi-queue-adapter.js" {
  export function acquireModelSlot(meta: any, options?: { signal?: any; onWaiting?: any; env?: any }): Promise<any>;
  export function closeQueue(...args: any[]): any;
  export function queueQuery(...args: any[]): any;
}

import { hostname } from "node:os";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  getApiProvider,
  type Model,
  type SimpleStreamOptions,
  StringEnum,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { acquireModelSlot, closeQueue, queueQuery } from "../../src/pi-queue-adapter.js";
import { instrumentExtensionCommands, notify, toolResult } from "../../src/pi-extension-kit.js";

const states = ["waiting", "running", "completed", "failed", "cancelled", "abandoned"] as const;

function failure(model: Model<Api>, errorMessage: string, aborted: boolean): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: aborted ? "aborted" : "error", errorMessage, timestamp: Date.now(),
  };
}

const outcome = (message: AssistantMessage) =>
  message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "failed" : "completed";

export default function (pi: ExtensionAPI) {
  if (process.env.PI_QUEUE === "0") return;
  pi = instrumentExtensionCommands(pi, { extension: "pi-queue" });
  const provider = process.env.PI_QUEUE_PROVIDER || "local";
  let ui: ExtensionContext["ui"] | undefined;

  // Every request to the queued provider joins the shared Redis queue first, then
  // uses Pi's built-in implementation of the model's API once a slot is free.
  function queuedStream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      let ticket: Awaited<ReturnType<typeof acquireModelSlot>> | undefined;
      try {
        ticket = await acquireModelSlot(
          { host: hostname(), pid: process.pid, provider: model.provider, model: model.id, session: options?.sessionId },
          { signal: options?.signal, onWaiting: ({ id, position }: { id: string; position: number }) => ui?.setStatus("pi-queue", `queued ${id}: position ${position}`) },
        );
        ui?.setStatus("pi-queue", undefined);
        const api = getApiProvider(model.api);
        if (!api) throw new Error(`No API implementation registered for ${model.api}`);
        for await (const event of api.streamSimple(model, context, options)) {
          if (event.type === "done" || event.type === "error") {
            // Free the slot before Pi sees the result, so the next request can start.
            const message = event.type === "done" ? event.message : event.error;
            await ticket.finish(outcome(message), {
              stopReason: message.stopReason, inputTokens: message.usage.input, outputTokens: message.usage.output,
              totalTokens: message.usage.totalTokens, error: message.errorMessage,
            }).catch(() => {});
          }
          stream.push(event);
        }
        await ticket.finish("failed", { error: "Model stream ended without a result" }).catch(() => {});
      } catch (error) {
        ui?.setStatus("pi-queue", undefined);
        const aborted = Boolean(options?.signal?.aborted) || (error as Error)?.name === "AbortError";
        const message = error instanceof Error ? error.message : String(error);
        await ticket?.finish(aborted ? "cancelled" : "failed", { error: message }).catch(() => {});
        stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: failure(model, message, aborted) });
      }
      stream.end();
    })();
    return stream;
  }

  // Pi dispatches to an extension stream only for models whose API matches the
  // registration, so register the API the provider's models actually use.
  // Registration is idempotent; repeating it on every session start keeps a
  // replaced or reused model runtime wrapped.
  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.hasUI ? ctx.ui : undefined;
    const apis = [...new Set(ctx.modelRegistry.getAll().filter((model) => model.provider === provider).map((model) => model.api))];
    if (apis.length === 0) return;
    if (apis.length > 1) {
      const message = `Pi request queue cannot wrap ${provider}: its models use several APIs (${apis.join(", ")}); those requests are NOT queued`;
      if (ctx.hasUI) ctx.ui.notify(message, "error"); else console.error(message);
      return;
    }
    pi.registerProvider(provider, { api: apis[0], streamSimple: queuedStream });
  });
  pi.on("session_shutdown", async () => { await closeQueue(); });

  pi.registerTool({
    name: "pi_queue_status", label: "Pi request queue status",
    description: `Show the shared Pi request queue: concurrency limit, running and waiting model requests, and totals; or one request by ID. Every ${provider} model request from any harness machine joins this queue before it is sent.`,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    parameters: Type.Object({ id: Type.Optional(Type.String({ pattern: "^r[0-9]{1,15}$", description: "Request ID, e.g. r42" })) }, { additionalProperties: false }),
    execute: async (_id: string, params: any) => toolResult(await queueQuery("status", params)),
  });
  pi.registerTool({
    name: "pi_queue_list", label: "Pi request queue history",
    description: "List recent queued model requests, newest first: machine, model, state, wait and run time, token usage. Prompts and responses are not stored.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    parameters: Type.Object({
      state: Type.Optional(StringEnum(states)),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }, { additionalProperties: false }),
    execute: async (_id: string, params: any) => toolResult(await queueQuery("list", params)),
  });
  pi.registerCommand("queue-status", {
    description: "Show the Pi request queue, or one request (optional ID)",
    handler: async (args, ctx) => {
      const value = args.trim();
      notify(ctx, JSON.stringify(await queueQuery("status", value ? { id: value } : {}), null, 2));
    },
  });
}

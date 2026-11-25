# AICode `FetchConfig` — endpoint, wire format, and account catalog

Live-verified 2026-11-22T20:47:43Z for `yoelrosen613@gmail.com` (auth method: `consumer`).

## 1. Endpoint

| Property | Value |
|---|---|
| Base URL | `https://aicode.googleapis.com` |
| Transport | gRPC over HTTP/2 only (`content-type: application/grpc`). HTTP/1.1 JSON POST to the same path returns GFE 404 HTML. |
| Served path | `/google.gca.aicode.v1alpha.ManagementService/FetchConfig` |
| RPC | `FetchConfig(FetchConfigRequest) returns (FetchConfigResponse)` |
| HTTP annotation (proto) | `POST /{$api_version}:fetchConfig` |
| Request body | empty message — zero-byte protobuf payload |
| Required scope | `https://www.googleapis.com/auth/aicode` |
| Host mapping | `mapCCPAEndpointToAICode`: `cloudcode-pa` → `aicode`; `autopush-/preprod-…sandbox` → internal `…-aicode.sandbox.googleapis.com` (ÜberProxy-only, 403 outside) |

### Version routing

| Path | Result |
|---|---|
| `/google.gca.aicode.v1alpha.ManagementService/FetchConfig` | **200, gRPC 0, 67113 bytes** |
| `/google.gca.aicode.v1beta.ManagementService/FetchConfig` | **200, gRPC 0, 18867 bytes** |
| `/google.gca.aicode.v1main.ManagementService/FetchConfig` | 200, gRPC 12 `Method not found.` |
| `/google.cloud.businessaicode.v1main.ManagementService/FetchConfig` | 200, gRPC 12 `GRPC target method can't be resolved.` |
| `/google.cloud.businessaicode.v1beta.ManagementService/FetchConfig` | 200, gRPC 12 `GRPC target method can't be resolved.` |

### Request headers (verified working)

```
:method: POST
:path: /google.gca.aicode.v1alpha.ManagementService/FetchConfig
:authority: aicode.googleapis.com
authorization: Bearer <access token with https://www.googleapis.com/auth/aicode>
content-type: application/grpc
te: trailers
user-agent: grpc-go/1.60.0
client-metadata: {"ideType":"ANTIGRAVITY","ideName":"antigravity","ideVersion":"2.11.0","pluginVersion":"2.11.0","platform":"LINUX_AMD64","pluginType":"CLOUD_CODE"}
```

gRPC unary framing: request `00 00 00 00 00` (compression flag 0, big-endian length 0); response body is one 5-byte-prefixed protobuf message, with `grpc-status`/`grpc-message` in trailers.

### Auth failure signature

Without the `aicode` scope the same call returns HTTP 200 with:

```
grpc-status: 7
grpc-message: Request had insufficient authentication scopes.
www-authenticate: Bearer  realm="https://accounts.google.com/", error="insufficient_scope", scope="https://www.googleapis.com/auth/aicode"  # pragma: allowlist secret — scope advertisement only, no credential (double SP is RFC 7235 OWS)
```

## 2. Response schema

From the embedded `FileDescriptorProto` (binary offset 85,072,512, package `google.gca.aicode.v1main`):

```
service ManagementService {
  rpc GetUserSettings(GetUserSettingsRequest) returns (UserSettings);
  rpc UpdateUserSettings(UpdateUserSettingsRequest) returns (UserSettings);
  rpc GetUserInfo(GetUserInfoRequest) returns (UserInfo);
  rpc FetchConfig(FetchConfigRequest) returns (FetchConfigResponse);
  rpc FetchLicenses(FetchLicensesRequest) returns (FetchLicensesResponse);
}

FetchConfigRequest {}   // no fields

FetchConfigResponse {
  #1 experiment_config {
       enabled_experiment_ids: repeated int32
       experiment_flags: repeated {
         name; oneof value { bool_value, float_value, int_value,
                             string_value, int32_list_value,
                             int64_list_value, string_list_value }
       }
     }
  #2 available_experiences: repeated {
       name
       model: Model
       surface_config { client_model_enum_name, tags{title,description},
                        disabled, model_experiments{key,value} }
     }
  #3 available_models: repeated Model      // v1main only; v1alpha embeds models per experience
  #4 agy_surface_config {
       image_generation / commit_message / web_search / agent /
       tiered_flash_lite / tiered_flash / tiered_pro / audio_transcription:
         { experience_names[], default_experience }
     }
}

Model {
  model_id, name, display_name, base_model_id, version, description,
  input_token_limit, output_token_limit,
  supported_thinking_levels[], supported_features[],
  generation_config { thinking_config { include_thoughts, thinking_budget,
                                       thinking_level, min_thinking_budget },
                      max_output_tokens },
  model_provider, agy_supported_mime_types[]
}
```

Enums: `ThinkingLevel` = UNSPECIFIED, MINIMAL, LOW, MEDIUM, HIGH, EXTRA_HIGH. `Feature` = IMAGE_INPUT, IMAGE_OUTPUT, JSON_SCHEMA_OUTPUT, BROWSE_AS_A_TOOL, SEARCH_AS_A_TOOL, TOP_P, AUDIO_INPUT, AUDIO_OUTPUT, CODE_EXECUTION, FUNCTION_CALLING, THINKING, THINKING_LEVEL, VIDEO_INPUT, DOCUMENT_INPUT. `ModelProvider` = GOOGLE, ANTHROPIC, OTHER, OPENAI.

## 3. Live verification

| Call | HTTP | gRPC | Bytes | SHA-256 |
|---|---|---|---|---|
| v1alpha FetchConfig | 200 | 0 | 67113 | `b48139f0b60a0d2fbe2c610e83ab221661970af0e2e7caf5776f1e43f12f4190` |
| v1beta FetchConfig | 200 | 0 | 18867 | `4720aefa43ae3e5d007881b1d6f2b7695bce26805d1bc6c184d7a17919069623` |
| v1alpha FetchQuotaStatus | 200 | 0 | 1406 | `52faf002215e68ea678d0b34c40748a063e9282befdda352a9bebfa378eed319` |
| v1alpha FetchLicenses | 200 | 0 | 89 | `85aeba1b46ee2843c13ad5b13230191cc9ee8104b325c107efb479eb33a0780d` |

Parsed dump: `docs/aicode-catalog.json` (148608 bytes), containing all 18 experiences, 436 experiment flags, surface config, quota strings, and licenses.

## 4. Catalog (v1alpha, 18 experiences)

| Experience | Client enum | Model ID | Display name | Thinking | Context / Output | Tags |
|---|---|---|---|---|---|---|
| `claude-opus-5-5-high` | `MODEL_PLACEHOLDER_M402` | `claude-opus-5-5` | Claude Opus 5.5 (High) | LOW/MEDIUM/HIGH | 1000000 / 128000 | New |
| `claude-opus-5-5-low` | `MODEL_PLACEHOLDER_M400` | `claude-opus-5-5` | Claude Opus 5.5 (Low) | LOW/MEDIUM/HIGH | 1000000 / 128000 | New |
| `claude-opus-5-5-medium` | `MODEL_PLACEHOLDER_M401` | `claude-opus-5-5` | Claude Opus 5.5 (Medium) | LOW/MEDIUM/HIGH | 1000000 / 128000 | New |
| `claude-sonnet-5-5-high` | `MODEL_PLACEHOLDER_M405` | `claude-sonnet-5-5` | Claude Sonnet 5.5 (High) | LOW/MEDIUM/HIGH | 1000000 / 128000 | New |
| `claude-sonnet-5-5-low` | `MODEL_PLACEHOLDER_M403` | `claude-sonnet-5-5` | Claude Sonnet 5.5 (Low) | LOW/MEDIUM/HIGH | 1000000 / 128000 | New |
| `claude-sonnet-5-5-medium` | `MODEL_PLACEHOLDER_M404` | `claude-sonnet-5-5` | Claude Sonnet 5.5 (Medium) | LOW/MEDIUM/HIGH | 1000000 / 128000 | New |
| `gemini-2.5-flash` | `MODEL_GOOGLE_GEMINI_2_5_FLASH` | `gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | MINIMAL/LOW/MEDIUM/HIGH | 1048576 / 65536 | — |
| `gemini-2.5-flash-lite` | `MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE` | `gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | MINIMAL/LOW/MEDIUM/HIGH | 1048576 / 65536 | — |
| `gemini-2.5-flash-thinking` | `MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING` | `gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | MINIMAL/LOW/MEDIUM/HIGH | 1048576 / 65536 | — |
| `gemini-3-flash` | `MODEL_PLACEHOLDER_M18` | `gemini-3.5-flash-lite` | Gemini 3 Flash | MINIMAL/LOW/MEDIUM/HIGH | 1048576 / 65536 | — |
| `gemini-3.1-flash-image` | `MODEL_PLACEHOLDER_M21` | `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | — | 65536 / 65536 | — |
| `gemini-3.1-flash-lite` | `MODEL_PLACEHOLDER_M50` | `gemini-3.5-flash-lite` | Gemini 3.1 Flash Lite | MINIMAL/LOW/MEDIUM/HIGH | 1048576 / 65536 | — |
| `gemini-3.5-flash-lite` | `MODEL_PLACEHOLDER_M198` | `gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | MINIMAL/LOW/MEDIUM/HIGH | 1048576 / 65536 | — |
| `gemini-3.8-flash-high` | `MODEL_PLACEHOLDER_M318` | `gemini-3.8-flash` | Gemini 3.8 Flash (High) | MINIMAL/LOW/MEDIUM/HIGH | 1048576 / 65536 | Fast |
| `gemini-3.8-flash-low` | `MODEL_PLACEHOLDER_M320` | `gemini-3.8-flash` | Gemini 3.8 Flash (Low) | MINIMAL/LOW/MEDIUM/HIGH | 1048576 / 65536 | Fast |
| `gemini-3.8-flash-medium` | `MODEL_PLACEHOLDER_M319` | `gemini-3.8-flash` | Gemini 3.8 Flash (Medium) | MINIMAL/LOW/MEDIUM/HIGH | 1048576 / 65536 | Fast |
| `gemini-3.8-flash-tiered` | `MODEL_PLACEHOLDER_M322` | `gemini-3.8-flash` | — | MINIMAL/LOW/MEDIUM/HIGH | 1048576 / 65536 | — |
| `gpt-oss-120b-medium` | `MODEL_OPENAI_GPT_OSS_120B_MEDIUM` | `gpt-oss-120b` | GPT-OSS 120B (Medium) | — | 131072 / 32768 | Notice |

### Surface config

| Surface | Default | Count | Experiences |
|---|---|---|---|
| image_generation | — | 1 | `gemini-3.1-flash-image` |
| commit_message | — | 1 | `gemini-3.5-flash-lite` |
| web_search | — | 1 | `gemini-3.5-flash-lite` |
| agent | — | 10 | `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`, `claude-opus-5-5-low`, `claude-opus-5-5-medium`, `claude-opus-5-5-high`, `claude-sonnet-5-5-low`, `claude-sonnet-5-5-medium`, `claude-sonnet-5-5-high`, `gpt-oss-120b-medium` |
| tiered_flash_lite | — | 1 | `gemini-3.5-flash-lite` |
| tiered_flash | — | 1 | `gemini-3.8-flash-tiered` |
| tiered_pro | — | 1 | `gemini-3.8-flash-tiered` |
| audio_transcription | — | 1 | `models/proactive-observer-v10` |

### Notable experiment flags

| Flag | Value |
|---|---|
| `use-aicode-jetski-endpoint` | False |
| `enable-subagent-dropdown-models` | False |
| `use-aicode-mendel` | True |
| `show-all-models-in-gemini-app` | False |
| `enable-orchestrator-model-selection` | False |
| `use-aicode-preprod-endpoint` | False |
| `ambient_disabled_models` | "fable-5.2-*,claude-fable-5-2*" |
| `browser-subagent-model` | "gemini-3.8-flash-low" |

## 5. Neon / Carbon

Byte-level scan of the full responses finds **zero** occurrences of `neon`, `carbon`, `argon`, or `hydrogen` in:

- v1alpha FetchConfig (67113 bytes)
- v1beta FetchConfig (18867 bytes)
- v1alpha FetchQuotaStatus (1406 bytes)

Counts across the parsed catalog: neon=0, carbon=0, argon=0, hydrogen=0.

The AICode catalog for this account contains no `gemini-4` model at all. The only Gemini 4 model reachable on this account remains `gemini-4-hydrogen-sonar` on the CCPA `v1internal` surface. The `Gemini 4 Neon/Carbon/Argon` strings in the IDE binary are client-side enum names, not served models.

## 6. Reproduction

```js
// Node 22+, http2; requires a bearer token with the auth/aicode scope
const c = http2.connect("https://aicode.googleapis.com");
const frame = Buffer.from([0, 0, 0, 0, 0]);
const req = c.request({
  ":method": "POST",
  ":path": "/google.gca.aicode.v1alpha.ManagementService/FetchConfig",
  "content-type": "application/grpc",
  "te": "trailers",
  authorization: "Bearer " + accessToken,
  "client-metadata": JSON.stringify({ ideType: "ANTIGRAVITY", ideName: "antigravity",
    ideVersion: "2.11.0", pluginVersion: "2.11.0", platform: "LINUX_AMD64", pluginType: "CLOUD_CODE" }),
});
req.on("trailers", (t) => console.log(t["grpc-status"], t["grpc-message"]));
req.on("data", (chunk) => { /* 5-byte prefix + protobuf FetchConfigResponse */ });
req.end(frame);
```

## 7. Credential handling

The live calls use the IDE's own OAuth credential from the login keyring (Secret Service item `service=gemini, username=antigravity`) in memory only. The refresh returns a token carrying `https://www.googleapis.com/auth/aicode`; no refresh token rotation was observed, so the IDE's stored credential stays valid. No token material is written to disk or to this repository.

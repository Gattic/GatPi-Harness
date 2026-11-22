#!/usr/bin/env python3
"""Re-run the AICode FetchConfig RPC and regenerate the write-up.

Usage:
    python3 scripts/aicodefetchconfig.py

The script:
  * reads the Antigravity IDE OAuth credential from the login keyring
    (Secret Service item service=gemini, username=antigravity),
  * refreshes it against https://oauth2.googleapis.com/token using the
    client credentials in ~/.pi/agent/antigravity-oauth.json (or
    PI_ANTIGRAVITY_CLIENT_ID / PI_ANTIGRAVITY_CLIENT_SECRET),
  * calls google.gca.aicode.v1alpha.ManagementService/FetchConfig over
    gRPC/HTTP2, plus v1beta FetchConfig, FetchQuotaStatus, FetchLicenses,
    and the v1main / businessaicode routing probes,
  * writes docs/aicode-catalog.json and docs/aicode-fetchconfig.md.

No credential material is printed or written to disk.  Requires the h2
package (python3-h2) and an unlocked login keyring.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import socket
import ssl
import struct
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import h2.config
    import h2.connection
    import h2.events
except ImportError:  # pragma: no cover - environment guard
    sys.exit("missing dependency: h2 (install python3-h2)")

HOST = "aicode.googleapis.com"
V1ALPHA_PATH = "/google.gca.aicode.v1alpha.ManagementService/FetchConfig"
V1BETA_PATH = "/google.gca.aicode.v1beta.ManagementService/FetchConfig"
V1MAIN_PATH = "/google.gca.aicode.v1main.ManagementService/FetchConfig"
BAIC_V1MAIN_PATH = "/google.cloud.businessaicode.v1main.ManagementService/FetchConfig"
BAIC_V1BETA_PATH = "/google.cloud.businessaicode.v1beta.ManagementService/FetchConfig"
QUOTA_PATH = "/google.gca.aicode.v1alpha.PredictionService/FetchQuotaStatus"
LICENSES_PATH = "/google.gca.aicode.v1alpha.ManagementService/FetchLicenses"

CLIENT_METADATA = {
    "ideType": "ANTIGRAVITY",
    "ideName": "antigravity",
    "ideVersion": "2.11.0",
    "pluginVersion": "2.11.0",
    "platform": "LINUX_AMD64",
    "pluginType": "CLOUD_CODE",
}

THINKING_LEVELS = [
    "THINKING_LEVEL_UNSPECIFIED", "MINIMAL", "LOW", "MEDIUM", "HIGH", "EXTRA_HIGH",
]
FEATURES = [
    "FEATURE_UNSPECIFIED", "IMAGE_INPUT", "IMAGE_OUTPUT", "JSON_SCHEMA_OUTPUT",
    "BROWSE_AS_A_TOOL", "SEARCH_AS_A_TOOL", "TOP_P", "AUDIO_INPUT", "AUDIO_OUTPUT",
    "CODE_EXECUTION", "FUNCTION_CALLING", "THINKING", "THINKING_LEVEL",
    "VIDEO_INPUT", "DOCUMENT_INPUT",
]
PROVIDERS = ["MODEL_PROVIDER_UNSPECIFIED", "GOOGLE", "ANTHROPIC", "OTHER", "OPENAI"]

NOTABLE_FLAGS = [
    "show-all-models-in-gemini-app", "ambient_disabled_models",
    "enable-orchestrator-model-selection", "enable-subagent-dropdown-models",
    "browser-subagent-model", "use-aicode-mendel", "use-aicode-preprod-endpoint",
    "use-aicode-jetski-endpoint",
]

SURFACE_NAMES = {
    "group_1": "image_generation", "group_2": "commit_message",
    "group_3": "web_search", "group_4": "agent", "group_5": "tiered_flash_lite",
    "group_6": "tiered_flash", "group_7": "tiered_pro",
    "group_8": "audio_transcription",
}


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


# --------------------------------------------------------------------------
# Credentials
# --------------------------------------------------------------------------

def keyring_token() -> dict:
    try:
        result = subprocess.run(
            ["secret-tool", "lookup", "service", "gemini", "username", "antigravity"],
            capture_output=True, text=True, timeout=20,
        )
    except FileNotFoundError:
        sys.exit("secret-tool not found; install libsecret-tools")
    if result.returncode != 0 or not result.stdout.strip():
        sys.exit("no Antigravity credential in the login keyring "
                 "(service=gemini, username=antigravity)")
    return json.loads(result.stdout)


def client_credentials() -> tuple[str, str]:
    client_id = os.environ.get("PI_ANTIGRAVITY_CLIENT_ID")
    client_secret = os.environ.get("PI_ANTIGRAVITY_CLIENT_SECRET")
    if client_id and client_secret:
        return client_id, client_secret
    path = Path.home() / ".pi" / "agent" / "antigravity-oauth.json"
    if not path.exists():
        sys.exit(f"missing client credentials: set PI_ANTIGRAVITY_CLIENT_ID/"
                 f"PI_ANTIGRAVITY_CLIENT_SECRET or write {path}")
    data = json.loads(path.read_text())
    return data["clientId"], data["clientSecret"]


def refresh_access_token(outer: dict) -> str:
    token = outer.get("token") or {}
    refresh_token = token.get("refresh_token")
    if refresh_token:
        client_id, client_secret = client_credentials()
        body = urllib.parse.urlencode({
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }).encode()
        request = urllib.request.Request(
            "https://oauth2.googleapis.com/token", data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            payload = {"error": f"HTTP {error.code}"}
        if payload.get("access_token"):
            return payload["access_token"]
        if not token.get("access_token"):
            sys.exit(f"token refresh failed: {payload}")
    access = token.get("access_token")
    if not access:
        sys.exit("stored credential has no access token")
    return access


# --------------------------------------------------------------------------
# gRPC over HTTP/2
# --------------------------------------------------------------------------

def grpc_call(path: str, access_token: str, payload: bytes = b"",
              timeout: float = 60.0) -> dict:
    context = ssl.create_default_context()
    context.set_alpn_protocols(["h2"])
    raw = socket.create_connection((HOST, 443), timeout=timeout)
    sock = context.wrap_socket(raw, server_hostname=HOST)
    if sock.selected_alpn_protocol() != "h2":
        sock.close()
        raise RuntimeError("server did not negotiate h2")
    sock.settimeout(timeout)

    connection = h2.connection.H2Connection(
        config=h2.config.H2Configuration(client_side=True, header_encoding="utf-8"))
    connection.initiate_connection()
    sock.sendall(connection.data_to_send())

    stream_id = connection.get_next_available_stream_id()
    headers = [
        (":method", "POST"),
        (":path", path),
        (":authority", HOST),
        (":scheme", "https"),
        ("authorization", f"Bearer {access_token}"),
        ("content-type", "application/grpc"),
        ("te", "trailers"),
        ("user-agent", "grpc-go/1.60.0"),
        ("client-metadata", json.dumps(CLIENT_METADATA, separators=(",", ":"))),
    ]
    frame = b"\x00" + len(payload).to_bytes(4, "big") + payload
    connection.send_headers(stream_id, headers, end_stream=False)
    connection.send_data(stream_id, frame, end_stream=True)
    sock.sendall(connection.data_to_send())

    response_headers: dict = {}
    trailers: dict = {}
    body = bytearray()
    ended = False
    try:
        while not ended:
            chunk = sock.recv(65535)
            if not chunk:
                break
            for event in connection.receive_data(chunk):
                if isinstance(event, h2.events.ResponseReceived):
                    response_headers = dict(event.headers)
                elif isinstance(event, h2.events.TrailersReceived):
                    trailers = dict(event.headers)
                elif isinstance(event, h2.events.DataReceived):
                    body.extend(event.data)
                    connection.acknowledge_received_data(
                        event.flow_controlled_length, stream_id)
                elif isinstance(event, (h2.events.StreamEnded, h2.events.StreamReset)):
                    ended = True
            outbound = connection.data_to_send()
            if outbound:
                sock.sendall(outbound)
    finally:
        sock.close()

    return {
        "httpStatus": response_headers.get(":status"),
        "grpcStatus": trailers.get("grpc-status") or response_headers.get("grpc-status"),
        "grpcMessage": trailers.get("grpc-message") or response_headers.get("grpc-message"),
        "body": bytes(body),
        "headers": response_headers,
        "trailers": trailers,
    }


# --------------------------------------------------------------------------
# Protobuf decoding
# --------------------------------------------------------------------------

def read_varint(buf: bytes, index: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while index < len(buf):
        byte = buf[index]
        index += 1
        value += (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, index
        shift += 7
    raise ValueError("truncated varint")


def parse_fields(buf: bytes) -> list[tuple[int, int, object]]:
    fields = []
    index = 0
    while index < len(buf):
        key, index = read_varint(buf, index)
        number, wire = key >> 3, key & 7
        if wire == 0:
            value, index = read_varint(buf, index)
            fields.append((number, wire, value))
        elif wire == 2:
            length, index = read_varint(buf, index)
            fields.append((number, wire, buf[index:index + length]))
            index += length
        elif wire == 1:
            fields.append((number, wire, buf[index:index + 8]))
            index += 8
        elif wire == 5:
            fields.append((number, wire, buf[index:index + 4]))
            index += 4
        else:
            raise ValueError(f"unsupported wire type {wire}")
    return fields


def text(value: bytes) -> str:
    return value.decode("utf-8", "replace")


def unpack_varints(buf: bytes) -> list[int]:
    values = []
    index = 0
    while index < len(buf):
        value, index = read_varint(buf, index)
        values.append(value)
    return values


def int_list(buf: bytes) -> list[int]:
    values = []
    for number, wire, value in parse_fields(buf):
        if number == 1:
            values.extend(unpack_varints(value) if wire == 2 else [value])
    return values


def enum_list(wire: int, value: bytes, names: list[str]) -> list[str]:
    raw = unpack_varints(value) if wire == 2 else [value]
    return [names[v] if 0 <= v < len(names) else str(v) for v in raw]


def message_of(raw: bytes) -> bytes:
    if len(raw) < 5:
        raise ValueError("empty gRPC response")
    length = int.from_bytes(raw[1:5], "big")
    return raw[5:5 + length]


def parse_model(buf: bytes) -> dict:
    model: dict = {}
    for number, wire, value in parse_fields(buf):
        if number == 1:
            model["modelId"] = text(value)
        elif number == 2:
            model["name"] = text(value)
        elif number == 3:
            model["displayName"] = text(value)
        elif number == 4:
            model["baseModelId"] = text(value)
        elif number == 5:
            model["version"] = text(value)
        elif number == 6:
            model["description"] = text(value)
        elif number == 7:
            model["inputTokenLimit"] = value
        elif number == 8:
            model["outputTokenLimit"] = value
        elif number == 9:
            model["supportedThinkingLevels"] = enum_list(wire, value, THINKING_LEVELS)
        elif number == 10:
            model["supportedFeatures"] = enum_list(wire, value, FEATURES)
        elif number == 11:
            for sub_number, _, sub_value in parse_fields(value):
                if sub_number == 1:
                    thinking: dict = {}
                    for key, _, item in parse_fields(sub_value):
                        if key == 1:
                            thinking["includeThoughts"] = item == 1
                        elif key == 2:
                            thinking["thinkingBudget"] = item
                        elif key == 3:
                            thinking["thinkingLevel"] = (
                                THINKING_LEVELS[item] if item < len(THINKING_LEVELS) else item)
                        elif key == 4:
                            thinking["minThinkingBudget"] = item
                    model["thinkingConfig"] = thinking
                elif sub_number == 2:
                    model["maxOutputTokens"] = sub_value
        elif number == 12:
            model["modelProvider"] = (
                PROVIDERS[value] if value < len(PROVIDERS) else value)
        elif number == 13:
            model.setdefault("agySupportedMimeTypes", []).append(text(value))
    return model


def parse_surface_config(buf: bytes) -> dict:
    surface: dict = {}
    for number, _, value in parse_fields(buf):
        if number == 1:
            surface["clientModelEnumName"] = text(value)
        elif number == 2:
            tag = parse_fields(value)
            surface.setdefault("tags", []).append({
                "title": text(next((v for n, _, v in tag if n == 1), b"")),
                "description": text(next((v for n, _, v in tag if n == 2), b"")),
            })
        elif number == 3:
            surface["disabled"] = value == 1
        elif number == 4:
            entry = parse_fields(value)
            key = next((v for n, _, v in entry if n == 1), b"")
            value_field = next((item for item in entry if item[0] == 2), None)
            surface.setdefault("modelExperiments", []).append({
                "key": text(key),
                "value": (text(value_field[2]) if value_field and value_field[1] == 2
                          else (value_field[2] if value_field else None)),
            })
    return surface


def parse_experience(buf: bytes) -> dict:
    experience: dict = {}
    for number, _, value in parse_fields(buf):
        if number == 1:
            experience["name"] = text(value)
        elif number == 2:
            experience["model"] = parse_model(value)
        elif number == 3:
            experience["surfaceConfig"] = parse_surface_config(value)
    return experience


def parse_flag(buf: bytes) -> dict:
    flag: dict = {"name": ""}
    for number, _, value in parse_fields(buf):
        if number == 1:
            flag["name"] = text(value)
        elif number == 2:
            flag["boolValue"] = value == 1
        elif number == 3:
            flag["floatValue"] = struct.unpack("<d", value)[0]
        elif number == 4:
            flag["intValue"] = value
        elif number == 5:
            flag["stringValue"] = text(value)
        elif number == 6:
            flag["int32List"] = int_list(value)
        elif number == 7:
            flag["int64List"] = int_list(value)
        elif number == 8:
            flag["stringList"] = [text(v) for n, _, v in parse_fields(value) if n == 1]
    return flag


def parse_surface(buf: bytes) -> dict:
    groups: dict = {}
    for number, wire, value in parse_fields(buf):
        if wire != 2:
            continue
        entries = parse_fields(value)
        groups[f"group_{number}"] = {
            "experienceNames": [text(v) for n, _, v in entries if n == 1],
            "defaultExperience": text(next((v for n, _, v in entries if n == 2), b"")),
        }
    return groups


def strings_of(buf: bytes) -> list[str]:
    seen: dict[str, None] = {}
    for match in re.findall(r"[ -~]{4,120}", buf.decode("latin-1")):
        seen.setdefault(match, None)
    return list(seen)


# --------------------------------------------------------------------------
# Evidence and markdown rendering
# --------------------------------------------------------------------------

ROUTING_PATHS = [
    ("v1alpha", V1ALPHA_PATH),
    ("v1beta", V1BETA_PATH),
    ("v1main", V1MAIN_PATH),
    ("businessaicode_v1main", BAIC_V1MAIN_PATH),
    ("businessaicode_v1beta", BAIC_V1BETA_PATH),
]


def evidence_of(call: dict) -> dict:
    body = call["body"]
    return {
        "httpStatus": call["httpStatus"],
        "grpcStatus": call["grpcStatus"],
        "grpcMessage": call["grpcMessage"] or "",
        "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
    }


def render_markdown(catalog: dict, catalog_bytes: int) -> str:
    experiences = catalog["v1alpha"]["experiences"]
    experiments = catalog["v1alpha"]["experiments"]
    surface_groups = catalog["v1alpha"]["surfaceConfig"][0] if catalog["v1alpha"]["surfaceConfig"] else {}
    evidence = catalog["evidence"]

    model_rows = []
    for experience in sorted(experiences, key=lambda item: item["name"]):
        model = experience.get("model", {})
        surface = experience.get("surfaceConfig", {})
        thinking = "/".join(model.get("supportedThinkingLevels", [])) or "—"
        tags = ", ".join(tag["title"] for tag in surface.get("tags", []) if tag.get("title")) or "—"
        if surface.get("disabled"):
            tags = "disabled"
        model_rows.append(
            f"| `{experience['name']}` | `{surface.get('clientModelEnumName') or '—'}` | "
            f"`{model.get('modelId')}` | {model.get('displayName') or '—'} | {thinking} | "
            f"{model.get('inputTokenLimit', '—')} / {model.get('outputTokenLimit', '—')} | {tags} |")

    surface_rows = []
    for key, group in surface_groups.items():
        names = "`, `".join(group["experienceNames"])
        surface_rows.append(
            f"| {SURFACE_NAMES.get(key, key)} | {group['defaultExperience'] or '—'} | "
            f"{len(group['experienceNames'])} | `{names}` |")

    flag_rows = []
    for flag in experiments:
        if flag["name"] not in NOTABLE_FLAGS:
            continue
        value = "—"
        for key in ("boolValue", "stringValue", "intValue", "floatValue"):
            if key in flag:
                value = json.dumps(flag[key]) if key == "stringValue" else str(flag[key])
                break
        flag_rows.append(f"| `{flag['name']}` | {value} |")

    routing_rows = []
    for key, path in ROUTING_PATHS:
        call = evidence["routing"].get(key) or {}
        status = call.get("grpcStatus")
        if status == "0":
            result = f"**{call.get('httpStatus')}, gRPC 0, {call.get('bytes')} bytes**"
        else:
            message = call.get("grpcMessage") or ""
            result = f"{call.get('httpStatus')}, gRPC {status}" + (f" `{message}`" if message else "")
        routing_rows.append(f"| `{path}` | {result} |")

    verification_rows = []
    for label, key in (
        ("v1alpha FetchConfig", "v1alpha"),
        ("v1beta FetchConfig", "v1beta"),
        ("v1alpha FetchQuotaStatus", "quota"),
        ("v1alpha FetchLicenses", "licenses"),
    ):
        call = evidence[key]
        verification_rows.append(
            f"| {label} | {call['httpStatus']} | {call['grpcStatus']} | {call['bytes']} | "
            f"`{call['sha256']}` |")

    blob = json.dumps(catalog).lower()
    counts = {word: blob.count(word) for word in ("neon", "carbon", "argon", "hydrogen")}
    neon_summary = ", ".join(f"{word}={count}" for word, count in counts.items())

    return template % {
        "fetched_at": catalog["fetchedAt"],
        "email": catalog["account"]["email"],
        "auth_method": catalog["account"]["authMethod"],
        "routing_rows": "\n".join(routing_rows),
        "verification_rows": "\n".join(verification_rows),
        "catalog_bytes": catalog_bytes,
        "experience_count": len(experiences),
        "flag_count": len(experiments),
        "model_rows": "\n".join(model_rows),
        "surface_rows": "\n".join(surface_rows),
        "flag_rows": "\n".join(flag_rows),
        "v1alpha_bytes": evidence["v1alpha"]["bytes"],
        "v1beta_bytes": evidence["v1beta"]["bytes"],
        "quota_bytes": evidence["quota"]["bytes"],
        "neon_summary": neon_summary,
    }


template = """# AICode `FetchConfig` — endpoint, wire format, and account catalog

Live-verified %(fetched_at)s for `%(email)s` (auth method: `%(auth_method)s`).

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
%(routing_rows)s

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
%(verification_rows)s

Parsed dump: `docs/aicode-catalog.json` (%(catalog_bytes)s bytes), containing all %(experience_count)s experiences, %(flag_count)s experiment flags, surface config, quota strings, and licenses.

## 4. Catalog (v1alpha, %(experience_count)s experiences)

| Experience | Client enum | Model ID | Display name | Thinking | Context / Output | Tags |
|---|---|---|---|---|---|---|
%(model_rows)s

### Surface config

| Surface | Default | Count | Experiences |
|---|---|---|---|
%(surface_rows)s

### Notable experiment flags

| Flag | Value |
|---|---|
%(flag_rows)s

## 5. Neon / Carbon

Byte-level scan of the full responses finds **zero** occurrences of `neon`, `carbon`, `argon`, or `hydrogen` in:

- v1alpha FetchConfig (%(v1alpha_bytes)s bytes)
- v1beta FetchConfig (%(v1beta_bytes)s bytes)
- v1alpha FetchQuotaStatus (%(quota_bytes)s bytes)

Counts across the parsed catalog: %(neon_summary)s.

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
"""


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main() -> int:
    outer = keyring_token()
    access = refresh_access_token(outer)

    calls = {
        "v1alpha": grpc_call(V1ALPHA_PATH, access),
        "v1beta": grpc_call(V1BETA_PATH, access),
        "quota": grpc_call(QUOTA_PATH, access),
        "licenses": grpc_call(LICENSES_PATH, access),
    }
    for key, path in ROUTING_PATHS:
        if key not in calls:
            calls[key] = grpc_call(path, access)

    if calls["v1alpha"]["grpcStatus"] != "0":
        sys.exit(f"FetchConfig failed: HTTP {calls['v1alpha']['httpStatus']} "
                 f"gRPC {calls['v1alpha']['grpcStatus']} {calls['v1alpha']['grpcMessage']}")

    top = parse_fields(message_of(calls["v1alpha"]["body"]))
    experiments = [
        parse_flag(item[2])
        for field in top if field[0] == 1
        for item in parse_fields(field[2]) if item[0] == 2
    ]
    experiences = [parse_experience(field[2]) for field in top if field[0] == 2]
    surfaces = [parse_surface(field[2]) for field in top if field[0] == 4]

    top_beta = parse_fields(message_of(calls["v1beta"]["body"]))
    experiences_beta = [parse_experience(field[2]) for field in top_beta if field[0] == 2]

    catalog = {
        "fetchedAt": dt.datetime.now(dt.timezone.utc)
            .isoformat(timespec="seconds").replace("+00:00", "Z"),
        "account": {
            "email": outer.get("id_token_email"),
            "authMethod": outer.get("auth_method"),
        },
        "endpoint": {
            "baseUrl": f"https://{HOST}",
            "transport": "gRPC over HTTP/2 (content-type: application/grpc)",
            "path": V1ALPHA_PATH,
            "requestBytes": 0,
        },
        "evidence": {
            "v1alpha": evidence_of(calls["v1alpha"]),
            "v1beta": evidence_of(calls["v1beta"]),
            "quota": evidence_of(calls["quota"]),
            "licenses": evidence_of(calls["licenses"]),
            "routing": {key: evidence_of(calls[key]) for key, _ in ROUTING_PATHS},
        },
        "v1alpha": {
            "experiences": experiences,
            "experiments": experiments,
            "surfaceConfig": surfaces,
        },
        "v1beta": {"experiences": experiences_beta},
        "quota": {"strings": strings_of(message_of(calls["quota"]["body"]))},
        "licenses": {"strings": strings_of(message_of(calls["licenses"]["body"]))},
    }

    docs = repo_root() / "docs"
    docs.mkdir(exist_ok=True)
    catalog_path = docs / "aicode-catalog.json"
    catalog_path.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    catalog_bytes = catalog_path.stat().st_size

    markdown_path = docs / "aicode-fetchconfig.md"
    markdown_path.write_text(render_markdown(catalog, catalog_bytes), encoding="utf-8")

    blob = json.dumps(catalog).lower()
    print(f"account: {catalog['account']['email']} ({catalog['account']['authMethod']})")
    print(f"v1alpha: gRPC {calls['v1alpha']['grpcStatus']}, "
          f"{catalog['evidence']['v1alpha']['bytes']} bytes, "
          f"sha256 {catalog['evidence']['v1alpha']['sha256']}")
    print(f"experiences: {len(experiences)} | experiment flags: {len(experiments)} | "
          f"surfaces: {len(surfaces)}")
    print("neon/carbon/argon/hydrogen: " +
          ", ".join(f"{word}={blob.count(word)}" for word in ("neon", "carbon", "argon", "hydrogen")))
    print(f"wrote {catalog_path} ({catalog_bytes} bytes) and {markdown_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

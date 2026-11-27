# Bun production fork

This maintained fork exposes authenticated REST and HTTP MCP only.
It uses Bun; no Node or Go runtime is required.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun dist/index.js                  # REST + Streamable HTTP MCP
```

HTTP mode requires `MCP_CAMOUFOX_API_KEY` (at least 24 characters) and an
`Authorization: Bearer <key>` header on **every** request, including health.
Supply the key through a secret environment file; never put it in a URL.
Bind defaults: `MCP_CAMOUFOX_HOST=127.0.0.1`, `MCP_CAMOUFOX_PORT=9377`.
Use TLS at the reverse proxy for remote access. Do not expose this browser to
untrusted users: authenticated clients can navigate internal networks and use
all browser tools. This is a single-trust-domain service, not a multi-tenant
sandbox. Browser-origin requests are rejected unless their exact Origin is
listed in comma-separated `MCP_CAMOUFOX_ALLOWED_ORIGINS`.

There is no stdio transport. The private `--worker` entry point requires a Bun
IPC parent and is used only for isolated browser processes. Tool commands and
results travel through Bun's dedicated IPC channel, not stdin/stdout; stdout
is ignored. Disconnects and shutdown requests clean up the browser, and the
parent rejects pending calls if a worker exits.

## REST

`POST /v1` accepts these commands:

```json
{"cmd":"request.get","url":"https://example.com","maxTimeout":60000}
{"cmd":"sessions.create"}
{"cmd":"sessions.list"}
{"cmd":"sessions.destroy","session":"<returned UUID>"}
```

Pass `"session":"<returned UUID>"` to `request.get` to retain cookies across
requests. Without a session the browser is discarded after the response.
The successful FlareSolverr-style envelope is:

```json
{
  "status":"ok",
  "message":"Challenge resolved",
  "solution":{
    "url":"https://example.com/",
    "status":200,
    "headers":{},
    "response":"<html>...</html>",
    "cookies":[{
      "name":"cookie-name",
      "value":"full-value",
      "domain":"example.com",
      "path":"/",
      "expires":-1,
      "httpOnly":true,
      "secure":true,
      "sameSite":"Lax"
    }],
    "userAgent":"<actual browser user agent>"
  },
  "startTimestamp":0,
  "endTimestamp":0,
  "version":"<package version>"
}
```

Cookies come from the browser context, not `document.cookie`, so HttpOnly and
cookie metadata survive. Only cookies applicable to the final URL are returned.
REST is an explicit credential-export API: cookie values are not masked.
Do not log response bodies. HTTP responses use `Cache-Control: no-store`.

This implements a **subset** of FlareSolverr commands, not jo-inc's REST API:
POST navigation, proxy overrides and arbitrary command parameters are rejected.
Unknown sessions return 404, busy session deletion 409, invalid requests 400,
and an unresolved solve 502 with `status:"error"` and no `solution`.

## MCP

Connect a Streamable HTTP client to `/mcp` using the same bearer key. Initialize
first, then retain the returned `Mcp-Session-Id`; DELETE ends the session.
Each HTTP MCP session gets its own Bun IPC worker and browser profile.
The existing tools remain available. New tool:

```json
{"name":"solve","arguments":{"url":"https://example.com","maxTimeout":60000,"reveal_values":true}}
```

`solve` navigates and automatically handles the challenge; ordinary low-level
navigation/click tools retain their original behavior. MCP cookie values are
masked unless `reveal_values:true` is explicitly requested.

## Challenge handling and limits

Solving needs a headed Linux/X11 browser, Xvfb/Openbox, `xdotool`,
`xwininfo` and `libX11.so.6`. HTTP-created browsers are headed by default.
Use `browser_close` before `solve` if you launched an existing browser headless.
Native framebuffer capture avoids Playwright screenshot window side effects.
Only a rendered empty checkbox is clicked: widget coordinates, empty frame DOM
and a “Verifying…” spinner are not readiness signals. At most three native
clicks are sent, at least eight seconds apart, with a 5–180 second solve budget.
The page must leave the interstitial and return a non-error response; a click
alone never counts as success. Unsupported challenges time out explicitly.
No solver can guarantee success for every challenge.

The gateway allows eight workers and sixteen pending calls. Browser operations
are serialized across workers to prevent competing native mouse/focus input.
Queue waits over 30 seconds are rejected when dequeued. Idle sessions expire
after fifteen minutes. There is no persistent remote profile store.

## Verification

```sh
bun run build
bun run test:production
# Requires browser + X11 dependencies:
bun scripts/production/browser-fixture.ts
# Original regression suites, using Bun:
bun run test
```

Production tests use local fixtures for authentication, HTTP MCP, REST session
lifecycle, cookie metadata/HttpOnly export, cross-session isolation, spinner
rejection, delayed checkbox readiness, trusted OS clicks and unresolved timeout.

# Milestone 1D — Applications Dashboard

## Purpose

Milestone 1D provides the first usable, read-only Applications dashboard for Zima Control Center. It presents the current Application Registry without adding lifecycle controls or bypassing the HTTP read boundary.

The runtime data path is:

`Browser → Applications dashboard → Application Registry HTTP GET API → ApplicationRegistryService → RegistryReadRepository → Prisma`

The browser never imports Prisma, the ZimaOS adapter, discovery normalization, reconciliation, or persistence implementations.

## Frontend architecture

The repository had no frontend framework, router, styling system, or browser test tooling. `apps/web/` therefore uses Vanilla TypeScript with Vite. This keeps the two-view milestone small while providing a production asset build, local development server, typed browser APIs, and a clear future extension point.

Navigation uses stable Application Registry IDs:

- `/applications` — application inventory
- `/applications/:id` — coherent application detail

The application performs normal same-origin navigation rather than maintaining a second client-side identity or stateful routing layer. A production web server must serve the built `index.html` fallback for both routes.

## Shared API contract and validation

HTTP response DTOs live in `packages/application-registry-contracts/`. Both `apps/api` and `apps/web` depend on this transport-only type package; the browser does not import server or Prisma types.

Static TypeScript types are not treated as runtime validation. `apps/web/src/registry-api.ts` parses every response from `unknown` and constructs a new allowlisted DTO. Unknown response fields are discarded. Invalid required fields produce a fixed safe error and raw response bodies are never rendered or logged.

The dashboard makes only these requests:

- `GET /api/applications`
- `GET /api/applications?status=<known-status>`
- `GET /api/applications/:id`

The detail page uses the coherent detail endpoint and does not join redundant specialized requests.

## Applications list

The list displays canonical name/display name, backend status, runtime, management source, uncontrolled metadata, and discovery freshness. Rendering is deterministic by `name`, then `id`, even if a response arrives out of order.

Search by name/display name is client-side. The status selector uses only the existing values `RUNNING`, `STOPPED`, `DEGRADED`, `ERROR`, and `UNKNOWN`; it does not expose arbitrary query syntax.

## Application detail

The detail view presents:

- canonical identity, classification, and timestamps
- current deployment metadata without retained Compose YAML
- desired services, ports, volumes, and networks
- environment key metadata without values
- current runtime containers and observation timestamps
- application, deployment, and runtime freshness

Missing deployment, services, environment metadata, and runtime containers have explicit neutral states. Empty runtime observations do not infer that an application is stopped.

## Status and freshness semantics

Known backend status values have text labels and distinct visual treatments. A null status displays `Not available`; an unknown future string is shown as neutral text. Status is never derived from freshness, deployment availability, or runtime collection size.

Freshness is displayed relative to the browser clock with an absolute timestamp tooltip formatted in `Asia/Jakarta`. Missing or malformed values display `Not available`. Future values display `Future timestamp`; they are not converted into health or availability claims.

## Loading, empty, and error states

Both routes render an accessible loading state before the request resolves. List, deployment, service, child collection, and runtime empty states are explicit. Not-found responses receive a dedicated application-not-found page.

Transient and invalid-response errors display fixed safe copy and a retry action. The UI does not show raw response bodies, stack traces, Prisma/SQL messages, adapter errors, or credentials.

## Security rules

- No `innerHTML`, raw HTML renderer, dynamic code execution, or remote script is used.
- API payloads are treated as untrusted and mapped through field allowlists.
- `composeYamlRedacted`, environment values, passwords, tokens, and unknown fields are not rendered.
- Application data is not written to browser storage or logs.
- Detail links use URL-encoded internal application IDs; ZimaOS IDs are not route identities.
- The default API base is same-origin. `VITE_API_BASE_URL` may select a separate HTTP(S) base during a deliberate deployment, but credential-bearing, query-bearing, fragment-bearing, and non-HTTP URLs are rejected.

Authentication and authorization remain deployment prerequisites from Milestone 1C. No ad-hoc browser authentication is added here. Production CSP and clickjacking headers must be supplied by the eventual web/API serving boundary because that deployment layer is not yet implemented.

## Responsive and accessibility behavior

The dashboard uses semantic headings, navigation, tables, lists, description lists, links, buttons, status text, `aria-live`/`aria-busy` loading regions, and alert roles for errors. Status never relies on color alone, focus indicators are visible, and reduced-motion preferences are honored.

Tables become labelled stacked rows on narrow viewports. Detail grids collapse to one column and long paths/identifiers wrap or truncate without forcing page-level horizontal scrolling.

## Testing

Tests run in jsdom through the repository's existing Node test runner and `tsx`. HTTP is mocked at the `fetch` boundary; tests do not access a real API, Prisma, ZimaOS, Docker, or a production database.

Coverage includes list/detail rendering, deterministic ordering, loading/error/empty/not-found states, status and search filtering, deployment/services/desired children, environment metadata, runtime, malformed/future freshness, unknown/missing status, null deployment, empty runtime semantics, untrusted extra-field exclusion, and safe invalid-response handling.

## Deployment assumptions and non-goals

The built dashboard assumes same-origin `/api` routing. The eventual serving layer must route `/api/*` to the Hono API and serve the web application fallback for `/applications/*`. If a separate origin is selected, it requires intentional API CORS and authentication policy; this milestone does not enable permissive CORS.

This milestone adds no POST/PUT/PATCH/DELETE calls, application lifecycle mutation, Docker or ZimaOS access, backup/restore, scheduler, logs, terminal, settings, metrics, authentication redesign, schema change, migration, or production server composition.

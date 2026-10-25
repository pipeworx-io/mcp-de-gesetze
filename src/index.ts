interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * German federal statutes and ordinances (Bundesrecht) — search by title or
 * official abbreviation (BGB, StGB, HGB, BDSG, GG…), read a single § or Art.
 * in full, browse a law's structure, and get its amendment status ("Stand"),
 * from Gesetze im Internet (BMJ/juris).
 *
 * Fleet #3123. SOURCE AND SHAPE. Gesetze im Internet publishes a single table of contents
 * (one law/ordinance per entry: official title + a per-law XML package link)
 * and, per law, a ZIP containing one XML file (DTD gii-norm.dtd): a flat
 * sequence of <norm> elements — the law's own front matter (abbreviation,
 * date of promulgation, official citation, amendment status), structural
 * headings (Buch/Abschnitt/Titel/Kapitel), and the individual §/Art.
 * provisions with their text and footnotes. See src/gii.ts for the parser.
 *
 * BAKED INDEX. The table of contents (title + per-law URL slug, ~6,100
 * entries, ~800KB as a data module) is baked to KV via
 * workers/gateway/src/pack-baked-indexes.json — never imported at module
 * scope (CLAUDE.md, fleet #2754) — and injected as `args._bakedIndex` on the
 * first call into this pack. scripts/bake-de-gesetze-index.mjs regenerates
 * it from ONE live call.
 *
 * ABBREVIATION MATCHING. The table of contents carries no separate
 * abbreviation field — only title + URL slug. For the large majority of
 * entries the slug IS the law's lowercase official abbreviation (juris's own
 * convention: bgb -> BGB, stgb -> StGB, estg -> EStG). gesetze_search and
 * gesetze_law_info/_structure/_provision resolve an abbreviation against the
 * slug first; this is a documented convention, not a guarantee for every one
 * of the ~6,100 entries (an obscure ordinance's slug occasionally departs
 * from its cited abbreviation). gesetze_search's title search is the
 * fallback for anything that does not resolve this way.
 *
 * PER-LAW FETCH IS LIVE, PER CALL (proxy, never baked): gesetze_law_info,
 * gesetze_structure and gesetze_provision each fetch and parse the one law's
 * ZIP package live. A short per-isolate cache (15 min, capped) avoids
 * re-fetching the same law repeatedly within one isolate's life; it is never
 * the only copy and is never served after the isolate recycles.
 *
 * AMENDMENT METADATA ("Stand"). The front matter's <standangabe> entries
 * (typically "Neufassung" and "Stand", i.e. the date and act of the law's
 * current consolidated version) are the official, structured amendment
 * status. A "Geltung ab: <date>" line sometimes appears in the front
 * matter's own footnote free text (not every law carries one); when present
 * it is parsed into `entry_into_force_date`. Publication date is
 * `ausfertigung_datum` (date the law was signed) — a separate field from
 * entry into force on purpose (CLAUDE.md legal-pack contract, point 2).
 *
 * COPYRIGHT. German federal legislative and administrative texts are
 * "amtliche Werke" and not protected by copyright (§ 5 Urheberrechtsgesetz).
 *
 * Keyless, no signup.
 */
import type { DeLawRow } from './de-index-data.js';
import {
  citationToken,
  enbezToken,
  entryIntoForce,
  extractLawXml,
  parseLawXml,
  type GiiNorm,
  type ParsedLaw,
} from './gii.js';

const UPSTREAM = 'Bundesministerium der Justiz (BMJ) / juris GmbH';
const DATASET = 'Gesetze im Internet';
const SOURCE = `${UPSTREAM}, ${DATASET}`;
const UA = 'pipeworx-mcp-de-gesetze/1.0 (+https://pipeworx.io)';
const COPYRIGHT_NOTE = 'German federal legislative texts are "amtliche Werke" and not protected by copyright (§ 5 Urheberrechtsgesetz).';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, UPSTREAM, 20000);
}

// ── baked index ──────────────────────────────────────────────────────────

// NEVER value-import ./de-index-data.js here — a type-only import (above) is
// erased at build time; a value import puts the whole ~800KB table back into
// every gateway isolate's bundle regardless of whether it ever serves this
// pack (fleet #2754 — the exact live incident this convention exists to
// prevent). The gateway loads it from KV on the first call into this pack.
let DE_LAWS: DeLawRow[] = [];
let DE_INDEX_CAPTURED_AT = '';
function ensureIndex(args: Record<string, unknown>): void {
  if (DE_LAWS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const laws = idx?.DE_LAWS;
  const capturedAt = idx?.DE_INDEX_CAPTURED_AT;
  if (!Array.isArray(laws) || laws.length === 0 || typeof capturedAt !== 'string') {
    throw new Error(
      `de-gesetze: the baked law index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad citation or query — retry shortly.',
    );
  }
  DE_LAWS = laws as DeLawRow[];
  DE_INDEX_CAPTURED_AT = capturedAt;
  slugIndex = null;
}

let slugIndex: Map<string, number> | null = null;
function bySlug(): Map<string, number> {
  if (slugIndex) return slugIndex;
  const m = new Map<string, number>();
  DE_LAWS.forEach(([slug], i) => m.set(slug.toLowerCase(), i));
  slugIndex = m;
  return m;
}

function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
}

type LawResolution =
  | { ok: true; slug: string; title: string }
  | { ok: false; reason: 'empty_law' }
  | { ok: false; reason: 'law_not_found'; candidates: { slug: string; title: string }[] }
  | { ok: false; reason: 'ambiguous_law'; candidates: { slug: string; title: string }[] };

/** Resolve a law abbreviation/slug/title to one catalog entry. Exact-ish only —
 *  gesetze_search is the fuzzy/browsing tool; this is for callers who already
 *  know (roughly) what they want. */
function resolveLaw(input: unknown): LawResolution {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty_law' };
  const key = normKey(raw);
  const direct = bySlug().get(key);
  if (direct != null) return { ok: true, slug: DE_LAWS[direct][0], title: DE_LAWS[direct][1] };

  const exactTitle = DE_LAWS.find(([, title]) => title.toLowerCase() === raw.toLowerCase());
  if (exactTitle) return { ok: true, slug: exactTitle[0], title: exactTitle[1] };

  // Whole-word title match as a fallback — e.g. "Bürgerliches Gesetzbuch" typed
  // in full, or a slug typo close enough that a word still lines up.
  const words = raw.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (words.length) {
    const hits = DE_LAWS.filter(([, title]) => {
      const t = title.toLowerCase();
      return words.every((w) => t.includes(w));
    });
    if (hits.length === 1) return { ok: true, slug: hits[0][0], title: hits[0][1] };
    if (hits.length > 1 && hits.length <= 8) {
      return { ok: false, reason: 'ambiguous_law', candidates: hits.map(([slug, title]) => ({ slug, title })) };
    }
  }
  return {
    ok: false,
    reason: 'law_not_found',
    candidates: [],
  };
}

function lawMiss(raw: unknown, m: Exclude<LawResolution, { ok: true }>) {
  if (m.reason === 'empty_law') {
    return { found: false, reason: m.reason, message: 'Pass `law` — an abbreviation ("BGB", "StGB", "BDSG") or a title, e.g. "Bürgerliches Gesetzbuch". Call gesetze_search first if you are not sure of the abbreviation.' };
  }
  if (m.reason === 'ambiguous_law') {
    return {
      found: false,
      reason: m.reason,
      law: String(raw),
      message: `"${String(raw)}" matches several laws; pass one of the candidate abbreviations.`,
      candidates: m.candidates,
    };
  }
  return {
    found: false,
    reason: m.reason,
    law: String(raw),
    message: `No law or ordinance in the Gesetze im Internet collection matches "${String(raw)}".`,
    hint: 'Call gesetze_search with a title keyword to find the right abbreviation.',
  };
}

// ── per-isolate law cache (live fetch, never baked) ─────────────────────

const LAW_CACHE_TTL_MS = 15 * 60 * 1000;
const LAW_CACHE_MAX = 12;
const lawCache = new Map<string, { at: number; parsed: ParsedLaw }>();

async function loadLaw(slug: string): Promise<ParsedLaw> {
  const hit = lawCache.get(slug);
  if (hit && Date.now() - hit.at < LAW_CACHE_TTL_MS) return hit.parsed;

  const url = `https://www.gesetze-im-internet.de/${encodeURIComponent(slug)}/xml.zip`;
  const res = await pwFetch(url);
  if (!res.ok) throw await httpError(res, `${UPSTREAM} (law package)`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!buf.length) {
    throw new Error(`upstream_down: ${UPSTREAM} answered HTTP ${res.status} with an EMPTY package for "${slug}". Nothing about the request can cause this — retry is reasonable.`);
  }
  const xml = await extractLawXml(buf);
  const parsed = parseLawXml(xml);

  if (lawCache.size >= LAW_CACHE_MAX) {
    const oldest = [...lawCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) lawCache.delete(oldest[0]);
  }
  lawCache.set(slug, { at: Date.now(), parsed });
  return parsed;
}

function lawHeader(slug: string, title: string, parsed: ParsedLaw) {
  const eif = entryIntoForce(parsed.front);
  return {
    law: title,
    abbreviation: parsed.front.jurabk ?? parsed.front.amtabk ?? slug.toUpperCase(),
    official_title: parsed.front.langue ?? title,
    publication_date: parsed.front.ausfertigungDatum,
    official_citation: parsed.front.fundstelle
      ? `${parsed.front.fundstelle.periodikum ?? ''} ${parsed.front.fundstelle.zitstelle ?? ''}`.trim() || null
      : null,
    entry_into_force_date: eif.iso,
    entry_into_force_raw: eif.raw,
    amendment_status: parsed.front.standangabe.map((s) => ({ type: s.typ, note: s.kommentar })),
    source: SOURCE,
    data_as_of: DE_INDEX_CAPTURED_AT,
    source_document_built: parsed.builddate
      ? `${parsed.builddate.slice(0, 4)}-${parsed.builddate.slice(4, 6)}-${parsed.builddate.slice(6, 8)}`
      : null,
    copyright: COPYRIGHT_NOTE,
  };
}

// ── gesetze_search ────────────────────────────────────────────────────────

interface SearchHit { idx: number; score: number }

function wordWeights(words: string[], haystacks: string[]): Map<string, number> {
  const weight = new Map<string, number>();
  for (const w of words) {
    let df = 0;
    for (const h of haystacks) if (h.includes(w)) df++;
    weight.set(w, 1 / Math.max(1, df));
  }
  return weight;
}

let haystackCache: string[] | null = null;
function haystacks(): string[] {
  if (haystackCache && haystackCache.length === DE_LAWS.length) return haystackCache;
  haystackCache = DE_LAWS.map(([slug, title]) => `${slug} ${title}`.toLowerCase());
  return haystackCache;
}

async function gesetzeSearch(args: Record<string, unknown>) {
  const q = String(args.query ?? '').trim();
  if (!q) {
    return { found: false, reason: 'empty_query', message: 'gesetze_search needs a `query` — a title keyword ("Datenschutz", "Straßenverkehr") or an abbreviation ("BGB", "StGB").' };
  }
  const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));

  // Exact/near abbreviation match first — "BGB" should return the BGB, not a
  // word-overlap ranking of every title containing similar letters.
  const key = normKey(q);
  const slugHit = bySlug().get(key);
  if (slugHit != null) {
    const [slug, title] = DE_LAWS[slugHit];
    return {
      found: true,
      query: q,
      match_level: 'abbreviation_exact',
      count: 1,
      results: [{ abbreviation: slug.toUpperCase(), slug, title }],
      hint: 'Call gesetze_law_info, gesetze_structure or gesetze_provision with this abbreviation.',
      source: SOURCE,
      data_as_of: DE_INDEX_CAPTURED_AT,
    };
  }

  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) {
    return { found: false, reason: 'query_too_short', query: q, message: `"${q}" has no usable word to match against law titles.` };
  }
  const hs = haystacks();
  const weight = wordWeights(words, hs);
  const hits: SearchHit[] = [];
  for (let i = 0; i < DE_LAWS.length; i++) {
    const h = hs[i]!;
    let score = 0;
    for (const w of words) if (h.includes(w)) score += weight.get(w) ?? 1;
    if (score > 0) hits.push({ idx: i, score });
  }
  hits.sort((a, b) => b.score - a.score);

  if (!hits.length) {
    return {
      found: false,
      query: q,
      message: `No law or ordinance title in the Gesetze im Internet collection matched "${q}".`,
      laws_scanned: DE_LAWS.length,
      data_as_of: DE_INDEX_CAPTURED_AT,
    };
  }
  const results = hits.slice(0, limit).map(({ idx, score }) => {
    const [slug, title] = DE_LAWS[idx];
    return { abbreviation: slug.toUpperCase(), slug, title, score: Math.round(score * 1000) / 1000 };
  });
  return {
    found: true,
    query: q,
    match_level: 'title_word_overlap',
    count: results.length,
    total_matched: hits.length,
    has_more: hits.length > limit,
    results,
    hint: 'Call gesetze_law_info, gesetze_structure or gesetze_provision with the abbreviation above.',
    source: SOURCE,
    data_as_of: DE_INDEX_CAPTURED_AT,
  };
}

// ── gesetze_law_info ──────────────────────────────────────────────────────

async function gesetzeLawInfo(args: Record<string, unknown>) {
  const m = resolveLaw(args.law);
  if (!m.ok) return lawMiss(args.law, m);
  const parsed = await loadLaw(m.slug);
  const provisionCount = parsed.norms.filter((n) => n.enbez && !n.gliederung).length;
  const structuralCount = parsed.norms.filter((n) => n.gliederung).length;
  return {
    found: true,
    ...lawHeader(m.slug, m.title, parsed),
    provision_count: provisionCount,
    structural_heading_count: structuralCount,
    hint: 'gesetze_structure lists the table of contents; gesetze_provision returns one § or Art. in full.',
  };
}

// ── gesetze_structure ─────────────────────────────────────────────────────

interface TreeNode {
  kennzahl: string;
  bez: string | null;
  titel: string | null;
  children: TreeNode[];
  provisions: { enbez: string; titel: string | null }[];
}

function buildTree(norms: GiiNorm[]): { roots: TreeNode[]; rootProvisions: { enbez: string; titel: string | null }[] } {
  const roots: TreeNode[] = [];
  const rootProvisions: { enbez: string; titel: string | null }[] = [];
  const stack: TreeNode[] = [];

  const depthOf = (kennzahl: string) => Math.max(1, Math.ceil(kennzahl.length / 3));

  for (const n of norms) {
    if (n.gliederung) {
      const kennzahl = n.gliederung.kennzahl || '';
      const depth = depthOf(kennzahl);
      while (stack.length >= depth) stack.pop();
      const node: TreeNode = { kennzahl, bez: n.gliederung.bez, titel: n.gliederung.titel, children: [], provisions: [] };
      if (stack.length === 0) roots.push(node);
      else stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (n.enbez) {
      const entry = { enbez: n.enbez, titel: n.titel };
      if (stack.length === 0) rootProvisions.push(entry);
      else stack[stack.length - 1].provisions.push(entry);
    }
  }
  return { roots, rootProvisions };
}

function findNode(nodes: TreeNode[], kennzahl: string): TreeNode | null {
  for (const n of nodes) {
    if (n.kennzahl === kennzahl) return n;
    const found = findNode(n.children, kennzahl);
    if (found) return found;
  }
  return null;
}

function pruneNode(node: TreeNode, depth: number, maxDepth: number, provisionLimit: number): Record<string, unknown> {
  const countAll = (n: TreeNode): { headings: number; provisions: number } => {
    let headings = 0;
    let provisions = n.provisions.length;
    for (const c of n.children) {
      const k = countAll(c);
      headings += 1 + k.headings;
      provisions += k.provisions;
    }
    return { headings, provisions };
  };
  const out: Record<string, unknown> = { section_id: node.kennzahl, heading: [node.bez, node.titel].filter(Boolean).join(' — ') };
  if (depth >= maxDepth) {
    const c = countAll(node);
    if (c.headings) out.subsection_count = c.headings;
    if (c.provisions || node.provisions.length) out.provision_count = c.provisions;
    return out;
  }
  if (node.children.length) out.sections = node.children.map((c) => pruneNode(c, depth + 1, maxDepth, provisionLimit));
  if (node.provisions.length) {
    out.provisions = node.provisions.slice(0, provisionLimit).map((p) => p.enbez);
    if (node.provisions.length > provisionLimit) {
      out.provisions_truncated = node.provisions.length - provisionLimit;
      out.has_more_provisions = true;
    }
  }
  return out;
}

async function gesetzeStructure(args: Record<string, unknown>) {
  const m = resolveLaw(args.law);
  if (!m.ok) return lawMiss(args.law, m);
  const parsed = await loadLaw(m.slug);
  const { roots, rootProvisions } = buildTree(parsed.norms);
  const depth = Math.min(8, Math.max(1, Number(args.depth) || 2));
  const provisionLimit = Math.min(400, Math.max(10, Number(args.provision_limit) || 100));
  const sectionId = String(args.section_id ?? '').trim();

  let scopeRoots = roots;
  let scopeProvisions = rootProvisions;
  let within: { section_id: string; heading: string | null } | null = null;

  if (sectionId) {
    const node = findNode(roots, sectionId);
    if (!node) {
      return {
        found: false,
        reason: 'section_not_found',
        ...lawHeader(m.slug, m.title, parsed),
        section_id: sectionId,
        message: `No structural section "${sectionId}" in ${parsed.front.jurabk ?? m.title}.`,
        hint: 'Call gesetze_structure without section_id to list the top-level sections and their ids.',
      };
    }
    scopeRoots = node.children;
    scopeProvisions = node.provisions;
    within = { section_id: node.kennzahl, heading: [node.bez, node.titel].filter(Boolean).join(' — ') || null };
  }

  if (!scopeRoots.length && !scopeProvisions.length) {
    throw new Error(`de-gesetze: the parsed structure for "${m.slug}"${sectionId ? ` / ${sectionId}` : ''} is empty — the law package is non-empty but no headings or provisions were extracted, which points at a parser gap, not an empty law.`);
  }

  return {
    found: true,
    ...lawHeader(m.slug, m.title, parsed),
    ...(within ? { section: within } : {}),
    depth,
    sections: scopeRoots.map((r) => pruneNode(r, 1, depth, provisionLimit)),
    ...(scopeProvisions.length
      ? {
          provisions: scopeProvisions.slice(0, provisionLimit).map((p) => p.enbez),
          ...(scopeProvisions.length > provisionLimit
            ? { provisions_truncated: scopeProvisions.length - provisionLimit, has_more_provisions: true }
            : {}),
        }
      : {}),
    hint: 'Pass a section_id from "sections" above (with depth) to expand one branch; gesetze_provision returns a single §/Art. in full.',
  };
}

// ── gesetze_provision ─────────────────────────────────────────────────────

async function gesetzeProvision(args: Record<string, unknown>) {
  const m = resolveLaw(args.law);
  if (!m.ok) return lawMiss(args.law, m);
  const citation = String(args.provision ?? '').trim();
  if (!citation) {
    return {
      found: false,
      reason: 'empty_provision',
      ...lawHeader(m.slug, m.title, await loadLaw(m.slug)),
      message: 'Pass `provision` — a section/article number as cited, e.g. "823", "§ 823", "823a", "Art 1".',
    };
  }
  const parsed = await loadLaw(m.slug);
  const token = citationToken(citation);
  const provisions = parsed.norms.filter((n) => n.enbez && !n.gliederung);

  const exact = provisions.find((n) => enbezToken(n.enbez) === token);
  if (!exact) {
    const near = provisions
      .filter((n) => {
        const t = enbezToken(n.enbez);
        return t != null && (t.startsWith(token.replace(/[a-z]+$/, '')) || token.startsWith(t.replace(/[a-z]+$/, '')));
      })
      .slice(0, 8)
      .map((n) => ({ citation: n.enbez, title: n.titel }));
    return {
      found: false,
      reason: 'provision_not_found',
      ...lawHeader(m.slug, m.title, parsed),
      provision: citation,
      message: `No provision "${citation}" in ${parsed.front.jurabk ?? m.title}.`,
      near,
      hint: near.length ? 'Nearby citations are listed in "near".' : 'Call gesetze_structure to list this law\'s provisions.',
    };
  }

  const amendmentNote = exact.footnote
    ? 'This provision\'s own footnote (amendment/application notes) is in `footnote`.'
    : 'No amendment or application footnote is attached to this specific provision; the law\'s overall amendment status is in `amendment_status` above.';

  return {
    found: true,
    ...lawHeader(m.slug, m.title, parsed),
    provision: {
      citation: exact.enbez,
      title: exact.titel,
      text: exact.text,
      text_chars: exact.text?.length ?? 0,
      footnote: exact.footnote,
    },
    amendment_note: amendmentNote,
  };
}

// ── tool defs ─────────────────────────────────────────────────────────────

const LAW_ARG = {
  type: 'string',
  description: 'The law or ordinance: its official abbreviation ("BGB", "StGB", "HGB", "BDSG", "GG", "ZPO", "EStG") or (if unambiguous) its official title ("Bürgerliches Gesetzbuch"). Call gesetze_search first if unsure.',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'gesetze_search',
    description:
      'Search German federal statutes and ordinances (Gesetze im Internet, BMJ/juris) BY TITLE OR ABBREVIATION — "BGB", "StGB", "Datenschutz", "Straßenverkehr". An exact or near abbreviation match (BGB, StGB, HGB, BDSG, GG…) returns that one law directly; otherwise ranks law titles by word overlap. Returns each match\'s abbreviation and official title. Use for "what is the abbreviation for the German Civil Code" or "find the German data protection act". Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'An abbreviation ("BGB") or title keywords ("Datenschutz", "Straßenverkehr").' },
        limit: { type: 'number', description: 'Max results, default 10, max 25 (ignored on an exact abbreviation match).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gesetze_law_info',
    description:
      'Amendment metadata ("Stand") for a German federal law or ordinance: official abbreviation and title, date of promulgation (Ausfertigungsdatum), official publication citation (Fundstelle), the official amendment-status entries (Neufassung/Stand — the act and date that produced the current consolidated text), and the entry-into-force date when Gesetze im Internet publishes one. Use for "what is the current Stand of the BGB" or "when was the current BDSG enacted". Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: { law: LAW_ARG },
      required: ['law'],
    },
  },
  {
    name: 'gesetze_structure',
    description:
      'Table of contents of a German federal law or ordinance (Bücher/Abschnitte/Titel/Kapitel) with the §/Art. provisions listed under each heading, from Gesetze im Internet. `depth` controls how many heading levels come back; pass a `section_id` from a previous answer to expand one branch. A branch with more provisions than `provision_limit` says so (`has_more_provisions`) rather than truncating silently. Use to browse a law\'s structure or list the provisions of one chapter.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        law: LAW_ARG,
        section_id: { type: 'string', description: 'Optional structural-heading id (Gliederungskennzahl) from a previous gesetze_structure answer, to expand one branch.' },
        depth: { type: 'number', description: 'Heading levels to return below the starting point, 1-8 (default 2).' },
        provision_limit: { type: 'number', description: 'Max provisions listed per heading before has_more_provisions, 10-400 (default 100).' },
      },
      required: ['law'],
    },
  },
  {
    name: 'gesetze_provision',
    description:
      'Full text of a single § (Paragraph) or Art. (Artikel) of a German federal law or ordinance, by abbreviation and provision number, from Gesetze im Internet. Accepts natural forms: "823", "§ 823", "823a", "Art 1", "Art. 1". Returns the provision\'s title, full original-language (German) text, and its own footnote (amendment/application note) when the source attaches one. Use for "what does § 823 BGB say" or "Art 1 GG". Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        law: LAW_ARG,
        provision: { type: 'string', description: 'Section/article number as cited: "823", "§ 823", "823a", "Art 1", "Art. 20a".' },
      },
      required: ['law', 'provision'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'gesetze_search':
      return gesetzeSearch(args);
    case 'gesetze_law_info':
      return gesetzeLawInfo(args);
    case 'gesetze_structure':
      return gesetzeStructure(args);
    case 'gesetze_provision':
      return gesetzeProvision(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

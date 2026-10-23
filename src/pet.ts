/**
 * The desktop pet as the presentation channel.
 *
 * The pet is an independent plugin with its own character; this module only hands
 * it a sentence to say. That division is deliberate: the memory store knows WHAT
 * is worth saying and WHY (it has the evidence), the pet owns HOW it sounds. A
 * memory plugin that tried to be the personality would be writing prose it has no
 * business writing, in a voice nobody configured.
 *
 * The pet's HTTP surface lives under the DSH web server, so it requires the same
 * authenticated URL the harness hands to itself. A bare loopback request returns
 * 403 — measured on this machine — and that is the reason this module takes the
 * authenticated origin rather than building one.
 *
 * @module dsh-memories/pet
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where one pet is reachable. */
export interface PetTarget {
  /** Clean origin, e.g. `http://127.0.0.1:43120`; no path, no query. */
  readonly origin: string
  /**
   * Process launch token, when the host requires one.
   *
   * `connection.authenticatedUrl()` appends it as a QUERY parameter, so its result
   * cannot be used as a path prefix: appending a path puts it inside the token
   * value (`...?token=abc/dsh-pet-7340/broadcast`) and the request is rejected.
   * The token therefore travels separately, on the request's own query string.
   */
  readonly token?: string
  /**
   * The Desktop renderer capability header, when the host has one.
   *
   * This is the ONLY credential the desktop loopback accepts: a request reaches
   * the host routes when it carries `x-dsh-desktop-renderer: <43 base64url>` (the
   * renderer's own session adds it) or when the user has enabled ordinary browser
   * access. A plain loopback fetch is rejected with 403 — measured — and the
   * `connection.authenticatedUrl` token is unrelated (it mints a web-app cookie,
   * it does not open this gate). The value is read from the host's own
   * `desktopBrowserAccess` service, which is what the gate itself consults.
   */
  readonly rendererHeader?: { readonly name: string; readonly value: string }
  /** Pet id the pet's own config declares, e.g. `main`. */
  readonly petId: string
  /** Route id baked into the pet's registered prefix (`/dsh-pet-<routeId>`). */
  readonly routeId: string
}

/** What the pet's broadcast endpoint accepts. */
export interface Bubble {
  /** What to say; the pet shows it verbatim. */
  readonly text: string
  /** How long to keep the bubble up, in ms. */
  readonly duration: number
}

/** Result of one delivery attempt. */
export interface DeliveryResult {
  readonly ok: boolean
  /** Why it failed, for the log. */
  readonly reason?: string
}

/**
 * Read the pet's own config to learn its id.
 *
 * The pet writes JSON-with-comments at `<dshHome>/dsh-pet/main-config.jsonc`; the
 * id is the only field needed and the file is small, so a strict JSON parse after
 * stripping comments is enough. A missing or unreadable file is not an error:
 * every caller treats "no pet" as "no channel", not as a failure.
 *
 * @param dshHome - harness home; defaults to `~/.dsh`.
 * @returns the first pet's id, or `undefined`.
 */
export function readPetId(dshHome = join(homedir(), '.dsh')): string | undefined {
  const path = join(dshHome, 'dsh-pet', 'main-config.jsonc')
  if (!existsSync(path)) return undefined
  try {
    const raw = readFileSync(path, 'utf8')
    const stripped = raw.replace(/^\s*\/\/.*$/gmu, '').replace(/\/\*[\s\S]*?\*\//gu, '')
    const parsed = JSON.parse(stripped) as { pets?: { id?: unknown }[] }
    const first = parsed.pets?.find((pet) => typeof pet.id === 'string' && pet.id.length > 0)
    return typeof first?.id === 'string' ? first.id : undefined
  } catch {
    return undefined
  }
}

/**
 * Show one bubble in the pet.
 *
 * Never throws: a notification channel that can break a background pass is worse
 * than a missed notification, and the caller needs a boolean to decide whether to
 * retry on the next tick or fall back to the operating system.
 *
 * @param target - where the pet is.
 * @param bubble - what to say and for how long.
 * @param fetchImpl - injectable fetch, for tests.
 * @returns whether the pet accepted it.
 */
export async function say(
  target: PetTarget,
  bubble: Bubble,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult> {
  // The path is built on the clean origin and the token is set afterwards: the
  // host appends its token as a QUERY parameter, so a path concatenated onto the
  // authenticated URL ends up inside the token value and the request is rejected.
  const url = new URL(`/dsh-pet-${target.routeId}/broadcast`, target.origin)
  url.searchParams.set('pet', target.petId)
  if (target.token !== undefined && target.token.length > 0) url.searchParams.set('token', target.token)
  try {
    const response = await fetchImpl(url.href, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: target.origin,
        ...target.rendererHeader === undefined ? {} : { [target.rendererHeader.name]: target.rendererHeader.value },
      },
      body: JSON.stringify({ text: bubble.text, duration: bubble.duration }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { ok: false, reason: `pet responded ${response.status}${detail.trim().length > 0 ? ': ' + detail.trim().slice(0, 80) : ''}` }
    }
    const payload = (await response.json().catch(() => ({}))) as { ok?: unknown; reason?: unknown; message?: unknown }
    if (payload.ok === false) {
      return { ok: false, reason: `pet refused: ${String(payload.reason ?? payload.message ?? 'unknown')}` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * macOS fallback when the pet is not there.
 *
 * Deliberately the quiet kind of notification (no sound, no focus steal): the
 * point is that a notice is not lost, not that it interrupts.
 *
 * @param title - notification title.
 * @param message - notification body.
 * @returns whether `osascript` accepted it.
 */
export function systemNotification(title: string, message: string): boolean {
  const script = `display notification "${message.replace(/["\\]/gu, '')}" with title "${title.replace(/["\\]/gu, '')}"`
  try {
    const { spawnSync } = process.getBuiltinModule?.('node:child_process') as typeof import('node:child_process') | undefined
      ?? require('node:child_process') as typeof import('node:child_process')
    const result = spawnSync('osascript', ['-e', script], { timeout: 3_000 })
    return result.status === 0
  } catch {
    return false
  }
}
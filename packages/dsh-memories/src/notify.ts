/**
 * The delivery channel: one operating-system notification.
 *
 * This plugin used to hand its notices to a desktop pet plugin over the host's
 * loopback HTTP. That dependency was removed on 2026-10-28 together with the pet:
 * a notice is only worth having if it arrives without a second plugin being
 * installed, configured, authenticated, and displayed. One channel that always
 * exists beats two where one silently fails.
 *
 * @module dsh-memories/notify
 */
import { spawnSync } from 'node:child_process'

/**
 * Post a macOS notification.
 *
 * Deliberately the quiet kind: no sound, no focus steal. The point is that a
 * notice is not lost, not that it interrupts. Never throws — a notification
 * channel that can break a background pass is worse than a missed notice.
 *
 * @param title - notification title.
 * @param message - notification body.
 * @returns whether `osascript` accepted it.
 */
export function systemNotification(title: string, message: string): boolean {
  const script = `display notification "${message.replace(/["\\]/gu, '')}" with title "${title.replace(/["\\]/gu, '')}"`
  try {
    const result = spawnSync('osascript', ['-e', script], { timeout: 3_000 })
    return result.status === 0
  } catch {
    return false
  }
}

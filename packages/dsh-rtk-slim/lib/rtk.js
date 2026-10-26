/**
 * rtk invocation. Owns every way the child can misbehave: missing binary,
 * non-zero exit, timeout, caller cancellation, runaway output. Every failure is
 * a value, never a throw — the caller keeps the original text.
 *
 * @module dsh-rtk-slim/rtk
 */

import { spawn } from 'node:child_process'

/** @typedef {{ ok: true, text: string } | { ok: false, reason: 'spawn' | 'exit' | 'timeout' | 'aborted' | 'too-large' }} RunResult */

/**
 * @param {object} input
 * @param {string} input.command
 * @param {string[]} input.args
 * @param {string} input.input stdin payload
 * @param {number} input.timeoutMs
 * @param {AbortSignal} [input.signal]
 * @param {number} input.maxOutputBytes
 * @returns {Promise<RunResult>}
 */
export function runRtk({ command, args, input, timeoutMs, signal, maxOutputBytes }) {
  return new Promise((resolve) => {
    if (signal !== undefined && signal.aborted) {
      resolve({ ok: false, reason: 'aborted' })
      return
    }
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      // `detached` gives the child its own process group so a runaway rtk and
      // its descendants can be killed as a unit.
      child = spawn(command, args, { detached: true, stdio: ['pipe', 'pipe', 'ignore'], signal })
    } catch {
      resolve({ ok: false, reason: 'spawn' })
      return
    }

    let settled = false
    let bytes = 0
    /** @type {Buffer[]} */
    const chunks = []

    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }, true), timeoutMs)
    const onAbort = () => finish({ ok: false, reason: 'aborted' }, true)

    function cleanup() {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }

    function killGroup() {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }

    /**
     * @param {RunResult} result
     * @param {boolean} [kill]
     */
    function finish(result, kill) {
      if (settled) return
      settled = true
      cleanup()
      if (kill === true) killGroup()
      resolve(result)
    }

    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', () => {
      finish({ ok: false, reason: signal !== undefined && signal.aborted ? 'aborted' : 'spawn' })
    })

    child.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
      bytes += chunk.length
      if (bytes > maxOutputBytes) {
        finish({ ok: false, reason: 'too-large' }, true)
        return
      }
      chunks.push(chunk)
    })

    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, reason: 'exit' })
        return
      }
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') })
    })

    child.stdin?.on('error', () => {
      // EPIPE when the child is already gone; the close/error handler decides.
    })
    child.stdin?.end(input)
  })
}

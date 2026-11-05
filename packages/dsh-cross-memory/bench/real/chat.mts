/**
 * Provider call for the real-session harness.
 *
 * Same two providers as `../e2e/run.mts` (local ollama, or the DeepSeek API in
 * the off-peak window). Kept beside the harness rather than shared so the e2e
 * script stays untouched; change both if the provider contract changes.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'

/**
 * Create a chat function plus a running usage tally.
 *
 * @param {object} [options]
 * @param {'ollama'|'deepseek'} [options.provider]
 * @param {string} [options.model]
 * @param {string} [options.keyFile] - defaults to the DSH credentials file.
 * @param {string} [options.ollamaHost]
 * @returns {{chat: Function, usage: {input: number, output: number, calls: number}, provider: string, model: string}}
 */
export function createChat(options = {}) {
  const provider = options.provider ?? 'ollama'
  const model = options.model ?? (provider === 'deepseek' ? 'deepseek-chat' : 'qwen3.5:latest')
  const ollamaHost = options.ollamaHost ?? process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434'
  const keyFile = options.keyFile ?? join(homedir(), '.dsh', '.credentials.yaml')
  const usage = { input: 0, output: 0, calls: 0 }

  /** Read the DeepSeek key without echoing it: env first, then the DSH credentials file. */
  async function apiKey() {
    const fromEnv = process.env['DEEPSEEK_API_KEY']
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
    const text = await readFile(keyFile, 'utf8')
    const match = /^\s+DEEPSEEK_API_KEY:\s*(\S+)\s*$/mu.exec(text)
    if (match === null) throw new Error('no DeepSeek API key: set DEEPSEEK_API_KEY or pass --key-file')
    return match[1]
  }

  /** One chat turn, with one retry on a transport error. */
  async function chat(messages, { json = false, numPredict = 500 } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (provider === 'deepseek') {
          const response = await fetch(DEEPSEEK_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${await apiKey()}` },
            body: JSON.stringify({
              model,
              messages,
              temperature: 0,
              max_tokens: numPredict,
              ...json ? { response_format: { type: 'json_object' } } : {},
            }),
          })
          if (!response.ok) throw new Error(`deepseek HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
          const value = await response.json()
          usage.calls += 1
          usage.input += value.usage?.prompt_tokens ?? 0
          usage.output += value.usage?.completion_tokens ?? 0
          return value.choices?.[0]?.message?.content ?? ''
        }
        const response = await fetch(`${ollamaHost}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages,
            stream: false,
            ...json ? { format: 'json' } : {},
            think: false,
            options: { temperature: 0, num_predict: numPredict },
          }),
        })
        if (!response.ok) throw new Error(`ollama HTTP ${response.status}`)
        const value = await response.json()
        usage.calls += 1
        return value.message?.content ?? ''
      } catch (error) {
        if (attempt === 1) throw error
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    }
    return ''
  }

  return { chat, usage, provider, model }
}

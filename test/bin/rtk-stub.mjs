#!/usr/bin/env node
// Fault-injectable rtk stand-in. Invoked as `node <this file>` with
// RTK_STUB_MODE set; reads all of stdin, then behaves per mode.
const mode = process.env.RTK_STUB_MODE ?? 'ok'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
})
process.stdin.on('end', () => {
  switch (mode) {
    case 'ok':
      process.stdout.write(`CONDENSED ${Buffer.byteLength(input, 'utf8')}`)
      break
    case 'exit':
      process.exit(3)
      break
    case 'empty':
      process.stdout.write('')
      break
    case 'hang':
      setInterval(() => {}, 1000)
      break
    case 'big': {
      const chunk = 'y'.repeat(64 * 1024)
      for (let i = 0; i < 40; i += 1) process.stdout.write(chunk)
      break
    }
    default:
      process.stderr.write(`unknown RTK_STUB_MODE ${mode}\n`)
      process.exit(64)
  }
})

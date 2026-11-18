import { rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMailbox, ensureWorkspaceBox } from '../lib/mail.js'

const tmp = join(process.cwd(), '_tmp', 'group-race')
await rm(tmp, { recursive: true, force: true })
await ensureWorkspaceBox(tmp)
const box = createMailbox({ ackTimeoutMs: 600000, service: () => undefined, log: () => {}, cwdOf: async () => tmp })

for (let i = 0; i < 200; i += 1) {
  await rm(join(tmp, '.dsh-mail', 'group.json'), { force: true })
  const a = await box.groupCreate({ memberA: 'D1', memberB: 'E1', cwd: tmp })
  const b = await box.groupCreate({ members: ['F1', 'G1', 'H1'], cwd: tmp })
  if (a.group.id === b.group.id) {
    console.log('COLLISION at', i, a.group.id, b.group.id)
    process.exit(1)
  }
  if (i % 50 === 0) console.log('ok', i, a.group.id, b.group.id)
}
console.log('no collision in 200')
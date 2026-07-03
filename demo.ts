/**
 * NutriBase live demo — terminal runner.
 *
 * Drives real headed browsers (one per role instance) through
 * demo-script.md in order, one beat at a time. After each beat's actions
 * finish, it prints the talking point and waits for you to press Enter
 * before running the next beat.
 *
 * Setup:
 *   npm install
 *   npm run install-browser   (first time only, downloads Chromium)
 *
 * Run (make sure the app is up: composer run dev / pnpm run dev):
 *   npm run demo
 *   DRY_RUN=1 npm run demo     (skip steps that mutate data / cost an API call)
 *
 * For a clickable web control panel instead of terminal Enter-presses, see
 * `npm run panel` (server.ts).
 */

import { chromium, type Browser, type Page } from 'playwright'
import { createInterface } from 'node:readline/promises'
import { buildSteps, emptyState, tagInstanceWindow, type DemoState, type InstanceId } from './steps.ts'

const rl = createInterface({ input: process.stdin, output: process.stdout })

async function main() {
  const browsers = new Map<InstanceId, { browser: Browser; page: Page; state: DemoState }>()

  async function instanceFor(id: InstanceId) {
    let inst = browsers.get(id)
    if (!inst) {
      const browser = await chromium.launch({ headless: false, slowMo: 150, args: ['--start-maximized'] })
      const context = await browser.newContext({ viewport: null })
      const page = await context.newPage()
      await tagInstanceWindow(page, id)
      inst = { browser, page, state: emptyState() }
      browsers.set(id, inst)
    }
    return inst
  }

  for (const step of buildSteps()) {
    console.log(`\n\x1b[36m${'─'.repeat(70)}\x1b[0m`)
    console.log(`\x1b[1m[${step.instance}] ${step.segment} · ${step.title}\x1b[0m`)
    try {
      const inst = await instanceFor(step.instance)
      // Terminal mode already pauses between whole steps on Enter, so act() runs straight through.
      const patch = await step.run({ page: inst.page, state: inst.state, act: (_label, fn) => fn() })
      if (patch) Object.assign(inst.state, patch)
    } catch (err) {
      console.log(`\x1b[33m  ! step action failed, continue manually if needed: ${(err as Error).message.split('\n')[0]}\x1b[0m`)
    }
    if (step.say) console.log(`\n💬 "${step.say}"`)
    await rl.question('\n[Enter] → next step... ')
  }

  await rl.question('\nDemo complete. Press Enter to close all browsers...')
  for (const inst of browsers.values()) await inst.browser.close()
  rl.close()
}

main().catch(err => {
  console.error(err)
  rl.close()
  process.exit(1)
})

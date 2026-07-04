/**
 * Shared step definitions for the NutriBase demo, driven by either:
 *  - demo.ts   (terminal script, runs steps in order, Enter to advance)
 *  - server.ts (web control panel, steps triggered independently by button click)
 *
 * Each step is tied to one role instance (admin / doctor / patient) — a
 * separate persistent browser, since each role needs its own login session.
 */

import type { Page } from 'playwright'

export let BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'
export const DRY_RUN = process.env.DRY_RUN === '1'

/**
 * Lets the web panel repoint the demo at a different environment (e.g. a
 * Railway-hosted deploy) without restarting the process. steps.ts is the
 * only writer; server.ts/demo.ts read the live BASE_URL binding via the
 * ES module live-binding semantics, so every step call picks up the change
 * immediately — no need to thread the URL through StepContext.
 */
export function setBaseUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/.+/.test(trimmed)) {
    throw new Error('Base URL must start with http:// or https://')
  }
  BASE_URL = trimmed
}

/** Reads a required demo-account credential from the environment — see .env.example. */
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing ${name} — copy .env.example to .env and fill in the demo account credentials.`)
  }
  return value
}

export const CREDS = {
  admin: { email: requireEnv('ADMIN_EMAIL'), password: requireEnv('ADMIN_PASSWORD') },
  doctor: { email: requireEnv('DOCTOR_EMAIL'), password: requireEnv('DOCTOR_PASSWORD') }
}

/**
 * The demo creates this patient live (Doctor — Add New Patient step) and logs in as them
 * later in the Patient segment — not a pre-seeded fixture, so unlike CREDS above it's a
 * plain constant rather than an env var. Fatima is no longer usable for the closing
 * Patient-view segment because she gets suspended earlier in the same run (Admin segment).
 */
export const NEW_PATIENT = {
  fullName: 'Test Patient',
  email: 'amar.hajrovic@stu.ibu.edu.ba',
  password: 'password',
  firstName: 'Test',
  lastName: 'Patient',
  dateOfBirth: '2001-05-14',
  phone: '+38762000000',
  emergencyContactName: 'Emergency Contact',
  emergencyContactPhone: '+38762000001'
}

export type InstanceId = 'admin' | 'doctor' | 'patient'
export const INSTANCE_IDS: InstanceId[] = ['admin', 'doctor', 'patient']

export const INSTANCE_COLORS: Record<InstanceId, string> = {
  admin: '#e53935',
  doctor: '#1e88e5',
  patient: '#43a047'
}

/**
 * Injects a colored frame + corner badge + narration caption into every
 * document loaded in this page, so the three role windows are visually
 * distinguishable at a glance (and on recordings), and the step's "say"
 * line can be burned into the recording right beside the role badge.
 * Survives Next.js client-side route changes because it's appended to
 * <html> directly, outside React's root — only re-runs the MutationObserver
 * safety net if something actually removes it.
 *
 * The caption is driven from Node via `window.__setDemoCaption(text)`,
 * called through page.evaluate (see setPageCaption below) whenever a step
 * with a `say` line starts — it's just an empty, hidden bubble until then.
 */
export async function tagInstanceWindow(page: Page, id: InstanceId): Promise<void> {
  // Passed as a raw script STRING, not a function — page.addInitScript would otherwise
  // serialize a function via .toString(), which under tsx/esbuild's keepNames transform
  // can embed a `__name(...)` helper call that only exists in the Node runtime, not the
  // browser, causing a silent pageerror before the frame/badge ever gets created.
  const role = JSON.stringify(id.toUpperCase())
  const color = JSON.stringify(INSTANCE_COLORS[id])
  const script = `(function () {
    var ROLE = ${role};
    var COLOR = ${color};
    function install() {
      if (document.getElementById('__demo_role_frame__')) return;
      var frame = document.createElement('div');
      frame.id = '__demo_role_frame__';
      frame.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;box-shadow:inset 0 0 0 6px ' + COLOR + ';';
      document.documentElement.appendChild(frame);

      var dock = document.createElement('div');
      dock.id = '__demo_role_dock__';
      dock.style.cssText = 'position:fixed;left:0;right:0;bottom:10px;padding:0 16px;pointer-events:none;z-index:2147483647;display:flex;align-items:flex-end;gap:12px;';
      document.documentElement.appendChild(dock);

      var caption = document.createElement('div');
      caption.id = '__demo_caption__';
      caption.style.cssText = 'display:none;flex:1 1 auto;min-width:0;background:rgba(15,18,24,.92);color:#f2f4f8;font:600 19px/1.45 system-ui,sans-serif;padding:12px 20px;border-radius:8px;border-left:5px solid ' + COLOR + ';box-shadow:0 2px 10px rgba(0,0,0,.45);';
      dock.appendChild(caption);

      var badge = document.createElement('div');
      badge.id = '__demo_role_badge__';
      badge.textContent = ROLE;
      badge.style.cssText = 'flex:none;background:' + COLOR + ';color:#fff;font:700 12px system-ui,sans-serif;padding:5px 12px;border-radius:6px;letter-spacing:.06em;box-shadow:0 2px 8px rgba(0,0,0,.4);';
      dock.appendChild(badge);

      window.__setDemoCaption = function (text) {
        var el = document.getElementById('__demo_caption__');
        if (!el) return;
        if (text) {
          el.textContent = text;
          el.style.display = 'block';
        } else {
          el.textContent = '';
          el.style.display = 'none';
        }
      };
    }
    function start() {
      install();
      new MutationObserver(function () {
        if (!document.getElementById('__demo_role_frame__')) install();
      }).observe(document.documentElement, { childList: true });
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  })();`
  await page.addInitScript(script)
}

/** Sets (or clears, if text is falsy) the on-page narration caption installed by tagInstanceWindow. */
export async function setPageCaption(page: Page, text: string | null | undefined): Promise<void> {
  await page.evaluate(t => {
    const w = window as unknown as { __setDemoCaption?: (text: string | null) => void }
    w.__setDemoCaption?.(t ?? null)
  }, text ?? null).catch(() => {})
}

/**
 * Injects a fake cursor + element-highlight overlay into every document
 * loaded in this page. Playwright drives clicks/fills via CDP rather than a
 * real OS cursor, so nothing is visible on screen for an action by default —
 * this layer makes the target of each action visible on the recording/panel
 * by riding real DOM events the actions already trigger:
 *  - 'mousemove' (Playwright dispatches a real one as part of every click)
 *    moves a fixed-position cursor glyph to the pointer's last position.
 *  - 'click' and 'focusin' (covers fills, which focus their input before
 *    typing) flash a highlight ring around whatever element fired them.
 * Pure page-side DOM listening — no dependency on Playwright's internals —
 * so it works uniformly for every action type without touching step code.
 */
export async function installVisualCues(page: Page): Promise<void> {
  const script = `(function () {
    function install() {
      if (document.getElementById('__demo_cursor__')) return;
      var cursor = document.createElement('div');
      cursor.id = '__demo_cursor__';
      cursor.style.cssText = 'position:fixed;top:0;left:0;width:18px;height:18px;'
        + 'border-radius:50% 50% 50% 0;background:rgba(255,205,0,.95);border:2px solid #7a5a00;'
        + 'transform:translate(-4px,-4px) rotate(45deg);pointer-events:none;z-index:2147483647;'
        + 'display:none;transition:top .12s ease-out,left .12s ease-out;box-shadow:0 0 6px rgba(0,0,0,.5);';
      document.documentElement.appendChild(cursor);

      document.addEventListener('mousemove', function (e) {
        cursor.style.display = 'block';
        cursor.style.left = e.clientX + 'px';
        cursor.style.top = e.clientY + 'px';
      }, true);

      var ring = null;
      function highlight(el) {
        if (!el || !el.getBoundingClientRect) return;
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        if (!ring) {
          ring = document.createElement('div');
          ring.id = '__demo_highlight__';
          ring.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;'
            + 'border:3px solid #ffcf00;border-radius:6px;box-shadow:0 0 0 4px rgba(255,207,0,.35);'
            + 'transition:opacity .15s ease-out;opacity:0;';
          document.documentElement.appendChild(ring);
        }
        ring.style.left = (rect.left - 4) + 'px';
        ring.style.top = (rect.top - 4) + 'px';
        ring.style.width = (rect.width + 8) + 'px';
        ring.style.height = (rect.height + 8) + 'px';
        ring.style.opacity = '1';
        clearTimeout(ring._hideTimer);
        ring._hideTimer = setTimeout(function () { ring.style.opacity = '0'; }, 500);
      }
      document.addEventListener('click', function (e) { highlight(e.target); }, true);
      document.addEventListener('focusin', function (e) { highlight(e.target); }, true);
    }
    function start() {
      install();
      new MutationObserver(function () {
        if (!document.getElementById('__demo_cursor__')) install();
      }).observe(document.documentElement, { childList: true });
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  })();`
  await page.addInitScript(script)
}

export interface DemoState {
  testPatientUrl: string
  stefanUrl: string
}

export function emptyState(): DemoState {
  return { testPatientUrl: '', stefanUrl: '' }
}

export interface StepContext {
  page: Page
  /** Read-only snapshot of this instance's state at the moment the step started. */
  state: Readonly<DemoState>
  /**
   * Runs one atomic, narratable action. In the web panel, when step-through is
   * armed on this instance, execution blocks after the action completes until
   * the presenter clicks Continue — and re-arms for the next act() call, so
   * staying armed stops you at every action in sequence, not just the first.
   */
  act: <T>(label: string, fn: () => Promise<T>) => Promise<T>
}

export interface StepDef {
  id: string
  instance: InstanceId
  segment: string
  title: string
  say?: string
  /** Human-readable prerequisite note, shown in the panel — not enforced. */
  requires?: string
  /**
   * Returns a partial state patch to merge in ONLY if the step completes
   * successfully (atomic commit — a mid-step failure leaves state untouched).
   */
  run: (ctx: StepContext) => Promise<Partial<DemoState> | void>
}

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/login`)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Login' }).click()
  await page.waitForURL('**/dashboard/home')
}

function requireUrl(url: string, label: string): string {
  if (!url) {
    throw new Error(`${label} not captured yet — run that patient's list/lookup step first.`)
  }
  return url
}

/** One create-visit-then-record-vitals encounter, reused for each of the new patient's 4 visits. */
async function addVisitWithVitals(
  page: Page,
  act: StepContext['act'],
  datetime: string,
  notes: string,
  vitals: { weight: string; height: string; systolic: string; diastolic: string; heartRate: string; temperature: string }
) {
  await act('Open Add Visit dialog', () => page.getByRole('button', { name: 'Add Visit' }).click())
  const dialog = page.getByRole('dialog')
  await act('Fill visit date', () => dialog.getByLabel('Date & Time').fill(datetime))
  await act('Fill visit notes', () => dialog.getByLabel('Notes').fill(notes))
  await act('Create visit', () => dialog.getByRole('button', { name: 'Create Visit' }).click())

  await act('Open new visit', async () => {
    await page.getByRole('link', { name: 'View' }).first().click() // just-created visit sorts to the top
    await page.waitForURL('**/dashboard/visits/**')
  })

  await act('Open vitals dialog', () => page.getByRole('button', { name: 'Record vital signs' }).click())
  const vDialog = page.getByRole('dialog')
  await act('Fill vitals', async () => {
    await vDialog.getByLabel('Weight (kg)').fill(vitals.weight)
    await vDialog.getByLabel('Height (cm)').fill(vitals.height)
    await vDialog.getByLabel('Systolic BP (mmHg)').fill(vitals.systolic)
    await vDialog.getByLabel('Diastolic BP (mmHg)').fill(vitals.diastolic)
    await vDialog.getByLabel('Heart Rate (bpm)').fill(vitals.heartRate)
    await vDialog.getByLabel('Temperature (°C)').fill(vitals.temperature)
  })
  await act('Record vitals', () => vDialog.getByRole('button', { name: 'Record' }).click())
}

export function buildSteps(): StepDef[] {
  return [
    // ── ADMIN instance ────────────────────────────────────────────────
    {
      id: 'login-admin',
      instance: 'admin',
      segment: 'SEGMENT 1 · Admin',
      title: 'Step 1 — Login as Admin',
      say: 'Each role sees a different entry point on login. The admin lands on a system overview dashboard showing total registered users and patients.',
      run: async ({ page, act }) => act('Log in as Admin', () => login(page, CREDS.admin.email, CREDS.admin.password))
    },
    {
      id: 'admin-dashboard',
      instance: 'admin',
      segment: 'SEGMENT 1 · Admin',
      title: 'Step 2 — Admin Dashboard',
      say: 'Point out the stat cards and the three quick-action cards: Manage Users, Manage Patients, All Visits.',
      requires: 'Logged in as Admin (Step 1).',
      run: async () => {}
    },
    {
      id: 'admin-user-list',
      instance: 'admin',
      segment: 'SEGMENT 1 · Admin',
      title: 'Step 3 — User List',
      say: 'Admin accounts, doctors, and patients are all rows in the same Users table, distinguished only by role.',
      requires: 'Logged in as Admin (Step 1).',
      run: async ({ page, act }) => {
        await act('Open Manage Users', async () => {
          await page.getByRole('link', { name: /Manage Users/ }).click()
          await page.waitForURL('**/dashboard/users')
        })
        const search = page.getByPlaceholder('Search by name or email')
        await act('Search for "amina"', () => search.fill('amina'))
        await act('Clear search', async () => {
          await page.waitForTimeout(600)
          await search.fill('')
        })
      }
    },
    {
      id: 'admin-add-user-duplicate',
      instance: 'admin',
      segment: 'SEGMENT 1 · Admin',
      title: 'Step 4 — Add User with a duplicate email → validation error',
      say: "Email uniqueness is enforced server-side, not just in the UI. Reusing the doctor's email surfaces Laravel's validation error right under the field.",
      requires: 'On the Users list (Step 3).',
      run: async ({ page, act }) => {
        await act('Open Add New User dialog', () => page.getByRole('button', { name: 'Add New User' }).click())
        const dialog = page.getByRole('dialog')
        await act('Fill Name', () => dialog.getByLabel('Name').fill('Dr. Haris Mujanović'))
        await act('Fill Email (already taken)', () => dialog.getByLabel('Email').fill(CREDS.doctor.email))

        await act('Open Role dropdown', async () => {
          await dialog.getByLabel('Role').click()
          await page.getByRole('listbox').waitFor({ state: 'visible' })
        })
        await act('Select Doktor role', () => page.getByRole('option', { name: 'Doktor', exact: true }).click())
        await act('Fill password', () => dialog.getByLabel('Password', { exact: true }).fill('password'))
        await act('Fill confirm password', () => dialog.getByLabel('Confirm Password').fill('password'))

        await act('Submit — expect duplicate-email error', async () => {
          await dialog.getByRole('button', { name: 'Create User' }).click()
          await dialog.getByText(/already been taken/i).waitFor({ timeout: 10_000 }).catch(() => {})
        })
        await act('Cancel dialog', () => dialog.getByRole('button', { name: 'Cancel' }).click())
      }
    },
    {
      id: 'admin-suspend-patient',
      instance: 'admin',
      segment: 'SEGMENT 1 · Admin',
      title: 'Step 5 — Suspend Patient (Fatima Hadžić)',
      say: 'Suspending a patient is a soft delete — the record and her history survive, but she drops out of every default patient list immediately.',
      requires: 'Logged in as Admin (Step 1).',
      run: async ({ page, act }) => {
        await act('Open patient list', () => page.goto(`${BASE_URL}/dashboard/patients`))
        await act('Search for "fat"', () => page.getByPlaceholder('Search by name, phone or other').fill('fat'))
        await act('Open Fatima’s profile', async () => {
          await page.getByRole('row', { name: /Fatima/ }).click()
          await page.waitForURL('**/dashboard/patients/**')
        })
        await act('Click Suspend', () => page.getByRole('button', { name: 'Suspend' }).click())
        await act('Confirm suspension', async () => {
          const confirmDialog = page.getByRole('dialog').filter({ hasText: 'Suspend Patient' })
          await confirmDialog.getByRole('button', { name: 'Confirm' }).click()
          await page.waitForURL('**/dashboard/patients')
        })
      }
    },

    // ── DOCTOR instance ───────────────────────────────────────────────
    {
      id: 'login-doctor',
      instance: 'doctor',
      segment: 'SEGMENT 2 · Doctor',
      title: 'Step 6 — Login as Doctor',
      say: 'Doctors land on a different dashboard — they see their own visit schedule, not a system-wide user count.',
      run: async ({ page, act }) => act('Log in as Doctor', () => login(page, CREDS.doctor.email, CREDS.doctor.password))
    },
    {
      id: 'doctor-patient-list-no-fatima',
      instance: 'doctor',
      segment: 'SEGMENT 2 · Doctor',
      title: 'Step 7 — Patient List (Fatima no longer listed)',
      say: 'Fatima was suspended from the Admin side moments ago — the same list a doctor uses now returns nothing for her.',
      requires: 'Logged in as Doctor (Step 6).',
      run: async ({ page, act }) => {
        await act('Open patient list', () => page.goto(`${BASE_URL}/dashboard/patients`))
        await act('Search for "fat" — expect no rows', () => page.getByPlaceholder('Search by name, phone or other').fill('fat'))
      }
    },
    {
      id: 'doctor-add-new-patient',
      instance: 'doctor',
      segment: 'SEGMENT 2 · Doctor',
      title: 'Step 8 — Add New Patient',
      say: "Doctors can onboard patients directly, not just admins. Creating a patient here also creates their login account — this is the account we'll log into later as the Patient role.",
      requires: 'On the Patients list (Step 7).',
      run: async ({ page, act }) => {
        await act('Clear search', () => page.getByPlaceholder('Search by name, phone or other').fill(''))
        await act('Open Add New Patient dialog', () => page.getByRole('button', { name: 'Add New Patient' }).click())
        const dialog = page.getByRole('dialog')

        await act('Fill Full Name', () => dialog.getByLabel('Full Name').fill(NEW_PATIENT.fullName))
        await act('Fill Email', () => dialog.getByLabel('Email').fill(NEW_PATIENT.email))
        await act('Fill Password', () => dialog.getByLabel('Password', { exact: true }).fill(NEW_PATIENT.password))
        await act('Fill Confirm Password', () => dialog.getByLabel('Confirm Password').fill(NEW_PATIENT.password))

        await act('Fill First Name', () => dialog.getByLabel('First Name').fill(NEW_PATIENT.firstName))
        await act('Fill Last Name', () => dialog.getByLabel('Last Name').fill(NEW_PATIENT.lastName))
        await act('Fill Date of Birth', () => dialog.getByLabel('Date of Birth').fill(NEW_PATIENT.dateOfBirth))
        await act('Open Gender dropdown', async () => {
          await dialog.getByLabel('Gender').click()
          await page.getByRole('listbox').waitFor({ state: 'visible' })
        })
        await act('Select Male', () => page.getByRole('option', { name: 'Male', exact: true }).click())
        await act('Fill Phone', () => dialog.getByLabel('Phone').fill(NEW_PATIENT.phone))
        await act('Fill Emergency Contact Name', () => dialog.getByLabel('Emergency Contact Name').fill(NEW_PATIENT.emergencyContactName))
        await act('Fill Emergency Contact Phone', () => dialog.getByLabel('Emergency Contact Phone').fill(NEW_PATIENT.emergencyContactPhone))

        await act('Create patient', () => dialog.getByRole('button', { name: 'Create Patient' }).click())

        const testPatientUrl = await act('Open new patient’s profile', async () => {
          await page.getByPlaceholder('Search by name, phone or other').fill('Test Patient')
          await page.getByRole('row', { name: /Test Patient/ }).click()
          await page.waitForURL('**/dashboard/patients/**')
          return page.url()
        })
        return { testPatientUrl }
      }
    },
    {
      id: 'new-patient-visit-1',
      instance: 'doctor',
      segment: 'SEGMENT 3 · Doctor',
      title: 'Step 9 — Visit 1 (Intake — Obese, hypertensive)',
      say: 'Intake: BMI in the obese range and blood pressure above threshold — both auto-flagged the moment vitals are recorded.',
      requires: "Needs the new patient's profile open (Step 8).",
      run: async ({ page, state, act }) => {
        await act('Open patient profile', () => page.goto(requireUrl(state.testPatientUrl, "New patient's profile URL")))
        await act('Open Visits tab', () => page.getByRole('tab', { name: 'Visits' }).click())
        await addVisitWithVitals(
          page,
          act,
          '2026-04-06T09:00',
          'Intake visit. Referred for weight management and hypertension screening.',
          { weight: '90', height: '165', systolic: '148', diastolic: '95', heartRate: '88', temperature: '36.7' }
        )
      }
    },
    {
      id: 'new-patient-visit-2',
      instance: 'doctor',
      segment: 'SEGMENT 3 · Doctor',
      title: 'Step 10 — Visit 2 (4 weeks — trending down)',
      say: 'Four weeks in — weight and blood pressure both moving in the right direction, though still above normal range.',
      requires: "Needs the new patient's profile open (Step 8).",
      run: async ({ page, state, act }) => {
        await act('Open patient profile', () => page.goto(requireUrl(state.testPatientUrl, "New patient's profile URL")))
        await act('Open Visits tab', () => page.getByRole('tab', { name: 'Visits' }).click())
        await addVisitWithVitals(
          page,
          act,
          '2026-05-04T09:00',
          'Four-week follow-up. Adhering to dietary plan, moderate exercise introduced.',
          { weight: '82', height: '165', systolic: '138', diastolic: '89', heartRate: '82', temperature: '36.6' }
        )
      }
    },
    {
      id: 'new-patient-visit-3',
      instance: 'doctor',
      segment: 'SEGMENT 3 · Doctor',
      title: 'Step 11 — Visit 3 (8 weeks — overweight)',
      say: 'BMI has crossed out of the obese band into overweight — watch the badge on the patient card change accordingly.',
      requires: "Needs the new patient's profile open (Step 8).",
      run: async ({ page, state, act }) => {
        await act('Open patient profile', () => page.goto(requireUrl(state.testPatientUrl, "New patient's profile URL")))
        await act('Open Visits tab', () => page.getByRole('tab', { name: 'Visits' }).click())
        await addVisitWithVitals(
          page,
          act,
          '2026-06-01T09:00',
          'Eight-week follow-up. Continued weight loss, blood pressure nearing normal range.',
          { weight: '73', height: '165', systolic: '128', diastolic: '82', heartRate: '76', temperature: '36.6' }
        )
      }
    },
    {
      id: 'new-patient-visit-4',
      instance: 'doctor',
      segment: 'SEGMENT 3 · Doctor',
      title: 'Step 12 — Visit 4 (12 weeks — normal range)',
      say: 'All vitals now in normal range — the BMI badge disappears entirely, and the Weight & BMI Trend chart shows the full arc from intake to here.',
      requires: "Needs the new patient's profile open (Step 8).",
      run: async ({ page, state, act }) => {
        await act('Open patient profile', () => page.goto(requireUrl(state.testPatientUrl, "New patient's profile URL")))
        await act('Open Visits tab', () => page.getByRole('tab', { name: 'Visits' }).click())
        await addVisitWithVitals(
          page,
          act,
          '2026-06-29T09:00',
          'Twelve-week follow-up. Weight, blood pressure, and heart rate all within normal reference ranges. Transitioning to routine maintenance follow-ups.',
          { weight: '60', height: '165', systolic: '118', diastolic: '76', heartRate: '70', temperature: '36.6' }
        )
        await act('Open Vitals tab', () => page.getByRole('tab', { name: 'Vitals', exact: true }).click())
      }
    },
    {
      id: 'new-patient-diet-plan-generate-edit',
      instance: 'doctor',
      segment: 'SEGMENT 4 · Doctor',
      title: 'Step 13 — Generate & Edit AI Diet Plan',
      say: 'The AI proposes a plan from the recorded history — the clinician can then hand-edit any part of it before it ever reaches the patient.',
      requires: "Needs the new patient's profile open. Costs a real OpenAI call unless DRY_RUN=1.",
      run: async ({ page, state, act }) => {
        await act('Open patient profile', () => page.goto(requireUrl(state.testPatientUrl, "New patient's profile URL")))
        await act('Open Diet Plans tab', () => page.getByRole('tab', { name: 'Diet Plans' }).click())
        if (DRY_RUN) return

        await act('Generate diet plan', async () => {
          await page.getByRole('button', { name: 'Generate Diet Plan' }).click()
          await page
            .getByText(/kcal\/day/)
            .waitFor({ timeout: 60_000 })
            .catch(() => {})
        })
        await act('Open Edit Plan', () => page.getByRole('button', { name: 'Edit Plan' }).click())
        await act('Edit rationale', () =>
          page
            .getByLabel('Rationale')
            .fill('Adjusted by Dr. — reduced daily calories slightly given the patient’s now-normal BMI and activity level.')
        )
        await act('Save changes', () => page.getByRole('button', { name: 'Save Changes' }).click())
      }
    },
    {
      id: 'new-patient-diet-plan-send',
      instance: 'doctor',
      segment: 'SEGMENT 4 · Doctor',
      title: 'Step 14 — Send Diet Plan to Patient',
      say: 'Sending queues delivery to the patient — this is the moment the clinician-reviewed plan actually becomes visible on the patient side.',
      requires: "Needs the new patient's profile open, on the Diet Plans tab with a generated plan (Step 13). Skipped under DRY_RUN.",
      run: async ({ page, state, act }) => {
        await act('Open patient profile', () => page.goto(requireUrl(state.testPatientUrl, "New patient's profile URL")))
        await act('Open Diet Plans tab', () => page.getByRole('tab', { name: 'Diet Plans' }).click())
        if (DRY_RUN) return
        await act('Send to Patient', () => page.getByRole('button', { name: 'Send to Patient' }).click())
      }
    },
    {
      id: 'stefan-intake',
      instance: 'doctor',
      segment: 'SEGMENT 5 · Doctor',
      title: 'Stefan Jovanović — Intake Flags',
      say: 'Stefan is a 31-year-old student in an anorexia nervosa recovery programme — the opposite clinical picture. Every measurement flagged at intake.',
      requires: 'Logged in as Doctor (Step 6).',
      run: async ({ page, act }) => {
        await act('Open patient list', () => page.goto(`${BASE_URL}/dashboard/patients`))
        await act('Search for Stefan', () => page.getByPlaceholder('Search by name, phone or other').fill('Stefan'))
        const stefanUrl = await act('Open Stefan’s profile', async () => {
          await page.getByRole('row', { name: /Stefan/ }).click()
          await page.waitForURL('**/dashboard/patients/**')
          return page.url()
        })

        await act('Open Visits tab', () => page.getByRole('tab', { name: 'Visits' }).click())
        await act('Open oldest visit', () => page.getByRole('link', { name: 'View' }).last().click())
        return { stefanUrl }
      }
    },
    {
      id: 'stefan-recovery',
      instance: 'doctor',
      segment: 'SEGMENT 5 · Doctor',
      title: 'Stefan Most Recent Visit (recovery)',
      say: 'Seven visits, 14 weeks, 7.7 kg gained. The trend chart tells the full recovery story — including the relapse at week 8 when academic stress triggered restriction episodes.',
      requires: "Needs Stefan's profile open (run 'Stefan Jovanović — Intake Flags' first).",
      run: async ({ page, state, act }) => {
        await act('Open Stefan’s profile', () => page.goto(requireUrl(state.stefanUrl, "Stefan's profile URL")))
        await act('Open Visits tab', () => page.getByRole('tab', { name: 'Visits' }).click())
        await act('Open most recent visit', () => page.getByRole('link', { name: 'View' }).first().click())
      }
    },

    // ── PATIENT instance ──────────────────────────────────────────────
    {
      id: 'login-patient',
      instance: 'patient',
      segment: 'SEGMENT 6 · Patient',
      title: 'Login as Patient',
      say: "Logging in as the patient we just created moments ago in the Doctor segment — patients see exactly one record, their own. No dashboard, no user list.",
      run: async ({ page, act }) => act('Log in as Patient', () => login(page, NEW_PATIENT.email, NEW_PATIENT.password))
    },
    {
      id: 'patient-restricted',
      instance: 'patient',
      segment: 'SEGMENT 6 · Patient',
      title: 'Patient tries the Patients list — role enforcement',
      say: "They cannot navigate to any other patient's data. Role enforcement is not just a UI decision — the API returns 403 for any out-of-scope request, regardless of what the frontend shows.",
      requires: "Logged in as Patient ('Login as Patient' step).",
      run: async ({ page, act }) => {
        await act('Try open Patients list', async () => {
          await page.goto(`${BASE_URL}/dashboard/patients`)
          await page.waitForURL('**/dashboard/patients/**', { timeout: 10_000 }).catch(() => {})
        })
      }
    },
    {
      id: 'end-qa',
      instance: 'patient',
      segment: 'END',
      title: 'End — Hand off to Q&A',
      say: 'Questions?',
      run: async () => {}
    }
  ]
}

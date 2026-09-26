/** Onboarding/session regressions in the real packaged project renderer. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function skipNewProjectOnboarding(page, activityURL, temp) {
  const observations = [];
  const snapshot = async (stage) => {
    observations.push({ stage, ...await page.evaluate(() => ({
      completed: localStorage.getItem('stoneforge:onboarding-complete'),
      step: localStorage.getItem('stoneforge:onboarding-step'),
      backdrop: !!document.querySelector('[data-testid="onboarding-backdrop"]'),
    })) });
  };
  // Hold the real preset response until the page is rendered. This deterministically
  // exercises initially absent -> late active onboarding, without a timing sleep.
  let releasePreset;
  const presetGate = new Promise(resolve => { releasePreset = resolve; });
  const presetRoute = async route => { await presetGate; await route.continue(); };
  const presetPattern = '**/api/settings/workflow-preset';
  await page.route(presetPattern, presetRoute);
  try {
    const presetRequest = page.waitForRequest(request =>
      new URL(request.url()).pathname === '/api/settings/workflow-preset');
    await page.goto(activityURL);
    await presetRequest;
    await page.getByTestId('activity-page').waitFor();
    await snapshot('preset-pending');
    assert.equal(observations.at(-1).completed, null, 'Fresh project must not inherit tour completion');
    assert.equal(observations.at(-1).backdrop, false, 'Pending preset must exercise initially absent overlay');
    releasePreset();

    // A hidden-overlay check alone would pass before the delayed auto-start.
    // Require the actual tour, then use its normal user-facing dismissal action.
    await page.getByTestId('onboarding-skip').waitFor();
    await page.getByTestId('onboarding-backdrop').waitFor();
    await snapshot('active');
    await page.screenshot({ path: join(temp, 'onboarding-active.png') });
    await page.getByTestId('onboarding-skip').click();
    await page.waitForFunction(() =>
      localStorage.getItem('stoneforge:onboarding-complete') === 'true' &&
      localStorage.getItem('stoneforge:onboarding-step') === null);
    await page.getByTestId('onboarding-backdrop').waitFor({ state: 'detached' });
    await page.getByTestId('onboarding-tooltip').waitFor({ state: 'detached' });
    await snapshot('skipped');
    await page.screenshot({ path: join(temp, 'onboarding-skipped.png') });
    console.log('Packaged onboarding: initially absent, delayed active tour, real Skip, persisted completion: passed');
  } finally {
    releasePreset();
    await page.unroute(presetPattern, presetRoute);
    await writeFile(join(temp, 'onboarding-observations.json'), JSON.stringify(observations, null, 2));
  }
}

export async function checkDirectorStartFailure(page, state, temp) {
  assert.equal(await page.evaluate(() => localStorage.getItem('stoneforge:onboarding-complete')), 'true');
  await page.getByTestId('onboarding-backdrop').waitFor({ state: 'detached' });
  let requests = 0;
  const pattern = '**/api/agents/*/start';
  const rejectStart = async route => {
    assert.equal(route.request().method(), 'POST');
    requests++;
    await route.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'PTY launch failure fixture' } }) });
  };
  await page.route(pattern, rejectStart);
  try {
    const collapsed = page.getByTestId('director-panel-collapsed');
    await collapsed.or(page.getByTestId('director-panel')).waitFor();
    if (await collapsed.isVisible()) await page.locator('button[aria-label="Open director"]').click();
    await page.getByRole('button', { name: 'Start Session', exact: true }).first().click();
    await page.getByText('Could not start agent session', { exact: true }).waitFor();
    await page.getByText('PTY launch failure fixture', { exact: true }).waitFor();
    assert.equal(requests, 1, 'Real Start Session click must issue exactly one mocked launch');
    assert.equal(await page.getByTestId('onboarding-backdrop').count(), 0);
    await page.screenshot({ path: join(temp, `director-start-${state}.png`) });
    console.log(`Packaged director start failure is visible (${state} onboarding): passed`);
  } finally {
    await page.unroute(pattern, rejectStart);
  }
}

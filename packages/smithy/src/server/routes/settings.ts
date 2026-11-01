/**
 * Settings Routes
 *
 * Server-side settings API for workspace-wide configuration.
 * Provides endpoints for managing agent defaults (e.g., executable paths per provider).
 */

import { Hono } from 'hono';
import type { Services } from '../services.js';
import { SETTING_KEYS, type ServerAgentDefaults, type Setting } from '../../services/settings-service.js';
import {
  getValue,
  updateConfigFile,
  getConfigPath,
  reloadConfig,
  type WorkflowPreset,
  VALID_WORKFLOW_PRESETS,
} from '@stoneforge/quarry';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('settings-routes');

const ONBOARDING_TOUR_STATUSES = ['completed', 'dismissed'] as const;
type OnboardingTourStatus = (typeof ONBOARDING_TOUR_STATUSES)[number];

export interface OnboardingTourState {
  /** true once the tour was finished or dismissed in this workspace */
  completed: boolean;
  status: OnboardingTourStatus | null;
  updatedAt: string | null;
}

function readOnboardingTour(setting: Setting | undefined): OnboardingTourState {
  const status = (setting?.value as { status?: unknown } | undefined)?.status;
  if (!setting || !ONBOARDING_TOUR_STATUSES.includes(status as OnboardingTourStatus)) {
    return { completed: false, status: null, updatedAt: null };
  }
  return { completed: true, status: status as OnboardingTourStatus, updatedAt: setting.updatedAt };
}

export function createSettingsRoutes(services: Services) {
  const { settingsService } = services;
  const app = new Hono();

  // GET /api/settings/agent-defaults
  app.get('/api/settings/agent-defaults', (c) => {
    try {
      const defaults = settingsService.getAgentDefaults();
      return c.json(defaults);
    } catch (error) {
      logger.error('Failed to get agent defaults:', error);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, 500);
    }
  });

  // PUT /api/settings/agent-defaults
  app.put('/api/settings/agent-defaults', async (c) => {
    try {
      const body = (await c.req.json()) as ServerAgentDefaults;

      // Validate request body
      if (!body || typeof body !== 'object') {
        return c.json(
          { error: { code: 'INVALID_INPUT', message: 'Request body must be a JSON object' } },
          400
        );
      }

      if (body.defaultExecutablePaths !== undefined && typeof body.defaultExecutablePaths !== 'object') {
        return c.json(
          {
            error: {
              code: 'INVALID_INPUT',
              message: 'defaultExecutablePaths must be an object mapping provider names to executable paths',
            },
          },
          400
        );
      }

      // Validate that all values in defaultExecutablePaths are strings
      if (body.defaultExecutablePaths) {
        for (const [key, value] of Object.entries(body.defaultExecutablePaths)) {
          if (typeof value !== 'string') {
            return c.json(
              {
                error: {
                  code: 'INVALID_INPUT',
                  message: `defaultExecutablePaths.${key} must be a string, got ${typeof value}`,
                },
              },
              400
            );
          }
        }
      }

      // Validate fallbackChain if provided — must be an array
      if (body.fallbackChain !== undefined && !Array.isArray(body.fallbackChain)) {
        return c.json(
          {
            error: {
              code: 'INVALID_INPUT',
              message: 'fallbackChain must be an array of executable names/paths',
            },
          },
          400
        );
      }

      const defaults: ServerAgentDefaults = {
        defaultExecutablePaths: body.defaultExecutablePaths ?? {},
      };

      if (body.fallbackChain !== undefined) {
        defaults.fallbackChain = body.fallbackChain;
      }

      const updated = settingsService.setAgentDefaults(defaults);

      return c.json(updated);
    } catch (error) {
      logger.error('Failed to update agent defaults:', error);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, 500);
    }
  });

  // GET /api/settings/demo-mode
  app.get('/api/settings/demo-mode', (c) => {
    try {
      if (!services.demoModeService) {
        return c.json({ error: { code: 'NOT_AVAILABLE', message: 'Demo mode service not initialized' } }, 503);
      }
      const status = services.demoModeService.getStatus();
      return c.json(status);
    } catch (error) {
      logger.error('Failed to get demo mode status:', error);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, 500);
    }
  });

  // POST /api/settings/demo-mode/enable
  app.post('/api/settings/demo-mode/enable', async (c) => {
    try {
      if (!services.demoModeService) {
        return c.json({ error: { code: 'NOT_AVAILABLE', message: 'Demo mode service not initialized' } }, 503);
      }
      const result = await services.demoModeService.enable();
      return c.json(result);
    } catch (error) {
      logger.error('Failed to enable demo mode:', error);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, 500);
    }
  });

  // POST /api/settings/demo-mode/disable
  app.post('/api/settings/demo-mode/disable', async (c) => {
    try {
      if (!services.demoModeService) {
        return c.json({ error: { code: 'NOT_AVAILABLE', message: 'Demo mode service not initialized' } }, 503);
      }
      const result = await services.demoModeService.disable();
      return c.json(result);
    } catch (error) {
      logger.error('Failed to disable demo mode:', error);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, 500);
    }
  });

  // ==========================================================================
  // Onboarding Tour
  // ==========================================================================

  // Stored in this workspace's database, not browser storage: Desktop loads each
  // project from a backend on a dynamic port, so origin-scoped localStorage does
  // not survive a backend restart. One record per workspace keeps projects isolated.

  // GET /api/settings/onboarding-tour
  app.get('/api/settings/onboarding-tour', (c) => {
    try {
      return c.json(readOnboardingTour(settingsService.getSetting(SETTING_KEYS.ONBOARDING_TOUR)));
    } catch (error) {
      logger.error('Failed to get onboarding tour state:', error);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, 500);
    }
  });

  // PUT /api/settings/onboarding-tour — { status: 'completed' | 'dismissed' | null }
  app.put('/api/settings/onboarding-tour', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'Request body must be JSON' } }, 400);
    }
    const status = (body as { status?: unknown } | null)?.status;
    if (status !== null && !ONBOARDING_TOUR_STATUSES.includes(status as OnboardingTourStatus)) {
      return c.json(
        { error: { code: 'INVALID_INPUT', message: `status must be one of: ${ONBOARDING_TOUR_STATUSES.join(', ')}, or null` } },
        400
      );
    }
    try {
      // null is an explicit restart (Settings → Restart Onboarding Tour).
      if (status === null) {
        settingsService.deleteSetting(SETTING_KEYS.ONBOARDING_TOUR);
        return c.json(readOnboardingTour(undefined));
      }
      const setting = settingsService.setSetting(SETTING_KEYS.ONBOARDING_TOUR, { status });
      return c.json(readOnboardingTour(setting));
    } catch (error) {
      logger.error('Failed to update onboarding tour state:', error);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, 500);
    }
  });

  // ==========================================================================
  // Workflow Preset
  // ==========================================================================

  /**
   * Maps each workflow preset to its full configuration values.
   * Mirrors WORKFLOW_PRESET_CONFIGS from the init command.
   */
  const PRESET_CONFIGS: Record<WorkflowPreset, {
    merge: { autoMerge: boolean; targetBranch: string | null; requireApproval: boolean };
    workflow: { preset: WorkflowPreset };
    agents: { permissionModel: 'unrestricted' | 'restricted' };
  }> = {
    auto: {
      merge: { autoMerge: true, targetBranch: null, requireApproval: false },
      workflow: { preset: 'auto' },
      agents: { permissionModel: 'unrestricted' },
    },
    review: {
      merge: { autoMerge: true, targetBranch: 'stoneforge/review', requireApproval: false },
      workflow: { preset: 'review' },
      agents: { permissionModel: 'unrestricted' },
    },
    approve: {
      merge: { autoMerge: false, targetBranch: null, requireApproval: true },
      workflow: { preset: 'approve' },
      agents: { permissionModel: 'restricted' },
    },
  };

  // GET /api/settings/workflow-preset
  app.get('/api/settings/workflow-preset', (c) => {
    try {
      const preset = getValue('workflow.preset');
      return c.json({ preset: preset ?? null });
    } catch (error) {
      logger.error('Failed to get workflow preset:', error);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, 500);
    }
  });

  // PUT /api/settings/workflow-preset
  app.put('/api/settings/workflow-preset', async (c) => {
    try {
      const body = await c.req.json() as { preset: string };

      if (!body || typeof body.preset !== 'string') {
        return c.json(
          { error: { code: 'INVALID_INPUT', message: 'Request body must include a "preset" string' } },
          400
        );
      }

      if (!VALID_WORKFLOW_PRESETS.includes(body.preset as WorkflowPreset)) {
        return c.json(
          { error: { code: 'INVALID_INPUT', message: `Invalid preset "${body.preset}". Must be one of: ${VALID_WORKFLOW_PRESETS.join(', ')}` } },
          400
        );
      }

      const preset = body.preset as WorkflowPreset;
      const presetConfig = PRESET_CONFIGS[preset];
      const configPath = getConfigPath();

      if (!configPath) {
        return c.json(
          { error: { code: 'NOT_CONFIGURED', message: 'No config file found. Run "sf init" first.' } },
          400
        );
      }

      updateConfigFile(configPath, presetConfig);
      reloadConfig();

      return c.json({ preset, applied: presetConfig });
    } catch (error) {
      logger.error('Failed to update workflow preset:', error);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, 500);
    }
  });

  return app;
}

/**
 * useOnboardingTour - Manages onboarding tour state
 *
 * Controls whether the tour should be shown, tracks the current step,
 * and persists completion/skip state in the workspace so the tour only shows
 * once per workspace, across backend/app restarts (see onboardingTourPersistence).
 * Supports sectioned progress and cross-page navigation.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { TourStep } from '../components/onboarding';
import {
  STEP_STORAGE_KEY,
  createOnboardingTourStore,
  readLocalCompleted,
  type OnboardingTourStatus,
  type OnboardingTourStore,
} from './onboardingTourPersistence';

export interface TourSection {
  label: string;
  startIndex: number;
  count: number;
}

export interface OnboardingTourState {
  /** Whether the tour is currently active (visible) */
  isActive: boolean;
  /** Current step index (0-based, within active steps) */
  currentStep: number;
  /** Total number of active steps in the tour */
  totalSteps: number;
  /** Whether the tour has been completed or skipped previously */
  isCompleted: boolean;
  /**
   * Whether the persisted workspace state is known. Never auto-start before
   * this: the overlay must not flash for a user who already dismissed it.
   */
  isHydrated: boolean;
  /** Computed sections from step.section grouping */
  sections: TourSection[];
  /** Index of the current section (0-based) */
  currentSection: number;
  /** Total number of sections */
  totalSections: number;
  /** Start the tour */
  start: () => void;
  /** Advance to the next step */
  next: () => void;
  /** Go back to the previous step */
  prev: () => void;
  /** Skip/dismiss the tour (marks as completed) */
  skip: () => void;
  /** Complete the tour (marks as completed) */
  complete: () => void;
  /** Resume the tour from the persisted step (for browser refresh) */
  resume: () => void;
  /** Reset the tour (clears completion flag for re-access from settings) */
  reset: () => void;
  /** Jump to an arbitrary step index */
  goToStep: (index: number) => void;
  /** Skip to the first step of the next section */
  skipSection: () => void;
}

/**
 * Hook for managing the onboarding guided tour.
 *
 * @param steps - All defined tour steps (before filtering)
 * @returns Tour state and control functions
 */
export function useOnboardingTour(steps: TourStep[]): OnboardingTourState {
  const [isActive, setIsActive] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [isCompleted, setIsCompleted] = useState(() => {
    if (typeof window === 'undefined') return false;
    return readLocalCompleted(localStorage);
  });
  const [isHydrated, setIsHydrated] = useState(false);
  // Serialized workspace writes with a mutation version: user mutations
  // (finish, skip, restart) always win over a late hydration response and its
  // legacy migration (see createOnboardingTourStore).
  const store = useRef<OnboardingTourStore | null>(null);
  const getStore = useCallback(() => {
    store.current ??= createOnboardingTourStore(() => ({ fetch: window.fetch.bind(window), storage: localStorage }));
    return store.current;
  }, []);

  const persist = useCallback((status: OnboardingTourStatus | null) => {
    if (typeof window === 'undefined') return;
    getStore().save(status).catch(() => {});
  }, [getStore]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    getStore().hydrate().then((snapshot) => {
      if (cancelled) return;
      if (snapshot) setIsCompleted(snapshot.completed);
      setIsHydrated(true);
    });
    return () => { cancelled = true; };
  }, [getStore]);

  // Compute active steps (filter enabled !== false)
  const activeSteps = useMemo(
    () => steps.filter((s) => s.enabled !== false),
    [steps]
  );

  const totalSteps = activeSteps.length;

  // Compute sections from step.section grouping
  const sections = useMemo(() => {
    const result: TourSection[] = [];
    let currentLabel = '';
    for (let i = 0; i < activeSteps.length; i++) {
      const sectionLabel = activeSteps[i].section ?? '';
      if (sectionLabel !== currentLabel || i === 0) {
        result.push({ label: sectionLabel, startIndex: i, count: 1 });
        currentLabel = sectionLabel;
      } else {
        result[result.length - 1].count++;
      }
    }
    return result;
  }, [activeSteps]);

  // Determine current section index
  const currentSection = useMemo(() => {
    for (let i = sections.length - 1; i >= 0; i--) {
      if (currentStep >= sections[i].startIndex) {
        return i;
      }
    }
    return 0;
  }, [sections, currentStep]);

  const totalSections = sections.length;

  // Restore currentStep from localStorage on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isCompleted) {
      const savedStep = localStorage.getItem(STEP_STORAGE_KEY);
      if (savedStep !== null) {
        const parsed = parseInt(savedStep, 10);
        if (!isNaN(parsed) && parsed >= 0 && parsed < totalSteps) {
          setCurrentStep(parsed);
        }
      }
    }
  }, [totalSteps, isCompleted]);

  // Persist currentStep to localStorage whenever it changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isActive) {
      localStorage.setItem(STEP_STORAGE_KEY, String(currentStep));
    }
  }, [currentStep, isActive]);

  const markCompleted = useCallback((status: OnboardingTourStatus = 'completed') => {
    persist(status);
    localStorage.removeItem(STEP_STORAGE_KEY);
    setIsCompleted(true);
    setIsActive(false);
    setCurrentStep(0);
  }, [persist]);

  const start = useCallback(() => {
    setCurrentStep(0);
    setIsActive(true);
  }, []);

  const resume = useCallback(() => {
    // Resume from the persisted step (already restored from localStorage on mount)
    setIsActive(true);
  }, []);

  const next = useCallback(() => {
    setCurrentStep((prev) => {
      if (prev >= totalSteps - 1) {
        // Last step — complete the tour
        markCompleted();
        return 0;
      }
      return prev + 1;
    });
  }, [totalSteps, markCompleted]);

  const prev = useCallback(() => {
    setCurrentStep((prev) => Math.max(0, prev - 1));
  }, []);

  const skip = useCallback(() => {
    markCompleted('dismissed');
  }, [markCompleted]);

  const complete = useCallback(() => {
    markCompleted();
  }, [markCompleted]);

  const reset = useCallback(() => {
    persist(null);
    localStorage.removeItem(STEP_STORAGE_KEY);
    setIsCompleted(false);
    setCurrentStep(0);
  }, [persist]);

  const goToStep = useCallback(
    (index: number) => {
      if (index >= 0 && index < totalSteps) {
        setCurrentStep(index);
      }
    },
    [totalSteps]
  );

  const skipSection = useCallback(() => {
    // Find the next section and jump to its first step
    const nextSectionIdx = currentSection + 1;
    if (nextSectionIdx < sections.length) {
      setCurrentStep(sections[nextSectionIdx].startIndex);
    } else {
      // No more sections — complete the tour
      markCompleted();
    }
  }, [currentSection, sections, markCompleted]);

  // Listen for custom event to restart tour (from settings page)
  useEffect(() => {
    const handleRestart = () => {
      persist(null);
      localStorage.removeItem(STEP_STORAGE_KEY);
      setIsCompleted(false);
      setCurrentStep(0);
      setIsActive(true);
    };
    window.addEventListener('restart-onboarding-tour', handleRestart);
    return () => window.removeEventListener('restart-onboarding-tour', handleRestart);
  }, [persist]);

  return {
    isActive,
    currentStep,
    totalSteps,
    isCompleted,
    isHydrated,
    sections,
    currentSection,
    totalSections,
    start,
    resume,
    next,
    prev,
    skip,
    complete,
    reset,
    goToStep,
    skipSection,
  };
}

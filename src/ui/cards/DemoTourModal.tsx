/**
 * Demo mode: 6-step guided tour with spotlights.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Play, X, Zap } from 'lucide-react';
import { FOCUS_RING, GLASS_CARD, MOTION, OVERLAY_Z_MODAL } from '../design';
import { engine } from '../wiring';
import type { Route } from '@/contracts';

const STEPS = [
  {
    id: 'compare',
    target: '[data-tour="compare"]',
    title: 'Compare routes',
    body: 'Pick a destination, mode, and usual route. The card shows the best option with a green badge.',
  },
  {
    id: 'slider',
    target: '[data-tour="slider"]',
    title: 'Move the slider',
    body: 'Drag the departure slider to see how exposure changes later or earlier. The map colours update live.',
  },
  {
    id: 'photo',
    target: '[data-tour="photo"]',
    title: 'Add a haze photo',
    body: 'Tap the camera button, take a photo, pick open view or street canyon, place it on the map. Watch nearby segments update.',
  },
  {
    id: 'confidence',
    target: '[data-tour="confidence"]',
    title: 'Watch confidence change',
    body: 'The photo adds evidence. Nearby segments get a confidence badge and their colour shifts. The verdict may flip.',
  },
  {
    id: 'method',
    target: '[data-tour="method"]',
    title: 'Open Method & validation',
    body: 'Open the Scientific Breakdown. See the route table, segment details, sweep chart, assumptions, and validation panel.',
  },
  {
    id: 'school',
    target: '[data-tour="school"]',
    title: 'Open School window',
    body: 'Tap the graduation cap. Toggle outdoor/indoor to see the best low-exposure window for assembly or PE.',
  },
];

interface DemoTourModalProps {
  open: boolean;
  onClose: () => void;
  routes: Array<{ id: string; name: string }>;
}

export function DemoTourModal({ open, onClose, routes }: DemoTourModalProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [tourActive, setTourActive] = useState(false);
  const spotlightRef = useRef<HTMLDivElement | null>(null);

  const step = STEPS[stepIndex];

  useEffect(() => {
    if (!open) return;
    setStepIndex(0);
    setTourActive(false);
  }, [open]);

  const startTour = () => {
    setTourActive(true);
    setStepIndex(0);
  };

  const next = () => {
    if (stepIndex < STEPS.length - 1) setStepIndex((i) => i + 1);
  };

  const prev = () => {
    if (stepIndex > 0) setStepIndex((i) => i - 1);
  };

  const finish = () => {
    setTourActive(false);
    setStepIndex(0);
  };

  if (!open) return null;

  return (
    <div className={`${OVERLAY_Z_MODAL} fixed inset-0 flex items-center justify-center`}>
      {!tourActive && (
        <button
          type="button"
          onClick={startTour}
          className="relative z-[10] mx-auto my-auto rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          <Zap size={18} className="inline-block mr-2" aria-hidden />
          Start guided demo tour
        </button>
      )}

      {tourActive && step && (
        <>
          <div
            ref={spotlightRef}
            className="fixed inset-0 bg-slate-900/70 pointer-events-none"
            aria-hidden="true"
          />
          <div
            className={`${OVERLAY_Z_MODAL} fixed inset-0 flex items-center justify-center p-4 pointer-events-none`}
          >
            <div
              className="relative pointer-events-auto max-w-md w-full rounded-2xl bg-white p-4 border border-slate-200 dark:bg-slate-900 dark:border-slate-700"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                  <Zap size={16} className="text-emerald-600 dark:text-emerald-400" aria-hidden />
                  Demo tour: {step.title}
                </h2>
                <button
                  type="button"
                  onClick={finish}
                  aria-label="Exit tour"
                  className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <X size={14} aria-hidden />
                </button>
              </div>
              <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">{step.body}</p>
              <div className="mt-4 flex items-center justify-between">
                <button
                  type="button"
                  onClick={prev}
                  disabled={stepIndex === 0}
                  className={`${MOTION} rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100 dark:text-slate-200 dark:ring-slate-600 disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  <ChevronLeft size={14} aria-hidden /> Back
                </button>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Step {stepIndex + 1} of {STEPS.length}
                </span>
                {stepIndex === STEPS.length - 1 ? (
                  <button
                    type="button"
                    onClick={finish}
                    className={`${MOTION} rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500`}
                  >
                    Finish
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={next}
                    className={`${MOTION} rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500`}
                  >
                    Next <ChevronRight size={14} aria-hidden />
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
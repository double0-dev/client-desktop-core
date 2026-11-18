import { useEffect, useRef, type ComponentProps } from 'react';
import { getHoverScrollSettings } from '@renderer/lib/settings/hover-scroll-settings';
import { cn } from '@renderer/lib/utils';

/** How fast the text slides, in px per second - slow enough to read along. */
const SCROLL_SPEED = 40;
/** From hover to the first movement - just enough that a passing pointer
 *  sweeping down the list does not set every row off. */
const START_DELAY_MS = 150;
/** Rest at the start of each pass, before the text slides out again. */
const START_HOLD_MS = 600;
/** Rest at the end, so the last word can be read before it slides back. */
const END_HOLD_MS = 1200;

/** Hover root of `el`: the nearest `[data-hover-scroll-root]`, else itself. */
function hoverRoot(el: HTMLElement): HTMLElement {
  return el.closest<HTMLElement>('[data-hover-scroll-root]') ?? el;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** One pass: rest, slide out by `overflow` px, rest - played alternately. */
function scrollPass(overflow: number): { keyframes: Keyframe[]; duration: number } {
  const travel = (overflow / SCROLL_SPEED) * 1000;
  const duration = START_HOLD_MS + travel + END_HOLD_MS;
  const end = `translateX(${-overflow}px)`;
  return {
    duration,
    keyframes: [
      { transform: 'translateX(0)', offset: 0 },
      // Linear: an ease spread over a long slide crawls for its first second,
      // which reads as the hover not having started yet.
      { transform: 'translateX(0)', offset: START_HOLD_MS / duration },
      { transform: end, offset: (START_HOLD_MS + travel) / duration },
      { transform: end, offset: 1 },
    ],
  };
}

/**
 * Text that truncates with an ellipsis at rest and, while hovered, slides
 * sideways to show the part that did not fit - then back, for as long as the
 * pointer stays. Text that fits never moves.
 *
 * The hover that starts it is the nearest `[data-hover-scroll-root]` ancestor
 * (a whole list row), else the text itself. Overflow is measured when the
 * hover starts and again when the text changes under it (a live activity
 * line), never at rest. The timings are fixed, not a share of the pass: a
 * long name used to wait a share of its long pass before it moved at all.
 * `data-scrolling` lifts the ellipsis while it runs (globals.css); nothing
 * moves when Settings › General › "Scroll long names on hover" is off
 * (hover-scroll-settings.ts) or under reduced motion - the ellipsis and the
 * caller's `title` remain.
 */
export function HoverScrollText({ className, children, ...props }: ComponentProps<'span'>) {
  const ref = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const animRef = useRef<Animation | null>(null);
  const hoveredRef = useRef(false);

  // Starts, retunes or stops the slide for the text's current overflow.
  const syncRef = useRef<() => void>(() => {});
  syncRef.current = () => {
    const el = ref.current;
    const text = textRef.current;
    if (!el || !text) return;
    const overflow = hoveredRef.current ? el.scrollWidth - el.clientWidth : 0;
    if (
      overflow <= 1 ||
      !getHoverScrollSettings().enabled ||
      prefersReducedMotion() ||
      typeof text.animate !== 'function'
    ) {
      animRef.current?.cancel();
      animRef.current = null;
      delete el.dataset.scrolling;
      return;
    }
    const { keyframes, duration } = scrollPass(overflow);
    el.dataset.scrolling = '';
    const running = animRef.current;
    if (running) {
      // New text mid-hover (the activity line ticks every tool call): keep
      // the animation's clock so it carries on rather than starting over.
      (running.effect as KeyframeEffect | null)?.setKeyframes(keyframes);
      running.effect?.updateTiming({ duration });
      return;
    }
    animRef.current = text.animate(keyframes, {
      duration,
      // Skip into the start rest: the first move comes START_DELAY_MS in.
      delay: START_DELAY_MS - START_HOLD_MS,
      iterations: Infinity,
      direction: 'alternate',
    });
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = hoverRoot(el);
    const enter = (): void => {
      hoveredRef.current = true;
      syncRef.current();
    };
    const leave = (e: Event): void => {
      // Focus moving within the row is not leaving it.
      if (e.type === 'focusout' && root.contains((e as FocusEvent).relatedTarget as Node | null))
        return;
      if (e.type === 'focusout' && root.matches(':hover')) return;
      hoveredRef.current = false;
      syncRef.current();
    };
    root.addEventListener('pointerenter', enter);
    root.addEventListener('focusin', enter);
    root.addEventListener('pointerleave', leave);
    root.addEventListener('focusout', leave);
    return () => {
      root.removeEventListener('pointerenter', enter);
      root.removeEventListener('focusin', enter);
      root.removeEventListener('pointerleave', leave);
      root.removeEventListener('focusout', leave);
      animRef.current?.cancel();
      animRef.current = null;
    };
  }, []);

  // New text under a running hover: measure it again, or it slides by the
  // old text's distance (or not at all).
  useEffect(() => {
    if (hoveredRef.current) syncRef.current();
  }, [children]);

  return (
    <span ref={ref} data-hover-scroll className={cn('truncate', className)} {...props}>
      <span ref={textRef} data-hover-scroll-text>
        {children}
      </span>
    </span>
  );
}

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportRenderError } from '@renderer/lib/report-render-error';

/**
 * Keeps a render failure inside the part of the window that failed. Every
 * place core renders an extension's component goes through one: a throw
 * there used to reach the router's default error screen, which replaced the
 * WHOLE window - every session, terminal and the lock - because one status
 * bar item kept a reply of the wrong shape (2026-11-18).
 *
 * The fallback is nothing by default: the rest of the window keeps working
 * and the slot stays empty until it remounts (a `key` at the call site
 * resets it when the slot it shows changes). Only render throws are caught -
 * an event handler or a promise that throws never reaches a boundary, which
 * is why the bridges answer type-correct values while a feature is locked.
 */
export class SlotBoundary extends Component<
  {
    /** Which slot this is, for the log line. */
    name: string;
    /** What shows instead - given the caught error when it is a function; nothing by default. */
    fallback?: ReactNode | ((error: unknown) => ReactNode);
    children?: ReactNode;
  },
  { failed: boolean; error: unknown }
> {
  state: { failed: boolean; error: unknown } = { failed: false, error: null };

  static getDerivedStateFromError(error: unknown): { failed: boolean; error: unknown } {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportRenderError(error, this.props.name, info.componentStack ?? undefined);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { fallback } = this.props;
    return typeof fallback === 'function' ? fallback(this.state.error) : (fallback ?? null);
  }
}

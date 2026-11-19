import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import { SlotBoundary } from './slot-boundary';

/**
 * Where core renders an extension's component: a render throw there stays
 * there - the slot shows nothing (or its fallback), its siblings render on.
 */

const Throws = (): never => {
  throw new Error('gadget broke');
};

let quiet: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  quiet.mockRestore();
  resetRendererExtensionForTest();
});

describe('SlotBoundary', () => {
  it('renders nothing for a slot that throws and keeps its siblings', () => {
    render(
      <div>
        <SlotBoundary name="gadget">
          <Throws />
        </SlotBoundary>
        <span>sibling</span>
      </div>,
    );
    expect(screen.getByText('sibling')).toBeInTheDocument();
  });

  it('shows the fallback when it has one', () => {
    render(
      <SlotBoundary name="gadget" fallback={<p>fell back</p>}>
        <Throws />
      </SlotBoundary>,
    );
    expect(screen.getByText('fell back')).toBeInTheDocument();
  });

  it('hands the caught error to a fallback that asks for it', () => {
    // The error screen says "write to us with the message above" - it needs
    // the message.
    render(
      <SlotBoundary name="gadget" fallback={(error) => <p>{(error as Error).message}</p>}>
        <Throws />
      </SlotBoundary>,
    );
    expect(screen.getByText('gadget broke')).toBeInTheDocument();
  });

  it('logs the failure and hands it to the extension, naming the slot', () => {
    const reportError = vi.fn();
    installRendererExtension({ edition: 'pro', railTools: [], reportError });
    render(
      <SlotBoundary name="gadget">
        <Throws />
      </SlotBoundary>,
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'gadget broke' }),
      'gadget',
    );
    expect(quiet).toHaveBeenCalledWith(
      '[gadget] failed to render:',
      expect.any(Error),
      expect.anything(),
    );
  });

  it('survives a reporter that throws', () => {
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      reportError: () => {
        throw new Error('reporter broke');
      },
    });
    render(
      <div>
        <SlotBoundary name="gadget">
          <Throws />
        </SlotBoundary>
        <span>sibling</span>
      </div>,
    );
    expect(screen.getByText('sibling')).toBeInTheDocument();
  });

  it('renders its children when nothing throws', () => {
    render(
      <SlotBoundary name="gadget">
        <span>fine</span>
      </SlotBoundary>,
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
  });
});

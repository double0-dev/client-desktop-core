import { fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { resetSharedScroll, sharedScrollTop, useSharedScroll } from './shared-scroll';

// jsdom has no layout: give the containers a box so "visible" reads true.
function List({ id, listKey, active }: { id: string; listKey: string; active: boolean }) {
  const ref = useSharedScroll(listKey, active);
  return (
    <div
      ref={(node) => {
        if (node)
          Object.defineProperty(node, 'clientHeight', {
            configurable: true,
            value: active ? 200 : 0,
          });
        return ref(node);
      }}
      data-testid={id}
    />
  );
}

function scroll(el: HTMLElement, top: number): void {
  el.scrollTop = top;
  fireEvent.scroll(el);
}

afterEach(() => resetSharedScroll());

describe('useSharedScroll', () => {
  it('gives a session view that becomes visible the list offset the previous view left', () => {
    // Two mounted session views, each with its own copy of the Sessions list -
    // a click on a session swapped views and the list jumped to the other
    // copy's offset (the bug).
    const { getByTestId, rerender } = render(
      <>
        <List id="a" listKey="sessions:p1" active />
        <List id="b" listKey="sessions:p1" active={false} />
      </>,
    );
    scroll(getByTestId('a'), 340);
    expect(sharedScrollTop('sessions:p1')).toBe(340);

    rerender(
      <>
        <List id="a" listKey="sessions:p1" active={false} />
        <List id="b" listKey="sessions:p1" active />
      </>,
    );
    expect(getByTestId('b').scrollTop).toBe(340);
  });

  it('ignores scroll events from a hidden copy', () => {
    const { getByTestId } = render(
      <>
        <List id="a" listKey="projects" active />
        <List id="b" listKey="projects" active={false} />
      </>,
    );
    scroll(getByTestId('a'), 120);
    scroll(getByTestId('b'), 0);
    expect(sharedScrollTop('projects')).toBe(120);
  });

  it('restores a list that mounts while its view is visible (a panel reopened)', () => {
    const first = render(<List id="a" listKey="projects" active />);
    scroll(first.getByTestId('a'), 75);
    first.unmount();
    const { getByTestId } = render(<List id="c" listKey="projects" active />);
    expect(getByTestId('c').scrollTop).toBe(75);
  });

  it('keeps each project its own Sessions offset', () => {
    const { getByTestId, rerender } = render(<List id="a" listKey="sessions:p1" active />);
    scroll(getByTestId('a'), 90);
    rerender(<List id="a" listKey="sessions:p2" active />);
    scroll(getByTestId('a'), 10);
    expect(sharedScrollTop('sessions:p1')).toBe(90);
    expect(sharedScrollTop('sessions:p2')).toBe(10);
  });
});

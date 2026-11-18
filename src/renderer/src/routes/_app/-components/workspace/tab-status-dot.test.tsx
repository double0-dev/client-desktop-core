import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TabStatusDot } from '@renderer/routes/_app/-components/workspace/tab-status-dot';

/** The breathing animation (globals.css), as on the session and project dots. */
const LIVE = 'status-dot-live';

describe('TabStatusDot', () => {
  it('draws nothing for an idle or unknown terminal', () => {
    // A quiet shell tab must stay bare - a grey dot on every tab would be noise
    // the project rows deliberately avoid too.
    expect(render(<TabStatusDot state={null} />).container).toBeEmptyDOMElement();
    expect(render(<TabStatusDot state={undefined} />).container).toBeEmptyDOMElement();
  });

  it('breathes green while the terminal runs', () => {
    const { container } = render(<TabStatusDot state="running" />);
    expect(container.firstChild).toHaveClass('bg-success', LIVE, 'size-1.5', 'shrink-0');
  });

  it('breathes amber while the terminal waits on the user', () => {
    const { container } = render(<TabStatusDot state="needs-input" />);
    expect(container.firstChild).toHaveClass('bg-warning', LIVE);
  });

  it('holds a still blue dot once the work finished unseen', () => {
    // Finished asks for a glance, not an action - it must not pulse like the
    // two live states.
    const { container } = render(<TabStatusDot state="finished" />);
    expect(container.firstChild).toHaveClass('bg-info');
    expect(container.firstChild).not.toHaveClass(LIVE);
  });
});

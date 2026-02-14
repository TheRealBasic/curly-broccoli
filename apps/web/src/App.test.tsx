import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;

  addEventListener = vi.fn();
  send = vi.fn();
  close = vi.fn();
}

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  });

  it('renders basic chat interface', () => {
    render(<App />);
    expect(screen.getByText('Global room · anonymous chat')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });
});
